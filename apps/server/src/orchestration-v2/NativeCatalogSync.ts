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
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";

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
  readonly threadsFailed: number;
  /** Passes that hit the page cap before reaching the end of the catalog. */
  readonly truncatedPasses: number;
}

interface NativeCatalogWatermarkRow {
  readonly watermark: string | null;
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
      SELECT watermark
      FROM orchestration_v2_native_catalog_state
      WHERE driver = ${source.driver}
        AND provider_instance_id = ${source.providerInstanceId}
        AND archived = ${source.archived ? 1 : 0}
    `.pipe(
      Effect.mapError(
        (cause) => new NativeCatalogSyncError({ ...source, operation: "read-watermark", cause }),
      ),
    );
    return rows.at(0)?.watermark ?? undefined;
  });

const writeWatermark = (
  sql: SqlClient.SqlClient,
  source: CatalogSource & { readonly watermark: string },
) =>
  Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_native_catalog_state
        (driver, provider_instance_id, archived, watermark, updated_at)
      VALUES (
        ${source.driver},
        ${source.providerInstanceId},
        ${source.archived ? 1 : 0},
        ${source.watermark},
        ${now}
      )
      ON CONFLICT (driver, provider_instance_id, archived)
      DO UPDATE SET
        watermark = excluded.watermark,
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

const projectCommandId = (workspaceRoot: string) =>
  CommandId.make(`native-catalog:project:${workspaceRoot}`);

interface InstanceSyncResult {
  readonly imported: number;
  readonly failed: number;
  readonly truncated: number;
}

const noInstanceWork = {
  imported: 0,
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
  const sql = yield* SqlClient.SqlClient;

  const importThread = (
    adapter: ProviderAdapter.ProviderAdapterV2Shape,
    thread: ProviderAdapter.ProviderAdapterV2NativeThreadSummary,
  ) =>
    Effect.gen(function* () {
      const failure = (cause: unknown) =>
        new NativeThreadImportError({ nativeThreadId: thread.nativeId, cause });

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

      yield* threadLaunch
        .launch({
          commandId: importCommandId({
            driver: adapter.driver,
            providerInstanceId: adapter.instanceId,
            nativeThreadId: thread.nativeId,
          }),
          threadId: IdAllocator.deriveThreadFromProviderThread({
            driver: adapter.driver,
            providerInstanceId: adapter.instanceId,
            nativeThreadId: thread.nativeId,
          }),
          projectId: project.id,
          title: thread.title ?? thread.nativeId,
          modelSelection: { instanceId: adapter.instanceId, model: DEFAULT_MODEL },
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
      let failed = 0;
      let truncated = 0;

      for (const archived of [false, true]) {
        const source: CatalogSource = {
          driver: adapter.driver,
          providerInstanceId: adapter.instanceId,
          archived,
        };
        const watermark = yield* readWatermark(sql, source);
        const scanned = yield* Effect.result(
          withCatalog((readPage) =>
            NativeCatalog.scanNativeCatalog(readPage, {
              archived,
              watermark,
              pageSize: NativeCatalog.NATIVE_CATALOG_PAGE_SIZE,
              maxPages: NativeCatalog.NATIVE_CATALOG_MAX_PAGES_PER_PASS,
            }),
          ),
        );

        // A failed read must not advance the watermark: the next pass would then
        // skip every conversation this one never saw.
        if (Result.isFailure(scanned)) {
          yield* Effect.logWarning("native catalog scan failed", {
            ...source,
            cause: scanned.failure,
          });
          failed += 1;
          continue;
        }

        const scan = scanned.success;
        if (scan.truncated) {
          truncated += 1;
        }
        for (const thread of scan.changed) {
          const outcome = yield* Effect.result(importThread(adapter, thread));
          if (Result.isSuccess(outcome)) {
            imported += 1;
            continue;
          }
          failed += 1;
          yield* Effect.logWarning("native catalog import failed", {
            driver: adapter.driver,
            providerInstanceId: adapter.instanceId,
            nativeThreadId: thread.nativeId,
            cause: outcome.failure,
          });
        }
        if (scan.watermark !== undefined) {
          yield* writeWatermark(sql, { ...source, watermark: scan.watermark });
        }
      }

      return { imported, failed, truncated };
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
      threadsFailed: results.reduce((total, result) => total + result.failed, 0),
      truncatedPasses: results.reduce((total, result) => total + result.truncated, 0),
    } satisfies NativeCatalogSyncSummary;
  });

  return NativeCatalogSync.of({ syncOnce });
});

export const layer = Layer.effect(NativeCatalogSync, make);
