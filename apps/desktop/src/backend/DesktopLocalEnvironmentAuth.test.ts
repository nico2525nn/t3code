import { assert, describe, it } from "@effect/vitest";
import { RemoteEnvironmentAuthInvalidJsonError } from "@t3tools/client-runtime/authorization";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopLocalEnvironmentAuth from "./DesktopLocalEnvironmentAuth.ts";

const config: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: {},
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "desktop-bootstrap-token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
  },
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
};

const managerLayer = Layer.succeed(DesktopBackendManager.DesktopBackendManager, {
  start: Effect.void,
  stop: () => Effect.void,
  currentConfig: Effect.succeed(Option.some(config)),
  snapshot: Effect.succeed({
    desiredRunning: true,
    ready: true,
    activePid: Option.none(),
    restartAttempt: 0,
    restartScheduled: false,
  }),
});

const testLayer = (httpClient: HttpClient.HttpClient) =>
  DesktopLocalEnvironmentAuth.layer.pipe(
    Layer.provide(Layer.mergeAll(managerLayer, Layer.succeed(HttpClient.HttpClient, httpClient))),
  );

describe("DesktopLocalEnvironmentAuth", () => {
  it.effect("exchanges the desktop bootstrap credential only once", () =>
    Effect.gen(function* () {
      const requestCount = yield* Ref.make(0);
      const layer = testLayer(
        HttpClient.make((request) =>
          Ref.update(requestCount, (count) => count + 1).pipe(
            Effect.as(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    access_token: "desktop-bearer-token",
                    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "orchestration:read",
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              ),
            ),
          ),
        ),
      );

      const [first, second] = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* Effect.all([auth.getBearerToken, auth.getBearerToken]);
      }).pipe(Effect.provide(layer));

      assert.strictEqual(first, "desktop-bearer-token");
      assert.strictEqual(second, "desktop-bearer-token");
      assert.strictEqual(yield* Ref.get(requestCount), 1);
    }),
  );

  it.effect("preserves the backend origin and bootstrap failure cause", () =>
    Effect.gen(function* () {
      const layer = testLayer(
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ unexpected: true }))),
        ),
      );

      const error = yield* Effect.gen(function* () {
        const auth = yield* DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuth;
        return yield* auth.getBearerToken;
      }).pipe(Effect.provide(layer), Effect.flip);

      assert.instanceOf(
        error,
        DesktopLocalEnvironmentAuth.DesktopLocalEnvironmentAuthSessionBootstrapError,
      );
      assert.strictEqual(error.backendOrigin, "http://127.0.0.1:3773");
      assert.strictEqual(
        error.message,
        "Failed to create the local desktop bearer session for http://127.0.0.1:3773.",
      );
      assert.instanceOf(error.cause, RemoteEnvironmentAuthInvalidJsonError);
    }),
  );
});
