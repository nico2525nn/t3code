import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";

import type { PluginDefinition, PluginRuntimeOptions } from "../src/contract.ts";
import { layer, make, PluginRuntime } from "../src/runtime.ts";
import { defineRuntimeContract } from "./runtimeContract.ts";

const makeTestRuntime = (options: PluginRuntimeOptions = {}) => make(options);

defineRuntimeContract("plugin runtime", makeTestRuntime);

describe("plugin runtime errors", () => {
  it.effect("returns schema-tagged planning errors", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeTestRuntime();
        const duplicate = {
          id: "acme.duplicate",
          version: "1.0.0",
          activate() {},
        };

        const error = yield* Effect.flip(runtime.reconcile([duplicate, duplicate]));

        expect(error).toMatchObject({
          _tag: "DuplicatePluginIdError",
          pluginId: "acme.duplicate",
        });
        yield* runtime.dispose;
      }),
    ),
  );
});

describe("plugin runtime planner", () => {
  it.effect("plans a deep acyclic dependency chain without using the call stack", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const runtime = yield* makeTestRuntime();
        const pluginCount = 20_000;
        const definitions: Array<PluginDefinition> = Array.from(
          { length: pluginCount },
          (_, index) => ({
            id: `plugin-${index}`,
            version: "1.0.0",
            ...(index === 0 ? {} : { requires: [`capability-${index - 1}`] }),
            provides: { [`capability-${index}`]: index },
            activate() {},
          }),
        );

        const snapshot = yield* runtime.reconcile(definitions.toReversed());

        expect(snapshot.active).toHaveLength(pluginCount);
        yield* runtime.dispose;
      }),
    ),
  );
});

describe("plugin runtime layer", () => {
  it.effect("closes active plugin scopes when the layer is released", () =>
    Effect.gen(function* () {
      let disposed = false;
      const lifecycle: Array<string> = [];

      yield* PluginRuntime.use((runtime) =>
        runtime.reconcile([
          {
            id: "acme.layer-owned",
            version: "1.0.0",
            activate(context) {
              context.onDispose(() => {
                disposed = true;
              });
            },
          },
        ]),
      ).pipe(
        Effect.provide(
          layer({
            onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
          }),
        ),
      );

      expect(disposed).toBe(true);
      expect(lifecycle).toEqual(["activate:acme.layer-owned", "deactivate:acme.layer-owned"]);
    }),
  );

  it.effect("serializes layer release with an in-flight reconcile", () =>
    Effect.gen(function* () {
      let markActivationStarted!: () => void;
      const activationStarted = new Promise<void>((resolve) => {
        markActivationStarted = resolve;
      });
      let releaseActivation!: () => void;
      const activationGate = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const lifecycle: Array<string> = [];
      const runtimeScope = yield* Scope.make("sequential");
      const services = yield* Layer.buildWithScope(
        layer({
          onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
        }),
        runtimeScope,
      );
      const runtime = Context.get(services, PluginRuntime);
      const reconcileFiber = yield* Effect.forkChild(
        runtime.reconcile([
          {
            id: "acme.layer-release-race",
            version: "1.0.0",
            async activate() {
              markActivationStarted();
              await activationGate;
            },
          },
        ]),
      );
      yield* Effect.callback<void>((resume) => {
        void activationStarted.then(() => resume(Effect.void));
      });

      const layerRelease = yield* Effect.forkChild(Scope.close(runtimeScope, Exit.void));
      yield* Effect.yieldNow;
      expect(layerRelease.pollUnsafe()).toBeUndefined();

      releaseActivation();
      yield* Fiber.join(reconcileFiber);
      yield* Fiber.join(layerRelease);
      expect(lifecycle).toEqual([
        "activate:acme.layer-release-race",
        "deactivate:acme.layer-release-race",
      ]);
    }),
  );
});

describe("plugin runtime disposal", () => {
  it.effect("retries scope cleanup after an interrupted dispose", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let markStarted!: () => void;
        let releaseCleanup!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const cleanupGate = new Promise<void>((resolve) => {
          releaseCleanup = resolve;
        });
        const runtime = yield* makeTestRuntime();

        yield* runtime.reconcile([
          {
            id: "acme.interrupted-dispose",
            version: "1.0.0",
            activate(context) {
              context.onDispose(async () => {
                markStarted();
                await cleanupGate;
              });
            },
          },
        ]);

        const firstDispose = yield* Effect.forkChild(runtime.dispose);
        yield* Effect.callback<void>((resume) => {
          void started.then(() => resume(Effect.void));
        });
        const interruption = yield* Effect.forkChild(Fiber.interrupt(firstDispose));
        yield* Effect.yieldNow;

        const retry = yield* Effect.forkChild(runtime.dispose);
        yield* Effect.yieldNow;
        expect(retry.pollUnsafe()).toBeUndefined();

        releaseCleanup();
        yield* Fiber.join(interruption);
        yield* Fiber.join(retry);
        expect(yield* runtime.snapshot).toEqual({
          active: [],
          blocked: {},
          contributions: {},
        });
      }),
    ),
  );
});

describe("plugin runtime interruption", () => {
  it.effect("expires activation context when reconcile is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let markActivationStarted!: () => void;
        const activationStarted = new Promise<void>((resolve) => {
          markActivationStarted = resolve;
        });
        let interruptCompleted = false;
        let lateRegistrationSucceeded = false;
        let lateFailure: unknown;
        let finalizerRan = false;
        let releaseActivation!: () => void;
        const activationGate = new Promise<void>((resolve) => {
          releaseActivation = resolve;
        });
        const runtime = yield* makeTestRuntime();
        const reconcileFiber = yield* Effect.forkChild(
          runtime.reconcile([
            {
              id: "acme.interrupted-activation",
              version: "1.0.0",
              async activate(context) {
                markActivationStarted();
                await activationGate;
                try {
                  context.onDispose(() => {
                    finalizerRan = true;
                  });
                  lateRegistrationSucceeded = true;
                } catch (error) {
                  lateFailure = error;
                }
              },
            },
          ]),
        );
        yield* Effect.callback<void>((resume) => {
          void activationStarted.then(() => resume(Effect.void));
        });

        const interruption = yield* Effect.forkChild(
          Fiber.interrupt(reconcileFiber).pipe(
            Effect.ensuring(Effect.sync(() => (interruptCompleted = true))),
          ),
        );
        yield* Effect.yieldNow;
        expect(interruptCompleted).toBe(true);

        releaseActivation();
        yield* Fiber.join(interruption);
        yield* Effect.callback<void>((resume) => {
          queueMicrotask(() => resume(Effect.void));
        });
        yield* runtime.dispose;

        expect(lateRegistrationSucceeded).toBe(false);
        expect(lateFailure).toBeInstanceOf(Error);
        expect(finalizerRan).toBe(false);
      }),
    ),
  );
});
