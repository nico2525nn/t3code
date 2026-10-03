import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as IdAllocator from "./IdAllocator.ts";
import * as NativeCatalog from "./NativeCatalog.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";

/**
 * How often the catalog is re-read once startup has run.
 *
 * The pass is driven by a stored watermark, so an unchanged catalog costs one
 * page per partition regardless of this interval. It is local traffic between
 * the server and its own provider, not traffic a client pays for, so this can
 * stay well below the old five-second full-history poll without cost.
 */
export const NATIVE_CATALOG_SYNC_INTERVAL = "30 seconds" as const;

export class NativeCatalogSyncError extends Schema.TaggedError<NativeCatalogSyncError>()(
  "NativeCatalogSyncError",
  {
    operation: Schema.Literals(["read-watermark", "write-watermark"]),
    driver: ProviderDriverKind,
    providerInstanceId: ProviderInstanceId,
    archived: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Native catalog ${this.operation} failed for ${this.driver}/${this.providerInstanceId}.`;
  }
}

export class NativeThreadImportError extends Schema.TaggedError<NativeThreadImportError>()(
  "NativeThreadImportError",
  {
    nativeThreadId: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to import native thread ${this.nativeThreadId}.`;
  }
}

export interface NativeCatalogSyncSummary {
  readonly instancesScanned: number;
  readonly threadsImported: number;
  /** Native rows whose app thread already existed; no second thread was made. */
  readonly threadsReconciled: number;
  readonly threadsFailed: number;
  /** Passes that hit the page cap before reaching the end of the catalog. */
  readonly truncatedPasses: number;
}

interface NativeCatalogWatermarkRow {
  readonly watermark: string | null;
  readonly resume_cursor: string | null;
}

/** One catalog partition: a driver instance's threads on one side of the archive split. */
interface CatalogSource {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly archived: boolean;
}

const readWatermark = (sql: SqlClient.SqlClient, source: CatalogSource) =>
  Effect.gen(function* () {
    const rows = yield* sql<NativeCatalogWatermarkRow>`
      SELECT watermark, resume_cursor
      FROM orchestration_v2_native_catalog_state
      WHERE driver = ${source.driver}
        AND provider_instance_id = ${source.providerInstanceId}
        AND archived = ${source.archived ? 1 : 0}
    `.pipe(
      Effect.mapError(
        (cause) => new NativeCatalogSyncError({ ...source, operation: "read-watermark", cause }),
      ),
    );
    const row = rows.at(0);
    return {
      watermark: row?.watermark ?? undefined,
      resumeCursor: row?.resume_cursor ?? undefined,
    };
  });

const writeWatermark = (
  sql: SqlClient.SqlClient,
  source: CatalogSource & {
    readonly watermark: string | undefined;
    readonly resumeCursor: string | null;
  },
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_native_catalog_state
        (driver, provider_instance_id, archived, watermark, resume_cursor, updated_at)
      VALUES (
        ${source.driver},
        ${source.providerInstanceId},
        ${source.archived ? 1 : 0},
        ${source.watermark ?? null},
        ${source.resumeCursor},
        ${now}
      )
      ON CONFLICT (driver, provider_instance_id, archived)
      DO UPDATE SET
        watermark = excluded.watermark,
        resume_cursor = excluded.resume_cursor,
        updated_at = excluded.updated_at,
        last_error = NULL
    `.pipe(
      Effect.mapError(
        (cause) => new NativeCatalogSyncError({ ...source, operation: "write-watermark", cause }),
      ),
    );
  });

/**
 * Command ids derived from the provider's own identity, not from a clock or a
 * counter. Re-running a sync therefore replays the same commands, and the
 * orchestrator's command receipts turn the second run into a no-op. A random id
 * would create a second app thread for the same native conversation the first
 * time a pass was interrupted.
 */
const importCommandId = (source: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeThreadId: string;
}) =>
  CommandId.make(
    `native-catalog:${source.driver}:${source.providerInstanceId}:${source.nativeThreadId}`,
  );

/**
 * Reconciliation ids carry the value being written. A repeated pass with the
 * same title replays the same command and is absorbed by the receipt; a rename
 * produces a different id, so the update actually runs.
 */
const reconcileCommandId = (source: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeThreadId: string;
  readonly title: string;
}) =>
  CommandId.make(
    `native-catalog:${source.driver}:${source.providerInstanceId}:${source.nativeThreadId}:title:${source.title}`,
  );

const projectCommandId = (workspaceRoot: string) =>
  CommandId.make(`native-catalog:project:${workspaceRoot}`);

interface InstanceSyncResult {
  readonly imported: number;
  /** Rows already owned by a T3 thread; these were reconciled, not created. */
  readonly reconciled: number;
  readonly failed: number;
  readonly truncated: number;
}

const noInstanceWork = {
  imported: 0,
  reconciled: 0,
  failed: 0,
  truncated: 0,
} satisfies InstanceSyncResult;

export class NativeCatalogSync extends Context.Service<
  NativeCatalogSync,
  { readonly syncOnce: Effect.Effect<NativeCatalogSyncSummary, never> }
>()("t3/orchestration-v2/NativeCatalogSync") {}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;

  const importThread = (
    adapter: ProviderAdapter.ProviderAdapterV2Shape,
    thread: ProviderAdapter.ProviderAdapterV2NativeThreadSummary,
    nativeModel: string | undefined,
  ) =>
    Effect.gen(function* () {
      const failure = (cause: unknown) =>
        new NativeThreadImportError({ nativeThreadId: thread.nativeId, cause });
      const threadId = IdAllocator.deriveThreadFromProviderThread({
        driver: adapter.driver,
        providerInstanceId: adapter.instanceId,
        nativeThreadId: thread.nativeId,
      });

      // `bootstrap` resolves by workspace root, so a replayed pass reuses the
      // project an earlier pass created instead of forking a second one.
      const { project } = yield* projects
        .bootstrap({
          commandId: projectCommandId(thread.cwd),
          projectId: yield* ids.allocate.project({ fixtureName: thread.cwd }),
          title: thread.cwd.split("/").filter(Boolean).at(-1) ?? thread.cwd,
          workspaceRoot: thread.cwd,
        })
        .pipe(Effect.mapError(failure));

      // The native catalog also lists conversations T3 created itself. When an
      // app thread already owns this native id, that thread is canonical, so
      // importing again would show the user the same conversation twice.
      const owner = yield* projectionStore
        .findThreadIdByNativeIdentity({
          driver: adapter.driver,
          providerInstanceId: adapter.instanceId,
          nativeThreadId: thread.nativeId,
        })
        .pipe(Effect.mapError(failure));
      if (owner !== null) {
        // Refresh the shell metadata the provider owns. The command id carries
        // the title being written, so a rename runs a new command while an
        // unchanged title replays as a no-op.
        if (thread.title !== undefined) {
          yield* threadLaunch
            .reconcileImportedThread({
              projectId: project.id,
              commandId: reconcileCommandId({
                driver: adapter.driver,
                providerInstanceId: adapter.instanceId,
                nativeThreadId: thread.nativeId,
                title: thread.title,
              }),
              threadId: owner,
              title: thread.title,
            })
            .pipe(Effect.mapError(failure));
        }
        return { kind: "reconciled" as const, threadId: owner };
      }

      yield* threadLaunch
        .launch({
          commandId: importCommandId({
            driver: adapter.driver,
            providerInstanceId: adapter.instanceId,
            nativeThreadId: thread.nativeId,
          }),
          threadId,
          projectId: project.id,
          title: thread.title ?? thread.nativeId,
          // A conversation created elsewhere already runs on a model its author
          // chose there. Resuming it under T3's default would silently switch
          // it, so the provider's own model wins until the user changes it.
          modelSelection: {
            instanceId: adapter.instanceId,
            model: nativeModel ?? DEFAULT_MODEL,
          },
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy: { type: "root" },
          importedNativeThread: {
            ref: { driver: adapter.driver, nativeId: thread.nativeId, strength: "strong" },
            metadata: {
              itemIdentityVersion: 2,
              ...(thread.title === undefined ? {} : { title: thread.title }),
              updatedAt: thread.updatedAt,
            },
          },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.mapError(failure));

      return { kind: "imported" as const, threadId };
    });

  const syncInstance = (
    adapter: ProviderAdapter.ProviderAdapterV2Shape,
  ): Effect.Effect<InstanceSyncResult, NativeCatalogSyncError> =>
    Effect.gen(function* () {
      const withCatalog = adapter.withNativeCatalog;
      // An adapter without a native catalog is simply not a source of threads
      // that started outside T3.
      if (withCatalog === undefined) {
        return noInstanceWork;
      }

      let imported = 0;
      let reconciled = 0;
      let failed = 0;
      let truncated = 0;

      for (const archived of [false, true]) {
        const source: CatalogSource = {
          driver: adapter.driver,
          providerInstanceId: adapter.instanceId,
          archived,
        };
        const { watermark, resumeCursor } = yield* readWatermark(sql, source);
        const scanned = yield* Effect.result(
          withCatalog((readPage) =>
            NativeCatalog.scanNativeCatalog(readPage, {
              archived,
              watermark,
              resumeCursor,
              pageSize: NativeCatalog.NATIVE_CATALOG_PAGE_SIZE,
              maxPages: NativeCatalog.NATIVE_CATALOG_MAX_PAGES_PER_PASS,
            }),
          ),
        );

        // A failed read must not move the commit point: the next pass would
        // then skip every conversation this one never saw.
        if (Result.isFailure(scanned)) {
          yield* Effect.logWarning("native catalog scan failed", {
            ...source,
            cause: scanned.failure,
          });
          failed += 1;
          continue;
        }

        const scan = scanned.success;
        let partitionFailed = false;

        // A listing cannot report which model a conversation runs on, so the
        // models for rows this pass will actually import are read here, once,
        // on a connection of their own. Reading them per row would cost one
        // request per conversation on every pass.
        const models =
          scan.changed.length === 0 || adapter.readNativeModels === undefined
            ? {}
            : yield* Effect.result(
                adapter.readNativeModels(scan.changed.map((thread) => thread.nativeId)),
              ).pipe(Effect.map(Result.getOrElse(() => ({}) as Readonly<Record<string, string>>)));

        for (const thread of scan.changed) {
          const outcome = yield* Effect.result(
            importThread(adapter, thread, models[thread.nativeId]),
          );
          if (Result.isSuccess(outcome)) {
            if (outcome.success.kind === "imported") {
              imported += 1;
            } else {
              reconciled += 1;
            }
            continue;
          }
          partitionFailed = true;
          failed += 1;
          yield* Effect.logWarning("native catalog import failed", {
            driver: adapter.driver,
            providerInstanceId: adapter.instanceId,
            nativeThreadId: thread.nativeId,
            cause: outcome.failure,
          });
        }

        // The watermark is a commit point. It advances only when this pass
        // reached the previous one (or the end of the catalog) and every row
        // it saw imported cleanly; otherwise the rows behind the boundary are
        // retried from the recorded cursor.
        if (!scan.complete) {
          truncated += 1;
        }
        const canCommit = scan.complete && !partitionFailed;
        yield* writeWatermark(sql, {
          ...source,
          watermark: canCommit ? scan.watermark : watermark,
          resumeCursor: canCommit ? null : scan.resumeCursor,
        });
      }

      return { imported, reconciled, failed, truncated };
    });

  const syncOnce = Effect.gen(function* () {
    const instanceIds = yield* registry.list();
    const adapters = yield* Effect.forEach(instanceIds, (instanceId) =>
      registry.get(instanceId).pipe(Effect.option),
    );
    const catalogAdapters = adapters.flatMap((adapter) =>
      Option.isSome(adapter) && adapter.value.withNativeCatalog !== undefined
        ? [adapter.value]
        : [],
    );

    const results = yield* Effect.forEach(
      catalogAdapters,
      (adapter) =>
        syncInstance(adapter).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("native catalog sync failed", {
              driver: adapter.driver,
              providerInstanceId: adapter.instanceId,
              cause,
            }).pipe(Effect.as(noInstanceWork)),
          ),
        ),
      { concurrency: 1 },
    );

    return {
      instancesScanned: results.length,
      threadsImported: results.reduce((total, result) => total + result.imported, 0),
      threadsReconciled: results.reduce((total, result) => total + result.reconciled, 0),
      threadsFailed: results.reduce((total, result) => total + result.failed, 0),
      truncatedPasses: results.reduce((total, result) => total + result.truncated, 0),
    } satisfies NativeCatalogSyncSummary;
  });

  return NativeCatalogSync.of({ syncOnce });
});

export const layer = Layer.effect(NativeCatalogSync, make);
