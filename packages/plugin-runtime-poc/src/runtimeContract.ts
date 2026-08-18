import { describe, expect, it } from "vite-plus/test";

import type { PluginDefinition, PluginRuntimeFactory, PluginRuntimeSnapshot } from "./contract.ts";

const contributionLabels = (snapshot: PluginRuntimeSnapshot, slot: string) =>
  snapshot.contributions[slot]?.map((item) => item.label) ?? [];

const provider = (version = "1.0.0"): PluginDefinition => ({
  id: "acme.database",
  version,
  provides: { "acme.database@1": { name: `database-${version}` } },
  activate(context) {
    context.register("status", { id: "database", label: `database ${version}` });
  },
});

const consumer = (): PluginDefinition => ({
  id: "acme.issues",
  version: "1.0.0",
  requires: ["acme.database@1"],
  activate(context) {
    const database = context.resolve<{ readonly name: string }>("acme.database@1");
    context.register("commands", { id: "create-issue", label: database.name });
  },
});

export function defineRuntimeContract(name: string, createRuntime: PluginRuntimeFactory) {
  describe(name, () => {
    it("activates providers before consumers regardless of manifest order", async () => {
      const runtime = createRuntime();

      const snapshot = await runtime.reconcile([consumer(), provider()]);

      expect(snapshot.active).toEqual(["acme.database", "acme.issues"]);
      expect(contributionLabels(snapshot, "commands")).toEqual(["database-1.0.0"]);
      await runtime.dispose();
    });

    it("blocks missing dependencies without blocking independent plugins", async () => {
      const runtime = createRuntime();
      const independent: PluginDefinition = {
        id: "acme.clock",
        version: "1.0.0",
        activate(context) {
          context.register("status", { id: "clock", label: "clock" });
        },
      };

      const snapshot = await runtime.reconcile([consumer(), independent]);

      expect(snapshot.active).toEqual(["acme.clock"]);
      expect(snapshot.blocked["acme.issues"]).toContain("acme.database@1");
      expect(contributionLabels(snapshot, "status")).toEqual(["clock"]);
      await runtime.dispose();
    });

    it("deactivates dependents before providers", async () => {
      const lifecycle: Array<string> = [];
      const runtime = createRuntime({
        onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
      });
      await runtime.reconcile([provider(), consumer()]);
      lifecycle.length = 0;

      await runtime.reconcile([]);

      expect(lifecycle).toEqual(["deactivate:acme.issues", "deactivate:acme.database"]);
      await runtime.dispose();
    });

    it("runs plugin finalizers in reverse registration order", async () => {
      const disposed: Array<string> = [];
      const runtime = createRuntime();
      await runtime.reconcile([
        {
          id: "acme.finalizers",
          version: "1.0.0",
          activate(context) {
            context.onDispose(() => {
              disposed.push("first");
            });
            context.onDispose(() => {
              disposed.push("second");
            });
          },
        },
      ]);

      await runtime.reconcile([]);

      expect(disposed).toEqual(["second", "first"]);
      await runtime.dispose();
    });

    it("keeps unchanged plugin scopes alive across reconciliation", async () => {
      let activations = 0;
      let disposals = 0;
      const stable: PluginDefinition = {
        id: "acme.stable",
        version: "1.0.0",
        activate(context) {
          activations += 1;
          context.onDispose(() => {
            disposals += 1;
          });
        },
      };
      const runtime = createRuntime();

      await runtime.reconcile([stable]);
      await runtime.reconcile([stable]);

      expect(activations).toBe(1);
      expect(disposals).toBe(0);
      await runtime.dispose();
      expect(disposals).toBe(1);
    });

    it("restarts a changed provider and its dependents without touching independent plugins", async () => {
      let independentActivations = 0;
      const lifecycle: Array<string> = [];
      const independent: PluginDefinition = {
        id: "acme.independent",
        version: "1.0.0",
        activate() {
          independentActivations += 1;
        },
      };
      const runtime = createRuntime({
        onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
      });
      await runtime.reconcile([consumer(), independent, provider()]);
      lifecycle.length = 0;

      const snapshot = await runtime.reconcile([consumer(), independent, provider("2.0.0")]);

      expect(independentActivations).toBe(1);
      expect(lifecycle).not.toContain("activate:acme.independent");
      expect(lifecycle).not.toContain("deactivate:acme.independent");
      expect(lifecycle.filter((event) => event.startsWith("activate:"))).toEqual([
        "activate:acme.database",
        "activate:acme.issues",
      ]);
      expect(lifecycle.filter((event) => event.startsWith("deactivate:"))).toEqual([
        "deactivate:acme.issues",
        "deactivate:acme.database",
      ]);
      expect(contributionLabels(snapshot, "commands")).toEqual(["database-2.0.0"]);
      await runtime.dispose();
    });

    it("returns deeply frozen snapshots", async () => {
      const runtime = createRuntime();

      const snapshot = await runtime.reconcile([provider()]);
      const status = snapshot.contributions.status;

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.active)).toBe(true);
      expect(Object.isFrozen(snapshot.blocked)).toBe(true);
      expect(Object.isFrozen(snapshot.contributions)).toBe(true);
      expect(Object.isFrozen(status)).toBe(true);
      expect(Object.isFrozen(status?.[0])).toBe(true);
      await runtime.dispose();
    });

    it("treats every plugin id and contribution slot as data", async () => {
      const runtime = createRuntime();
      const unusualProvider: PluginDefinition = {
        id: "toString",
        version: "1.0.0",
        provides: { "acme.unusual@1": "available" },
        activate(context) {
          context.register("__proto__", { id: "provider", label: "provider" });
        },
      };
      const unusualConsumer: PluginDefinition = {
        id: "constructor",
        version: "1.0.0",
        requires: ["acme.unusual@1"],
        activate(context) {
          context.resolve("acme.unusual@1");
          context.register("toString", { id: "consumer", label: "consumer" });
        },
      };
      const unusualBlocked: PluginDefinition = {
        id: "__proto__",
        version: "1.0.0",
        requires: ["acme.missing@1"],
        activate() {
          throw new Error("blocked plugin activated");
        },
      };

      const snapshot = await runtime.reconcile([unusualConsumer, unusualProvider, unusualBlocked]);

      expect(snapshot.active).toEqual(["toString", "constructor"]);
      expect(Object.hasOwn(snapshot.blocked, "__proto__")).toBe(true);
      expect(snapshot.blocked.__proto__).toContain("acme.missing@1");
      expect(Object.hasOwn(snapshot.contributions, "__proto__")).toBe(true);
      expect(Object.hasOwn(snapshot.contributions, "toString")).toBe(true);
      expect(contributionLabels(snapshot, "__proto__")).toEqual(["provider"]);
      expect(contributionLabels(snapshot, "toString")).toEqual(["consumer"]);
      await runtime.dispose();
    });

    it("restarts dependents when a provided value changes", async () => {
      const lifecycle: Array<string> = [];
      const runtime = createRuntime({
        onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
      });
      const serviceProvider = (name: string): PluginDefinition => ({
        id: "acme.service",
        version: "1.0.0",
        provides: { "acme.service@1": { name } },
        activate() {},
      });
      const serviceConsumer: PluginDefinition = {
        id: "acme.service-consumer",
        version: "1.0.0",
        requires: ["acme.service@1"],
        activate(context) {
          const service = context.resolve<{ readonly name: string }>("acme.service@1");
          context.register("commands", { id: "service", label: service.name });
        },
      };
      await runtime.reconcile([serviceProvider("first"), serviceConsumer]);
      lifecycle.length = 0;

      const snapshot = await runtime.reconcile([serviceProvider("second"), serviceConsumer]);

      expect(contributionLabels(snapshot, "commands")).toEqual(["second"]);
      expect(lifecycle.filter((event) => event.startsWith("activate:"))).toEqual([
        "activate:acme.service",
        "activate:acme.service-consumer",
      ]);
      await runtime.dispose();
    });

    it("does not report a failed candidate as activated", async () => {
      const lifecycle: Array<string> = [];
      const runtime = createRuntime({
        onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
      });
      const broken: PluginDefinition = {
        id: "acme.broken",
        version: "1.0.0",
        activate() {
          throw new Error("activation failed");
        },
      };

      await expect(runtime.reconcile([broken])).rejects.toThrow("activation failed");

      expect(lifecycle).toEqual([]);
      await runtime.dispose();
    });

    it("attempts every plugin cleanup when one finalizer fails", async () => {
      const disposed: Array<string> = [];
      const runtime = createRuntime();
      await runtime.reconcile([
        {
          id: "acme.first-cleanup",
          version: "1.0.0",
          activate(context) {
            context.onDispose(() => {
              disposed.push("first");
            });
          },
        },
        {
          id: "acme.second-cleanup",
          version: "1.0.0",
          activate(context) {
            context.onDispose(() => {
              disposed.push("second");
              throw new Error("cleanup failed");
            });
          },
        },
      ]);

      await expect(runtime.dispose()).rejects.toThrow();

      expect(disposed).toEqual(["second", "first"]);
    });

    it("keeps the old plugin active when a replacement fails", async () => {
      const runtime = createRuntime();
      await runtime.reconcile([provider()]);
      const broken: PluginDefinition = {
        ...provider("2.0.0"),
        async activate(context) {
          context.register("status", { id: "database", label: "database 2.0.0" });
          throw new Error("candidate failed");
        },
      };

      await expect(runtime.reconcile([broken])).rejects.toThrow("candidate failed");

      expect(runtime.snapshot().active).toEqual(["acme.database"]);
      expect(contributionLabels(runtime.snapshot(), "status")).toEqual(["database 1.0.0"]);
      await runtime.dispose();
    });

    it("rejects dependency cycles without disturbing the current composition", async () => {
      const runtime = createRuntime();
      await runtime.reconcile([provider()]);
      const alpha: PluginDefinition = {
        id: "acme.alpha",
        version: "1.0.0",
        requires: ["acme.beta@1"],
        provides: { "acme.alpha@1": true },
        activate() {},
      };
      const beta: PluginDefinition = {
        id: "acme.beta",
        version: "1.0.0",
        requires: ["acme.alpha@1"],
        provides: { "acme.beta@1": true },
        activate() {},
      };

      await expect(runtime.reconcile([alpha, beta])).rejects.toThrow("cycle");

      expect(runtime.snapshot().active).toEqual(["acme.database"]);
      await runtime.dispose();
    });
  });
}
