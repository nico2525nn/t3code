import { describe, expect, it } from "vite-plus/test";

import type { PluginDefinition } from "../src/contract.ts";
import { createPluginRuntime } from "../src/runtime.ts";
import { defineRuntimeContract } from "./runtimeContract.ts";

defineRuntimeContract("plugin runtime", createPluginRuntime);

describe("plugin runtime errors", () => {
  it("returns schema-tagged planning errors", async () => {
    const runtime = createPluginRuntime();
    const duplicate = {
      id: "acme.duplicate",
      version: "1.0.0",
      activate() {},
    };

    await expect(runtime.reconcile([duplicate, duplicate])).rejects.toMatchObject({
      _tag: "DuplicatePluginIdError",
      pluginId: "acme.duplicate",
    });
  });
});

describe("plugin runtime planner", () => {
  it("plans a deep acyclic dependency chain without using the call stack", async () => {
    const runtime = createPluginRuntime();
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

    const snapshot = await runtime.reconcile(definitions.toReversed());

    expect(snapshot.active).toHaveLength(pluginCount);
    await runtime.dispose();
  });
});
