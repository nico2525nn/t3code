import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";

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
});
