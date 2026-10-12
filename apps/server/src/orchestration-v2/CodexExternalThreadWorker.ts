import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { CodexSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import { forkParked } from "../serverActivation.ts";
import { CodexAppServerClientFactory, DEFAULT_CODEX_SETTINGS } from "./Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "./IdAllocator.ts";
import * as NativeCatalogSync from "./NativeCatalogSync.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryHydration from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../serverSettings.ts";

/**
 * Import native Codex conversations with a bounded catalog pass.
 *
 * Registry and settings are re-read every interval. This prevents a removed
 * or disabled instance from retaining a forever-running sync fiber and ensures
 * custom CODEX_HOME/binary/env settings are used, rather than a hardcoded
 * default Codex installation.
 */
export class CodexExternalThreadWorker extends Context.Service<
  CodexExternalThreadWorker,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/orchestration-v2/CodexExternalThreadWorker") {}

const decodeCodexSettings = Schema.decodeUnknownSync(CodexSettings);

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const clientFactory = yield* CodexAppServerClientFactory;
  const baseEnvironment = yield* HostProcessEnvironment;

  const syncAllOnce = Effect.gen(function* () {
    const [available, settings] = yield* Effect.all([
      instances.listInstances,
      serverSettings.getSettings,
    ]);
    const configMap = ProviderInstanceRegistryHydration.deriveProviderInstanceConfigMap(settings);
    const codex = available.filter(
      (instance) => String(instance.driverKind) === "codex" && instance.enabled,
    );
    yield* Effect.forEach(
      codex,
      (instance) =>
        Effect.gen(function* () {
          const config = configMap[instance.instanceId];
          let driverSettings = DEFAULT_CODEX_SETTINGS;
          try {
            driverSettings = decodeCodexSettings(config?.config ?? {});
          } catch {
            yield* Effect.logWarning("invalid native Codex discovery settings", {
              instanceId: instance.instanceId,
            });
            return;
          }
          const environment = { ...baseEnvironment };
          for (const entry of config?.environment ?? []) {
            if (entry.value) environment[entry.name] = entry.value;
          }
          const sync = yield* NativeCatalogSync.make({
            clientFactory,
            settings: driverSettings,
            environment,
            instanceId: instance.instanceId,
          }).pipe(
            Effect.provideService(ThreadLaunchService.ThreadLaunchService, threadLaunch),
            Effect.provideService(ProjectService.ProjectService, projects),
            Effect.provideService(IdAllocator.IdAllocatorV2, ids),
            Effect.provideService(ProjectionStore.ProjectionStoreV2, projectionStore),
            Effect.provideService(SqlClient.SqlClient, sql),
          );
          yield* sync.syncOnce;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("native Codex catalog sync failed", {
              instanceId: instance.instanceId,
              cause,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("native Codex catalog worker iteration failed", { cause }),
    ),
  );

  const start = () =>
    Effect.gen(function* () {
      yield* forkParked(
        syncAllOnce.pipe(
          Effect.repeat(Schedule.spaced(NativeCatalogSync.NATIVE_CATALOG_SYNC_INTERVAL)),
        ),
      );
    });

  return CodexExternalThreadWorker.of({ start });
});

export const layer = Layer.effect(CodexExternalThreadWorker, make);
