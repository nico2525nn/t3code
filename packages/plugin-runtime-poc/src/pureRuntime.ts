import type {
  Contribution,
  PluginDefinition,
  PluginRuntime,
  PluginRuntimeFactory,
  PluginRuntimeSnapshot,
} from "./contract.ts";

type Finalizer = () => void | Promise<void>;

interface PluginInstance {
  readonly definition: PluginDefinition;
  readonly contributions: Map<string, Array<Contribution>>;
  readonly finalizers: Array<Finalizer>;
  activated: boolean;
}

interface Composition {
  readonly instances: ReadonlyArray<PluginInstance>;
  readonly snapshot: PluginRuntimeSnapshot;
}

interface CompositionPlan {
  readonly active: ReadonlyArray<PluginDefinition>;
  readonly blocked: Readonly<Record<string, string>>;
  readonly providers: ReadonlyMap<string, PluginDefinition>;
}

const createSnapshot = (
  instances: ReadonlyArray<PluginInstance>,
  blocked: Readonly<Record<string, string>>,
): PluginRuntimeSnapshot => {
  const contributions: Record<string, Array<Contribution>> = {};

  for (const instance of instances) {
    for (const [slot, registrations] of instance.contributions) {
      const items = contributions[slot] ?? [];
      items.push(...registrations);
      contributions[slot] = items;
    }
  }

  const frozenContributions: Record<string, ReadonlyArray<Contribution>> = {};
  for (const [slot, registrations] of Object.entries(contributions)) {
    frozenContributions[slot] = Object.freeze([...registrations]);
  }

  return Object.freeze({
    active: Object.freeze(instances.map(({ definition }) => definition.id)),
    blocked: Object.freeze({ ...blocked }),
    contributions: Object.freeze(frozenContributions),
  });
};

const emptyComposition = (): Composition => ({
  instances: [],
  snapshot: createSnapshot([], {}),
});

const planComposition = (definitions: ReadonlyArray<PluginDefinition>): CompositionPlan => {
  const byId = new Map<string, PluginDefinition>();
  const providers = new Map<string, PluginDefinition>();

  for (const definition of definitions) {
    if (byId.has(definition.id)) {
      throw new Error(`duplicate plugin id: ${definition.id}`);
    }
    byId.set(definition.id, definition);

    for (const capability of Object.keys(definition.provides ?? {})) {
      const previous = providers.get(capability);
      if (previous !== undefined) {
        throw new Error(`duplicate provider for ${capability}: ${previous.id}, ${definition.id}`);
      }
      providers.set(capability, definition);
    }
  }

  const states = new Map<string, "visiting" | "visited">();
  const path: Array<string> = [];
  const active: Array<PluginDefinition> = [];
  const blocked: Record<string, string> = {};

  const visit = (definition: PluginDefinition): void => {
    const state = states.get(definition.id);
    if (state === "visited") return;
    if (state === "visiting") {
      const cycleStart = path.indexOf(definition.id);
      const cycle = [...path.slice(cycleStart), definition.id];
      throw new Error(`dependency cycle detected: ${cycle.join(" -> ")}`);
    }

    states.set(definition.id, "visiting");
    path.push(definition.id);
    let reason: string | undefined;

    for (const capability of definition.requires ?? []) {
      const provider = providers.get(capability);
      if (provider === undefined) {
        reason ??= `missing dependency: ${capability}`;
        continue;
      }

      visit(provider);
      if (blocked[provider.id] !== undefined) {
        reason ??= `dependency unavailable: ${capability}`;
      }
    }

    path.pop();
    states.set(definition.id, "visited");
    if (reason === undefined) {
      active.push(definition);
    } else {
      blocked[definition.id] = reason;
    }
  };

  for (const definition of definitions) visit(definition);
  return { active, blocked, providers };
};

const sameDefinitionShape = (previous: PluginDefinition, desired: PluginDefinition) => {
  const previousRequires = previous.requires ?? [];
  const desiredRequires = desired.requires ?? [];
  const previousProvides = Object.keys(previous.provides ?? {});
  const desiredProvides = Object.keys(desired.provides ?? {});

  return (
    previous.version === desired.version &&
    previousRequires.length === desiredRequires.length &&
    previousRequires.every((capability, index) => capability === desiredRequires[index]) &&
    previousProvides.length === desiredProvides.length &&
    previousProvides.every((capability, index) => capability === desiredProvides[index])
  );
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "plugin activation failed";

export const createPureRuntime: PluginRuntimeFactory = (options = {}): PluginRuntime => {
  let current = emptyComposition();
  let disposed = false;
  let transition = Promise.resolve();

  const deactivate = async (instance: PluginInstance): Promise<Array<unknown>> => {
    const errors: Array<unknown> = [];

    if (instance.activated) {
      try {
        options.onLifecycle?.({
          phase: "deactivate",
          pluginId: instance.definition.id,
        });
      } catch (error) {
        errors.push(error);
      }
    }

    for (let index = instance.finalizers.length - 1; index >= 0; index -= 1) {
      const finalizer = instance.finalizers[index];
      if (finalizer === undefined) continue;
      try {
        await finalizer();
      } catch (error) {
        errors.push(error);
      }
    }

    return errors;
  };

  const deactivateAll = async (
    instances: ReadonlyArray<PluginInstance>,
  ): Promise<Array<unknown>> => {
    const errors: Array<unknown> = [];
    for (let index = instances.length - 1; index >= 0; index -= 1) {
      const instance = instances[index];
      if (instance !== undefined) errors.push(...(await deactivate(instance)));
    }
    return errors;
  };

  const stage = async (
    definitions: ReadonlyArray<PluginDefinition>,
    previous: Composition,
  ): Promise<Composition> => {
    const plan = planComposition(definitions);
    const previousById = new Map(
      previous.instances.map((instance) => [instance.definition.id, instance]),
    );
    const restart = new Set<string>();

    for (const definition of plan.active) {
      const existing = previousById.get(definition.id);
      if (existing === undefined || !sameDefinitionShape(existing.definition, definition)) {
        restart.add(definition.id);
      }
    }

    for (const definition of plan.active) {
      if (
        (definition.requires ?? []).some((capability) => {
          const provider = plan.providers.get(capability);
          return provider !== undefined && restart.has(provider.id);
        })
      ) {
        restart.add(definition.id);
      }
    }

    const services = new Map<string, unknown>();
    const staged: Array<PluginInstance> = [];
    const stagedById = new Map<string, PluginInstance>();

    for (const definition of plan.active) {
      if (restart.has(definition.id)) continue;
      const instance = previousById.get(definition.id);
      if (instance === undefined) {
        throw new Error(`missing reusable plugin instance: ${definition.id}`);
      }
      for (const [capability, service] of Object.entries(instance.definition.provides ?? {})) {
        services.set(capability, service);
      }
    }

    try {
      for (const definition of plan.active) {
        if (!restart.has(definition.id)) continue;

        const instance: PluginInstance = {
          definition,
          contributions: new Map(),
          finalizers: [],
          activated: false,
        };
        staged.push(instance);
        stagedById.set(definition.id, instance);

        let activating = true;
        const assertActivating = () => {
          if (!activating) {
            throw new Error(`activation context for ${definition.id} is no longer active`);
          }
        };

        try {
          await definition.activate({
            resolve: <Service>(capability: string): Service => {
              assertActivating();
              if (!services.has(capability)) {
                throw new Error(`plugin ${definition.id} could not resolve ${capability}`);
              }
              return services.get(capability) as Service;
            },
            register: (slot, contribution) => {
              assertActivating();
              const items = instance.contributions.get(slot) ?? [];
              items.push(Object.freeze({ id: contribution.id, label: contribution.label }));
              instance.contributions.set(slot, items);
            },
            onDispose: (finalizer) => {
              assertActivating();
              instance.finalizers.push(finalizer);
            },
          });
        } finally {
          activating = false;
        }

        instance.activated = true;
        options.onLifecycle?.({ phase: "activate", pluginId: definition.id });
        for (const [capability, service] of Object.entries(definition.provides ?? {})) {
          services.set(capability, service);
        }
      }

      const instances = plan.active.map((definition) => {
        const instance = stagedById.get(definition.id) ?? previousById.get(definition.id);
        if (instance === undefined) {
          throw new Error(`missing plugin instance after staging: ${definition.id}`);
        }
        return instance;
      });
      return {
        instances,
        snapshot: createSnapshot(instances, plan.blocked),
      };
    } catch (activationError) {
      const cleanupErrors = await deactivateAll(staged);
      if (cleanupErrors.length > 0) {
        throw new Error(
          `${messageOf(activationError)}; ${cleanupErrors.length} rollback finalizer(s) also failed`,
          { cause: activationError },
        );
      }
      throw activationError;
    }
  };

  const runExclusive = <Result>(operation: () => Promise<Result>): Promise<Result> => {
    const result = transition.then(operation);
    transition = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    reconcile: (definitions) => {
      const desired = [...definitions];
      return runExclusive(async () => {
        if (disposed) throw new Error("plugin runtime is disposed");

        const previous = current;
        const candidate = await stage(desired, previous);
        current = candidate;

        const retained = new Set(candidate.instances);
        const retired = previous.instances.filter((instance) => !retained.has(instance));
        const cleanupErrors = await deactivateAll(retired);
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "previous composition deactivation failed");
        }
        return candidate.snapshot;
      });
    },
    snapshot: () => current.snapshot,
    dispose: () =>
      runExclusive(async () => {
        if (disposed) return;
        disposed = true;

        const previous = current;
        current = emptyComposition();
        const cleanupErrors = await deactivateAll(previous.instances);
        if (cleanupErrors.length > 0) {
          throw new AggregateError(cleanupErrors, "plugin runtime disposal failed");
        }
      }),
  };
};
