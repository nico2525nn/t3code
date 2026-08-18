import * as Cordis from "cordis";

import type {
  Contribution,
  PluginDefinition,
  PluginRuntime,
  PluginRuntimeFactory,
  PluginRuntimeSnapshot,
} from "./contract.ts";

interface CordisFiber extends PromiseLike<void> {
  readonly dispose: () => Promise<void>;
}

interface CordisPlugin {
  (context: CordisContext): void | Promise<void>;
  inject?: Array<string>;
  provide?: string | Array<string>;
}

interface CordisContext {
  readonly effect: (
    execute: () => () => void | Promise<void>,
    label?: string,
  ) => () => Promise<void>;
  readonly get: (name: string) => unknown;
  readonly isolate: (name: string, label?: symbol) => CordisContext;
  readonly plugin: (plugin: CordisPlugin) => CordisFiber;
  readonly provide: (name: string, value?: unknown) => () => void;
}

// rc.8 ships extensionless re-exports in its declarations, which do not resolve
// under this repository's ESM settings. Keep the runtime import direct while
// describing only the public Cordis surface used by this adapter.
const Context = (Cordis as unknown as { Context: new () => CordisContext }).Context;

interface ActivePlugin {
  readonly definition: PluginDefinition;
  readonly fiber: CordisFiber;
  readonly contributions: ReadonlyMap<string, ReadonlyArray<Contribution>>;
  readonly providedLabels: ReadonlyMap<string, symbol>;
}

interface Composition {
  readonly plugins: ReadonlyArray<ActivePlugin>;
  snapshot: PluginRuntimeSnapshot;
}

const emptySnapshot = createSnapshot([], {}, new Map());

function createSnapshot(
  active: ReadonlyArray<string>,
  blocked: Readonly<Record<string, string>>,
  contributions: ReadonlyMap<string, ReadonlyArray<Contribution>>,
): PluginRuntimeSnapshot {
  const stableContributions: Record<string, ReadonlyArray<Contribution>> = {};
  for (const [slot, items] of contributions) {
    stableContributions[slot] = Object.freeze(
      items.map(({ id, label }) => Object.freeze({ id, label })),
    );
  }

  return Object.freeze({
    active: Object.freeze([...active]),
    blocked: Object.freeze({ ...blocked }),
    contributions: Object.freeze(stableContributions),
  });
}

function analyzeDefinitions(definitions: ReadonlyArray<PluginDefinition>) {
  const byId = new Map<string, PluginDefinition>();
  const indexById = new Map<string, number>();
  const providerByCapability = new Map<string, PluginDefinition>();

  definitions.forEach((definition, index) => {
    if (byId.has(definition.id)) {
      throw new Error(`duplicate plugin id: ${definition.id}`);
    }
    byId.set(definition.id, definition);
    indexById.set(definition.id, index);

    for (const capability of Object.keys(definition.provides ?? {})) {
      const previous = providerByCapability.get(capability);
      if (previous) {
        throw new Error(`duplicate capability ${capability}: ${previous.id}, ${definition.id}`);
      }
      providerByCapability.set(capability, definition);
    }
  });

  const dependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, Set<string>>();
  for (const definition of definitions) {
    const pluginDependencies = new Set<string>();
    dependencies.set(definition.id, pluginDependencies);
    for (const capability of definition.requires ?? []) {
      const provider = providerByCapability.get(capability);
      if (!provider) continue;
      pluginDependencies.add(provider.id);
      const providerDependents = dependents.get(provider.id) ?? new Set<string>();
      providerDependents.add(definition.id);
      dependents.set(provider.id, providerDependents);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const path: Array<string> = [];
  const visit = (pluginId: string) => {
    if (visiting.has(pluginId)) {
      const cycleStart = path.indexOf(pluginId);
      const cycle = [...path.slice(cycleStart), pluginId];
      throw new Error(`dependency cycle detected: ${cycle.join(" -> ")}`);
    }
    if (visited.has(pluginId)) return;

    visiting.add(pluginId);
    path.push(pluginId);
    for (const dependencyId of dependencies.get(pluginId) ?? []) {
      visit(dependencyId);
    }
    path.pop();
    visiting.delete(pluginId);
    visited.add(pluginId);
  };
  for (const definition of definitions) visit(definition.id);

  const blocked: Record<string, string> = {};
  for (const definition of definitions) {
    const missing = (definition.requires ?? []).filter(
      (capability) => !providerByCapability.has(capability),
    );
    if (missing.length) {
      blocked[definition.id] = `missing dependencies: ${missing.join(", ")}`;
    }
  }

  let foundBlockedDependency = true;
  while (foundBlockedDependency) {
    foundBlockedDependency = false;
    for (const definition of definitions) {
      if (blocked[definition.id]) continue;
      const unavailable = (definition.requires ?? []).find((capability) => {
        const provider = providerByCapability.get(capability);
        return provider && blocked[provider.id];
      });
      if (!unavailable) continue;
      blocked[definition.id] = `dependency is blocked: ${unavailable}`;
      foundBlockedDependency = true;
    }
  }

  const indegree = new Map(
    definitions.map((definition) => [definition.id, dependencies.get(definition.id)?.size ?? 0]),
  );
  const ready = definitions.filter((definition) => indegree.get(definition.id) === 0);
  const ordered: Array<PluginDefinition> = [];
  const insertReady = (definition: PluginDefinition) => {
    const index = ready.findIndex(
      (candidate) => indexById.get(candidate.id)! > indexById.get(definition.id)!,
    );
    ready.splice(index < 0 ? ready.length : index, 0, definition);
  };

  while (ready.length) {
    const definition = ready.shift()!;
    ordered.push(definition);
    for (const dependentId of dependents.get(definition.id) ?? []) {
      const nextIndegree = indegree.get(dependentId)! - 1;
      indegree.set(dependentId, nextIndegree);
      if (nextIndegree === 0) insertReady(byId.get(dependentId)!);
    }
  }

  return {
    blocked,
    ordered: ordered.filter((definition) => !blocked[definition.id]),
    providerByCapability,
  };
}

function sameStrings(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameDefinition(left: PluginDefinition, right: PluginDefinition) {
  return (
    left.id === right.id &&
    left.version === right.version &&
    sameStrings(left.requires ?? [], right.requires ?? []) &&
    sameStrings(Object.keys(left.provides ?? {}), Object.keys(right.provides ?? {}))
  );
}

function dependentsByPlugin(definitions: ReadonlyArray<PluginDefinition>) {
  const providerByCapability = new Map<string, string>();
  const dependents = new Map<string, Set<string>>();

  for (const definition of definitions) {
    for (const capability of Object.keys(definition.provides ?? {})) {
      providerByCapability.set(capability, definition.id);
    }
  }
  for (const definition of definitions) {
    for (const capability of definition.requires ?? []) {
      const providerId = providerByCapability.get(capability);
      if (!providerId) continue;
      const providerDependents = dependents.get(providerId) ?? new Set<string>();
      providerDependents.add(definition.id);
      dependents.set(providerId, providerDependents);
    }
  }

  return dependents;
}

function affectedPluginIds(
  current: ReadonlyArray<ActivePlugin>,
  desired: ReadonlyArray<PluginDefinition>,
) {
  const currentById = new Map(current.map((plugin) => [plugin.definition.id, plugin]));
  const desiredById = new Map(desired.map((definition) => [definition.id, definition]));
  const affected = new Set<string>();

  for (const plugin of current) {
    const next = desiredById.get(plugin.definition.id);
    if (!next || !sameDefinition(plugin.definition, next)) affected.add(plugin.definition.id);
  }
  for (const definition of desired) {
    const previous = currentById.get(definition.id);
    if (!previous || !sameDefinition(previous.definition, definition)) {
      affected.add(definition.id);
    }
  }

  const currentDependents = dependentsByPlugin(current.map(({ definition }) => definition));
  const desiredDependents = dependentsByPlugin(desired);
  const queue = [...affected];
  for (let index = 0; index < queue.length; index += 1) {
    const pluginId = queue[index];
    if (!pluginId) continue;
    for (const dependentId of [
      ...(currentDependents.get(pluginId) ?? []),
      ...(desiredDependents.get(pluginId) ?? []),
    ]) {
      if (affected.has(dependentId)) continue;
      affected.add(dependentId);
      queue.push(dependentId);
    }
  }

  return affected;
}

function snapshotOf(
  plugins: ReadonlyArray<ActivePlugin>,
  blocked: Readonly<Record<string, string>>,
) {
  const contributions = new Map<string, Array<Contribution>>();
  for (const plugin of plugins) {
    for (const [slot, registrations] of plugin.contributions) {
      const items = contributions.get(slot) ?? [];
      items.push(...registrations);
      contributions.set(slot, items);
    }
  }

  return createSnapshot(
    plugins.map(({ definition }) => definition.id),
    blocked,
    contributions,
  );
}

async function disposeComposition(
  composition: Composition,
  onDeactivate?: (pluginId: string) => void,
) {
  for (const plugin of composition.plugins.toReversed()) {
    onDeactivate?.(plugin.definition.id);
    await plugin.fiber.dispose();
  }
}

export const createCordisRuntime: PluginRuntimeFactory = (options = {}): PluginRuntime => {
  let composition: Composition = { plugins: [], snapshot: emptySnapshot };
  let context: CordisContext | undefined = new Context();
  let disposed = false;
  let queue = Promise.resolve();

  const runExclusive = <Result>(operation: () => Promise<Result>) => {
    const result = queue.then(operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const reconcile = (definitions: ReadonlyArray<PluginDefinition>) =>
    runExclusive(async () => {
      if (disposed) throw new Error("plugin runtime is disposed");

      // Validation and cycle detection happen before any candidate fibers are created,
      // so an invalid graph cannot touch the currently active composition.
      const { blocked, ordered, providerByCapability } = analyzeDefinitions(definitions);
      const affected = affectedPluginIds(composition.plugins, ordered);
      const currentById = new Map(
        composition.plugins.map((plugin) => [plugin.definition.id, plugin]),
      );
      const staged = new Map<string, ActivePlugin>();

      try {
        for (const definition of ordered) {
          if (!affected.has(definition.id)) continue;

          const providedLabels = new Map(
            Object.keys(definition.provides ?? {}).map((capability) => [
              capability,
              Symbol(`${definition.id}:${capability}`),
            ]),
          );
          let pluginContext = context;
          if (!pluginContext) throw new Error("plugin runtime is disposed");

          for (const capability of definition.requires ?? []) {
            const provider = providerByCapability.get(capability);
            const activeProvider = provider
              ? (staged.get(provider.id) ??
                (!affected.has(provider.id) ? currentById.get(provider.id) : undefined))
              : undefined;
            const label = activeProvider?.providedLabels.get(capability);
            if (!label) {
              throw new Error(`plugin ${definition.id} could not stage dependency ${capability}`);
            }
            pluginContext = pluginContext.isolate(capability, label);
          }
          for (const [capability, label] of providedLabels) {
            pluginContext = pluginContext.isolate(capability, label);
          }

          const contributions = new Map<string, Array<Contribution>>();

          const cordisPlugin: CordisPlugin = async (fiberContext) => {
            const finalizers: Array<() => void | Promise<void>> = [];
            fiberContext.effect(
              () => async () => {
                for (const finalizer of finalizers.toReversed()) await finalizer();
              },
              `${definition.id}:finalizers`,
            );

            for (const [capability, service] of Object.entries(definition.provides ?? {})) {
              fiberContext.provide(capability, service);
            }

            options.onLifecycle?.({ phase: "activate", pluginId: definition.id });
            await definition.activate({
              resolve: <Service>(capability: string) => fiberContext.get(capability) as Service,
              register(slot, contribution) {
                fiberContext.effect(() => {
                  const items = contributions.get(slot) ?? [];
                  items.push(contribution);
                  contributions.set(slot, items);
                  return () => {
                    const index = items.indexOf(contribution);
                    if (index >= 0) items.splice(index, 1);
                    if (!items.length) contributions.delete(slot);
                  };
                }, `${definition.id}:contribution:${slot}`);
              },
              onDispose(finalizer) {
                finalizers.push(finalizer);
              },
            });
          };
          cordisPlugin.inject = [...(definition.requires ?? [])];
          cordisPlugin.provide = Object.keys(definition.provides ?? {});
          Object.defineProperty(cordisPlugin, "name", { value: definition.id });

          const fiber = pluginContext.plugin(cordisPlugin);
          const plugin = { definition, fiber, contributions, providedLabels };
          try {
            await fiber;
          } catch (error) {
            await fiber.dispose();
            throw error;
          }
          staged.set(definition.id, plugin);
        }
      } catch (error) {
        await disposeComposition({ plugins: [...staged.values()], snapshot: emptySnapshot });
        throw error;
      }

      const plugins = ordered.map((definition) => {
        const plugin = staged.get(definition.id) ?? currentById.get(definition.id);
        if (!plugin) throw new Error(`plugin ${definition.id} was not staged`);
        return plugin;
      });
      const candidate = { plugins, snapshot: snapshotOf(plugins, blocked) };
      const previous = composition.plugins.filter((plugin) => !plugins.includes(plugin));
      composition = candidate;
      await disposeComposition({ plugins: previous, snapshot: emptySnapshot }, (pluginId) =>
        options.onLifecycle?.({ phase: "deactivate", pluginId }),
      );
      return candidate.snapshot;
    });

  return {
    reconcile,
    snapshot: () => composition.snapshot,
    dispose: () =>
      runExclusive(async () => {
        if (disposed) return;
        disposed = true;
        const previous = composition;
        composition = { plugins: [], snapshot: emptySnapshot };
        try {
          await disposeComposition(previous, (pluginId) =>
            options.onLifecycle?.({ phase: "deactivate", pluginId }),
          );
        } finally {
          context = undefined;
        }
      }),
  };
};
