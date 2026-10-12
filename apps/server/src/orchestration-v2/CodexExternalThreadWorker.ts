import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
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

/**
 * Adopt Codex conversations that started outside T3.
 *
 * Runs the catalog sync every 30s for Codex instances. Idle cost is one
 * `thread/list` page per archive partition; nothing is copied until a reader
 * opens an adopted thread.
 */
export class CodexExternalThreadWorker extends Context.Service<
  CodexExternalThreadWorker,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/orchestration-v2/CodexExternalThreadWorker") {}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const clientFactory = yield* CodexAppServerClientFactory;
  const environment = yield* HostProcessEnvironment;

  const runInstance = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const sync = yield* NativeCatalogSync.make({
        clientFactory,
        settings: DEFAULT_CODEX_SETTINGS,
        environment,
        instanceId,
      }).pipe(
        Effect.provideService(ThreadLaunchService.ThreadLaunchService, threadLaunch),
        Effect.provideService(ProjectService.ProjectService, projects),
        Effect.provideService(IdAllocator.IdAllocatorV2, ids),
        Effect.provideService(ProjectionStore.ProjectionStoreV2, projectionStore),
        Effect.provideService(SqlClient.SqlClient, sql),
      );
      yield* sync.syncOnce.pipe(
        Effect.catch(() => Effect.logWarning("codex external thread sync failed", { instanceId })),
        Effect.repeat(Schedule.spaced(NativeCatalogSync.NATIVE_CATALOG_SYNC_INTERVAL)),
      );
    });

  const start = () =>
    Effect.gen(function* () {
      const all = yield* instances.listInstances.pipe(Effect.orElseSucceed(() => [] as const));
      const codexInstances = all.filter(
        (instance) => String(instance.driverKind) === "codex" && instance.enabled,
      );
      yield* forkParked(
        Effect.forEach(codexInstances, (instance) => runInstance(instance.instanceId), { concurrency: 1, discard: true }),
      );
    });

  return CodexExternalThreadWorker.of({ start });
});

export const layer = Layer.effect(CodexExternalThreadWorker, make);
