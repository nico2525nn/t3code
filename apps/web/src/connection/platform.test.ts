import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";
import {
  AuthStandardClientScopes,
  DesktopSshPasswordPromptCancellationError,
  EnvironmentId,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { provisionDesktopSshEnvironment } from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

function makeBridge(
  calls: string[],
  options?: { readonly descriptorError?: unknown; readonly ensureError?: unknown },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (target: DesktopSshEnvironmentTarget) => {
      calls.push("ensure");
      if (options?.ensureError !== undefined) {
        throw options.ensureError;
      }
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: "pairing-token",
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.descriptorError !== undefined) {
        throw options.descriptorError;
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);

      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { descriptorError: new Error("descriptor unavailable") }),
        TARGET,
      ).pipe(Effect.flip);

      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("preserves SSH preparation causes without exposing their message", () =>
    Effect.gen(function* () {
      const cause = new Error("descriptor response contained a private endpoint");

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge([], { descriptorError: cause }),
        TARGET,
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.detail).toBe("Could not prepare the SSH environment.");
      expect(error.message).toBe("Connection attempt failed (remote-unavailable).");
      expect(error.message).not.toContain(cause.message);
      expect(error.cause).toBe(cause);
    }),
  );

  it.effect("classifies password prompt cancellation from its tag and preserves its cause", () =>
    Effect.gen(function* () {
      const promptCause = new Error("password prompt closed");
      const cancellation = new DesktopSshPasswordPromptCancellationError({
        reason: "window-closed",
        requestId: "prompt-1",
        destination: "developer@devbox.example.test",
        cause: promptCause,
      });

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge([], { ensureError: cancellation }),
        TARGET,
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionBlockedError);
      expect(error.detail).toBe(
        "SSH authentication did not complete for developer@devbox.example.test.",
      );
      expect(error.message).toBe("Connection attempt blocked (authentication).");
      expect(error.cause).toBe(cancellation);
      expect(cancellation.cause).toBe(promptCause);
    }),
  );

  it.effect("does not infer cancellation from an unstructured error message", () =>
    Effect.gen(function* () {
      const cause = new Error("remote operation was cancelled");

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge([], { ensureError: cause }),
        TARGET,
      ).pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.cause).toBe(cause);
    }),
  );
});
