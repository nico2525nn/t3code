import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { beforeEach } from "vite-plus/test";

import { OpenCode2Settings } from "@t3tools/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCode2Runtime,
  OpenCode2RuntimeError,
  type OpenCode2HttpResult,
  type OpenCode2RuntimeShape,
} from "../opencode2Runtime.ts";
import { checkOpenCode2ProviderStatus } from "./OpenCode2Provider.ts";
const decodeOpenCode2Settings = Schema.decodeSync(OpenCode2Settings);

const DEFAULT_VERSION_STDOUT = "0.0.0-beta-17728\n";

/**
 * Fake runtime doubles `connectToOpenCode2Server` and `request` so the probe
 * never spawns a real `opencode2 serve` child. The `request` double answers
 * the V2 endpoints the probe calls (health, model list, provider list, model
 * default) from a mutable fixture.
 */
const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    connectError: null as Error | null,
    closeCalls: 0,
    health: { healthy: true, version: "0.0.0-beta-17728", pid: 1234 },
    models: [] as unknown[],
    providers: [] as unknown[],
    defaultModel: null as Record<string, unknown> | null,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.connectError = null;
    this.state.closeCalls = 0;
    this.state.health = { healthy: true, version: "0.0.0-beta-17728", pid: 1234 };
    this.state.models = [];
    this.state.providers = [];
    this.state.defaultModel = null;
  },
};

const failWith = (detail: string) =>
  Effect.fail(
    new OpenCode2RuntimeError({
      operation: "test.double",
      detail,
      cause: new Error(detail),
    }),
  );

const OpenCode2RuntimeTestDouble: OpenCode2RuntimeShape = {
  startOpenCode2ServerProcess: () => failWith("unexpected startOpenCode2ServerProcess"),
  connectToOpenCode2Server: ({ serverUrl }) =>
    Effect.gen(function* () {
      if (!serverUrl) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls += 1;
          }),
        );
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4302",
        password: "test-password",
        external: Boolean(serverUrl),
        exitCode: null,
      };
    }),
  runOpenCode2Command: () =>
    runtimeMock.state.runVersionError
      ? failWith(runtimeMock.state.runVersionError.message)
      : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  request: ({ path }) => {
    switch (path) {
      case "/api/health":
        return Effect.succeed({
          status: 200,
          json: runtimeMock.state.health,
        } satisfies OpenCode2HttpResult);
      case "/api/model": {
        const data = runtimeMock.state.models;
        return Effect.succeed({ status: 200, json: { data } } satisfies OpenCode2HttpResult);
      }
      case "/api/provider": {
        const data = runtimeMock.state.providers;
        return Effect.succeed({ status: 200, json: { data } } satisfies OpenCode2HttpResult);
      }
      case "/api/model/default":
        return runtimeMock.state.defaultModel === null
          ? Effect.succeed({ status: 404, json: undefined } satisfies OpenCode2HttpResult)
          : Effect.succeed({
              status: 200,
              json: { data: runtimeMock.state.defaultModel },
            } satisfies OpenCode2HttpResult);
      default:
        return failWith(`unexpected request path: ${path}`);
    }
  },
  streamOpenCode2Events: () => failWith("unexpected streamOpenCode2Events"),
};

beforeEach(() => {
  runtimeMock.reset();
});

const testLayer = Layer.succeed(OpenCode2Runtime, OpenCode2RuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const makeOpenCode2Settings = (overrides?: Partial<OpenCode2Settings>): OpenCode2Settings =>
  decodeOpenCode2Settings({
    enabled: true,
    binaryPath: "opencode2",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

function seedCommonCatalog() {
  runtimeMock.state.providers = [{ id: "opencode-go", name: "OpenCode Go" }];
  runtimeMock.state.models = [
    {
      id: "glm-5.3",
      modelID: "glm-5.3",
      providerID: "opencode-go",
      name: "GLM-5.3",
      variants: [{ id: "low" }, { id: "max" }],
    },
  ];
  runtimeMock.state.defaultModel = {
    id: "glm-5.3",
    modelID: "glm-5.3",
    providerID: "opencode-go",
  };
}

it.layer(testLayer)("checkOpenCode2ProviderStatus", (it) => {
  it.effect("reports disabled settings without probing", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenCode2ProviderStatus(
        makeOpenCode2Settings({ enabled: false }),
        process.cwd(),
      );
      NodeAssert.equal(snapshot.enabled, false);
      NodeAssert.equal(snapshot.status, "disabled");
      NodeAssert.equal(snapshot.installed, false);
    }),
  );

  it.effect("reports a missing binary as not installed", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode2 ENOENT");
      const snapshot = yield* checkOpenCode2ProviderStatus(makeOpenCode2Settings(), process.cwd());
      NodeAssert.equal(snapshot.installed, false);
      NodeAssert.equal(snapshot.status, "warning");
      NodeAssert.equal(
        snapshot.message,
        "OpenCode 2 CLI (`opencode2`) is not installed or not on PATH.",
      );
    }),
  );

  it.effect("builds a ready snapshot from the V2 catalog", () =>
    Effect.gen(function* () {
      seedCommonCatalog();
      const snapshot = yield* checkOpenCode2ProviderStatus(makeOpenCode2Settings(), process.cwd());

      NodeAssert.equal(snapshot.installed, true);
      NodeAssert.equal(snapshot.status, "ready");
      NodeAssert.equal(snapshot.version, "0.0.0-beta-17728");
      NodeAssert.equal(snapshot.auth.status, "authenticated");

      const model = snapshot.models.find((entry) => entry.slug === "opencode-go/glm-5.3");
      NodeAssert.ok(model);
      NodeAssert.equal(model.name, "GLM-5.3");
      NodeAssert.equal(model.subProvider, "OpenCode Go");
      NodeAssert.equal(model.isDefault, true);

      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      NodeAssert.ok(variantDescriptor);
      NodeAssert.equal(
        (variantDescriptor as { readonly options?: ReadonlyArray<unknown> }).options?.length,
        2,
      );
    }),
  );

  it.effect("cleans up the managed server after the probe", () =>
    Effect.gen(function* () {
      seedCommonCatalog();
      yield* checkOpenCode2ProviderStatus(makeOpenCode2Settings(), process.cwd());
      NodeAssert.ok(runtimeMock.state.closeCalls >= 1);
    }),
  );

  it.effect("surfaces a probe failure as an error snapshot", () =>
    Effect.gen(function* () {
      runtimeMock.state.health = { healthy: false, version: "x", pid: 1 };
      const snapshot = yield* checkOpenCode2ProviderStatus(makeOpenCode2Settings(), process.cwd());
      NodeAssert.equal(snapshot.status, "error");
      NodeAssert.equal(snapshot.installed, true);
    }),
  );

  it.effect("uses the configured external server without spawning", () =>
    Effect.gen(function* () {
      seedCommonCatalog();
      const before = runtimeMock.state.closeCalls;
      const snapshot = yield* checkOpenCode2ProviderStatus(
        makeOpenCode2Settings({
          serverUrl: "http://127.0.0.1:4096",
          serverPassword: "pw",
        }),
        process.cwd(),
      );
      // External connections are not scoped-owned, so no finalizer ran.
      NodeAssert.equal(runtimeMock.state.closeCalls, before);
      NodeAssert.equal(snapshot.status, "ready");
    }),
  );
});
