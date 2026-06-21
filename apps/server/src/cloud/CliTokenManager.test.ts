import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliTokenManager from "./CliTokenManager.ts";

const unusedSecretStoreOperation = () => Effect.die("unused secret-store operation");

function makeSecretStore(
  overrides: Partial<ServerSecretStore.ServerSecretStore["Service"]>,
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create: unusedSecretStoreOperation,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: unusedSecretStoreOperation,
    ...overrides,
  };
}

function makeTokenManager(secretStore: ServerSecretStore.ServerSecretStore["Service"]) {
  return CliTokenManager.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("unused HTTP client")),
        ),
      ),
    ),
  );
}

describe("CloudCliTokenManager", () => {
  it("redacts OAuth endpoint credentials while retaining exact causes", () => {
    const tokenEndpoint =
      "https://user:password@auth.example.test/private/token?client_secret=secret#fragment";
    const redirectUri =
      "https://callback-user:callback-password@localhost/private/callback?code=secret#fragment";
    const cause = new Error("exchange failed");

    const refreshError = CliTokenManager.CloudCliCredentialRefreshError.fromStage({
      stage: "exchange-token",
      tokenEndpoint,
      cause,
    });
    const authorizationError = CliTokenManager.CloudCliAuthorizationError.fromStage({
      stage: "exchange-token",
      tokenEndpoint,
      redirectUri,
      cause,
    });
    const timeoutError = CliTokenManager.CloudCliAuthorizationTimeoutError.fromRedirectUri({
      redirectUri,
      timeoutMillis: 1000,
      cause,
    });

    expect(refreshError).toMatchObject({
      tokenEndpointInputLength: tokenEndpoint.length,
      tokenEndpointProtocol: "https:",
      tokenEndpointHostname: "auth.example.test",
      cause,
    });
    expect(authorizationError).toMatchObject({
      tokenEndpointInputLength: tokenEndpoint.length,
      tokenEndpointHostname: "auth.example.test",
      redirectUriInputLength: redirectUri.length,
      redirectUriHostname: "localhost",
      cause,
    });
    expect(timeoutError).toMatchObject({
      redirectUriInputLength: redirectUri.length,
      redirectUriHostname: "localhost",
      cause,
    });
    expect(refreshError.cause).toBe(cause);
    expect(authorizationError.cause).toBe(cause);
    expect(timeoutError.cause).toBe(cause);
    for (const error of [refreshError, authorizationError, timeoutError]) {
      expect(error).not.toHaveProperty("tokenEndpoint");
      expect(error).not.toHaveProperty("redirectUri");
      const serialized = JSON.stringify(error);
      for (const secret of [
        "user:password",
        "callback-user:callback-password",
        "/private/",
        "client_secret=secret",
        "code=secret",
        "#fragment",
      ]) {
        expect(error.message).not.toContain(secret);
        expect(serialized).not.toContain(secret);
      }
    }
  });

  it.effect("retains secret context and cause when credential removal fails", () => {
    const failure = new ServerSecretStore.SecretStoreRemoveError({
      secretName: "cloud-cli-oauth-token",
      secretPath: "/tmp/secrets/cloud-cli-oauth-token.bin",
      cause: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "remove",
        pathOrDescriptor: "/tmp/secrets/cloud-cli-oauth-token.bin",
      }),
    });

    return Effect.gen(function* () {
      const tokens = yield* makeTokenManager(
        makeSecretStore({ remove: () => Effect.fail(failure) }),
      );
      const error = yield* Effect.flip(tokens.clear);

      expect(error).toMatchObject({
        _tag: "CloudCliCredentialRemovalError",
        secretName: "cloud-cli-oauth-token",
        cause: failure,
      });
      expect(error.message).toBe(
        "Could not remove the stored T3 Connect CLI credential cloud-cli-oauth-token.",
      );
    });
  });

  it.effect("classifies credential read failures without replacing the cause", () => {
    const failure = new ServerSecretStore.SecretStoreReadError({
      secretName: "cloud-cli-oauth-token",
      secretPath: "/tmp/secrets/cloud-cli-oauth-token.bin",
      cause: PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFile",
        pathOrDescriptor: "/tmp/secrets/cloud-cli-oauth-token.bin",
      }),
    });

    return Effect.gen(function* () {
      const tokens = yield* makeTokenManager(makeSecretStore({ get: () => Effect.fail(failure) }));
      const error = yield* Effect.flip(tokens.hasCredential);

      expect(error).toMatchObject({
        _tag: "CloudCliCredentialReadError",
        stage: "read-credential",
        secretName: "cloud-cli-oauth-token",
        cause: failure,
      });
      expect(error.message).toBe(
        "Could not inspect the stored T3 Connect CLI credential cloud-cli-oauth-token during read-credential.",
      );
    });
  });

  it.effect("classifies malformed persisted credentials as refresh decode failures", () =>
    Effect.gen(function* () {
      const tokens = yield* makeTokenManager(
        makeSecretStore({
          get: () =>
            Effect.succeed(Option.some(new TextEncoder().encode("not valid credential JSON"))),
        }),
      );
      const error = yield* Effect.flip(tokens.getExisting);

      expect(error).toMatchObject({
        _tag: "CloudCliCredentialRefreshError",
        stage: "decode-credential",
        secretName: "cloud-cli-oauth-token",
        cause: { _tag: "SchemaError" },
      });
      expect(error.message).toBe(
        "Could not refresh the T3 Connect CLI credential cloud-cli-oauth-token during decode-credential.",
      );
    }),
  );
});
