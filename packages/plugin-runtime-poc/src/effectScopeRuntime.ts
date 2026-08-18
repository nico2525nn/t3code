import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import type {
  Contribution,
  PluginActivationContext,
  PluginDefinition,
  PluginRuntime,
  PluginRuntimeFactory,
  PluginRuntimeSnapshot,
} from "./contract.ts";

interface PlannedComposition {
  readonly blocked: Readonly<Record<string, string>>;
  readonly definitions: ReadonlyArray<PluginDefinition>;
}

interface LivePlugin {
  readonly definition: PluginDefinition;
  readonly scope: Scope.Closeable;
  readonly contributions: ReadonlyMap<string, ReadonlyArray<Contribution>>;
}

interface LiveComposition {
  readonly plugins: ReadonlyArray<LivePlugin>;
  readonly snapshot: PluginRuntimeSnapshot;
}

const emptySnapshot = (): PluginRuntimeSnapshot =>
  Object.freeze({
    active: Object.freeze([]),
    blocked: Object.freeze({}),
    contributions: Object.freeze({}),
  });

const planComposition = (definitions: ReadonlyArray<PluginDefinition>): PlannedComposition => {
  const definitionsById = new Map<string, PluginDefinition>();
  const providersByCapability = new Map<string, PluginDefinition>();

  for (const definition of definitions) {
    if (definitionsById.has(definition.id)) {
      throw new Error(`Duplicate plugin id: ${definition.id}`);
    }
    definitionsById.set(definition.id, definition);

    for (const capability of Object.keys(definition.provides ?? {})) {
      const previous = providersByCapability.get(capability);
      if (previous !== undefined) {
        throw new Error(
          `Duplicate capability ${capability} provided by ${previous.id} and ${definition.id}`,
        );
      }
      providersByCapability.set(capability, definition);
    }
  }

  const visitState = new Map<string, "visiting" | "visited">();
  const stack: Array<string> = [];
  const detectCycle = (definition: PluginDefinition): void => {
    const state = visitState.get(definition.id);
    if (state === "visited") return;
    if (state === "visiting") {
      const cycleStart = stack.indexOf(definition.id);
      const cycle = [...stack.slice(cycleStart), definition.id];
      throw new Error(`Dependency cycle: ${cycle.join(" -> ")}`);
    }

    visitState.set(definition.id, "visiting");
    stack.push(definition.id);
    for (const capability of definition.requires ?? []) {
      const provider = providersByCapability.get(capability);
      if (provider !== undefined) detectCycle(provider);
    }
    stack.pop();
    visitState.set(definition.id, "visited");
  };

  for (const definition of definitions) detectCycle(definition);

  const blocked = new Map<string, string | undefined>();
  const blockedReason = (definition: PluginDefinition): string | undefined => {
    if (blocked.has(definition.id)) return blocked.get(definition.id);

    for (const capability of definition.requires ?? []) {
      const provider = providersByCapability.get(capability);
      if (provider === undefined) {
        const reason = `Missing dependency: ${capability}`;
        blocked.set(definition.id, reason);
        return reason;
      }

      const providerReason = blockedReason(provider);
      if (providerReason !== undefined) {
        const reason = `Dependency ${capability} is blocked: ${providerReason}`;
        blocked.set(definition.id, reason);
        return reason;
      }
    }

    blocked.set(definition.id, undefined);
    return undefined;
  };

  for (const definition of definitions) blockedReason(definition);

  const ordered: Array<PluginDefinition> = [];
  const orderedIds = new Set<string>();
  const addInDependencyOrder = (definition: PluginDefinition): void => {
    if (orderedIds.has(definition.id) || blocked.get(definition.id) !== undefined) return;

    for (const capability of definition.requires ?? []) {
      const provider = providersByCapability.get(capability);
      if (provider !== undefined) addInDependencyOrder(provider);
    }

    orderedIds.add(definition.id);
    ordered.push(definition);
  };

  for (const definition of definitions) addInDependencyOrder(definition);

  const blockedRecord: Record<string, string> = {};
  for (const definition of definitions) {
    const reason = blocked.get(definition.id);
    if (reason !== undefined) blockedRecord[definition.id] = reason;
  }

  return { blocked: blockedRecord, definitions: ordered };
};

const sameStrings = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const sameDefinition = (left: PluginDefinition, right: PluginDefinition): boolean => {
  if (left.id !== right.id || left.version !== right.version) return false;
  if (!sameStrings(left.requires ?? [], right.requires ?? [])) return false;

  const leftProvides = Object.entries(left.provides ?? {});
  const rightProvides = Object.entries(right.provides ?? {});
  return (
    leftProvides.length === rightProvides.length &&
    leftProvides.every(
      ([capability, service], index) =>
        rightProvides[index]?.[0] === capability && Object.is(rightProvides[index]?.[1], service),
    )
  );
};

const dependentsByPlugin = (definitions: ReadonlyArray<PluginDefinition>) => {
  const providers = new Map<string, string>();
  const dependents = new Map<string, Set<string>>();
  for (const definition of definitions) {
    for (const capability of Object.keys(definition.provides ?? {})) {
      providers.set(capability, definition.id);
    }
  }
  for (const definition of definitions) {
    for (const capability of definition.requires ?? []) {
      const providerId = providers.get(capability);
      if (providerId === undefined) continue;
      const values = dependents.get(providerId) ?? new Set<string>();
      values.add(definition.id);
      dependents.set(providerId, values);
    }
  }
  return dependents;
};

const affectedPluginIds = (
  current: ReadonlyArray<LivePlugin>,
  desired: ReadonlyArray<PluginDefinition>,
): ReadonlySet<string> => {
  const currentById = new Map(current.map((plugin) => [plugin.definition.id, plugin]));
  const desiredById = new Map(desired.map((definition) => [definition.id, definition]));
  const affected = new Set<string>();

  for (const plugin of current) {
    const next = desiredById.get(plugin.definition.id);
    if (next === undefined || !sameDefinition(plugin.definition, next)) {
      affected.add(plugin.definition.id);
    }
  }
  for (const definition of desired) {
    const previous = currentById.get(definition.id);
    if (previous === undefined || !sameDefinition(previous.definition, definition)) {
      affected.add(definition.id);
    }
  }

  const currentDependents = dependentsByPlugin(current.map((plugin) => plugin.definition));
  const desiredDependents = dependentsByPlugin(desired);
  const queue = [...affected];
  for (let index = 0; index < queue.length; index += 1) {
    const pluginId = queue[index];
    if (pluginId === undefined) continue;
    for (const dependent of [
      ...(currentDependents.get(pluginId) ?? []),
      ...(desiredDependents.get(pluginId) ?? []),
    ]) {
      if (affected.has(dependent)) continue;
      affected.add(dependent);
      queue.push(dependent);
    }
  }

  return affected;
};

const closePlugins = async (plugins: ReadonlyArray<LivePlugin>): Promise<void> => {
  for (const plugin of plugins.toReversed()) {
    await Effect.runPromise(Scope.close(plugin.scope, Exit.void));
  }
};

const snapshotOf = (
  plugins: ReadonlyArray<LivePlugin>,
  blocked: Readonly<Record<string, string>>,
): PluginRuntimeSnapshot => {
  const contributions: Record<string, ReadonlyArray<Contribution>> = {};
  for (const plugin of plugins) {
    for (const [slot, registrations] of plugin.contributions) {
      const values = contributions[slot] ?? [];
      contributions[slot] = Object.freeze([
        ...values,
        ...registrations.map((registration) =>
          Object.freeze({ id: registration.id, label: registration.label }),
        ),
      ]);
    }
  }
  return Object.freeze({
    active: Object.freeze(plugins.map((plugin) => plugin.definition.id)),
    blocked: Object.freeze({ ...blocked }),
    contributions: Object.freeze(contributions),
  });
};

export const createEffectScopeRuntime: PluginRuntimeFactory = (options = {}): PluginRuntime => {
  let current: LiveComposition = { plugins: [], snapshot: emptySnapshot() };
  let disposed = false;
  let transition: Promise<void> = Promise.resolve();

  const activatePlugin = async (
    definition: PluginDefinition,
    capabilities: ReadonlyMap<string, unknown>,
  ): Promise<LivePlugin> => {
    const scope = Effect.runSync(Scope.make("sequential"));
    const contributions = new Map<string, Array<Contribution>>();
    let activated = false;

    Effect.runSync(
      Scope.addFinalizer(
        scope,
        Effect.sync(() => {
          if (activated) options.onLifecycle?.({ phase: "deactivate", pluginId: definition.id });
        }),
      ),
    );

    const context: PluginActivationContext = {
      resolve: <Service>(capability: string): Service => {
        if (!capabilities.has(capability)) {
          throw new Error(
            `Plugin ${definition.id} cannot resolve inactive capability: ${capability}`,
          );
        }
        return capabilities.get(capability) as Service;
      },
      register: (slot, contribution) => {
        const values = contributions.get(slot) ?? [];
        values.push(contribution);
        contributions.set(slot, values);
      },
      onDispose: (finalizer) => {
        Effect.runSync(
          Scope.addFinalizer(
            scope,
            Effect.promise(() => Promise.resolve().then(finalizer)),
          ),
        );
      },
    };

    try {
      await Effect.runPromise(
        Effect.promise(() => Promise.resolve().then(() => definition.activate(context))).pipe(
          Effect.provideService(Scope.Scope, scope),
        ),
      );
      activated = true;
      options.onLifecycle?.({ phase: "activate", pluginId: definition.id });
      return { definition, scope, contributions };
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  };

  const enqueue = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = transition.then(operation);
    transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    reconcile: (definitions) =>
      enqueue(async () => {
        if (disposed) throw new Error("Plugin runtime is disposed");

        const plan = planComposition(definitions);
        const affected = affectedPluginIds(current.plugins, plan.definitions);
        const currentById = new Map(
          current.plugins.map((plugin) => [plugin.definition.id, plugin]),
        );
        const capabilities = new Map<string, unknown>();
        for (const plugin of current.plugins) {
          if (affected.has(plugin.definition.id)) continue;
          for (const [capability, service] of Object.entries(plugin.definition.provides ?? {})) {
            capabilities.set(capability, service);
          }
        }

        const staged = new Map<string, LivePlugin>();
        try {
          for (const definition of plan.definitions) {
            if (!affected.has(definition.id)) continue;
            const plugin = await activatePlugin(definition, capabilities);
            staged.set(definition.id, plugin);
            for (const [capability, service] of Object.entries(definition.provides ?? {})) {
              capabilities.set(capability, service);
            }
          }
        } catch (error) {
          await closePlugins([...staged.values()]);
          throw error;
        }

        const nextPlugins = plan.definitions.map((definition) => {
          const plugin = staged.get(definition.id) ?? currentById.get(definition.id);
          if (plugin === undefined) throw new Error(`Plugin ${definition.id} was not staged`);
          return plugin;
        });
        const previous = current.plugins.filter((plugin) => affected.has(plugin.definition.id));
        current = {
          plugins: nextPlugins,
          snapshot: snapshotOf(nextPlugins, plan.blocked),
        };
        await closePlugins(previous);
        return current.snapshot;
      }),
    snapshot: () => current.snapshot,
    dispose: () =>
      enqueue(async () => {
        if (disposed) return;
        disposed = true;
        const previous = current.plugins;
        current = { plugins: [], snapshot: emptySnapshot() };
        await closePlugins(previous);
      }),
  };
};
