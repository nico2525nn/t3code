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
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as IdAllocator from "./IdAllocator.ts";
import * as NativeCatalog from "./NativeCatalog.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as CodexExternalThreads from "./Adapters/CodexExternalThreads.ts";

/**
 * Adopt conversations that started outside T3.
 *
 * Every 30s: list native threads newer than the stored watermark, launch a T3
 * thread for each unknown one (deterministic command ids make replays
 * idempotent), probe changed + not-yet-attached conversations for a running
 * turn, and attach to those running so the UI shows them live. History is
 * never copied here; the first reader pulls it on demand.
 */

export const NATIVE_CATALOG_SYNC_INTERVAL = "30 seconds" as const;

const CODEX_DRIVER = ProviderDriverKind.make("codex");

export class NativeCatalogSyncError extends Schema.TaggedError<NativeCatalogSyncError>()(
  "NativeCatalogSyncError",
  {
    operation: Schema.Literals(["read-watermark", "write-watermark"]),
    providerInstanceId: ProviderInstanceId,
    archived: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Native catalog ${this.operation} failed for codex/${this.providerInstanceId}.`;
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
  readonly threadsReconciled: number;
  readonly threadsFailed: number;
  readonly truncatedPasses: number;
}

export interface NativeCatalogSyncOptions extends CodexExternalThreads.CodexExternalThreadsOptions {
  readonly instanceId: ProviderInstanceId;
}

interface CatalogSource {
  readonly providerInstanceId: ProviderInstanceId;
  readonly archived: boolean;
}

const readWatermark = (sql: SqlClient.SqlClient, source: CatalogSource) =>
  Effect.gen(function* () {
    const rows = yield* sql<{
      readonly watermark: string | null;
      readonly resume_cursor: string | null;
    }>`
      SELECT watermark, resume_cursor
      FROM orchestration_v2_native_catalog_state
      WHERE driver = 'codex'
        AND provider_instance_id = ${source.providerInstanceId}
        AND archived = ${source.archived ? 1 : 0}
    `;
    const row = rows.at(0);
    return {
      watermark: row?.watermark ?? undefined,
      resumeCursor: row?.resume_cursor ?? undefined,
    };
  }).pipe(Effect.orElseSucceed(() => ({ watermark: undefined, resumeCursor: undefined })));

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
        'codex',
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
    `;
  }).pipe(
    Effect.catch((cause) =>
      Effect.fail(
        new NativeCatalogSyncError({
          operation: "write-watermark",
          providerInstanceId: source.providerInstanceId,
          archived: source.archived,
          cause,
        }),
      ),
    ),
  );

export class NativeCatalogSync extends Context.Service<
  NativeCatalogSync,
  { readonly syncOnce: Effect.Effect<NativeCatalogSyncSummary, never> }
>()("t3/orchestration-v2/NativeCatalogSync") {}

export const make = (syncOptions: NativeCatalogSyncOptions) =>
  Effect.gen(function* () {
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const projects = yield* ProjectService.ProjectService;
    const ids = yield* IdAllocator.IdAllocatorV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const external: CodexExternalThreads.CodexExternalThreadsOptions = {
      clientFactory: syncOptions.clientFactory,
      settings: syncOptions.settings,
      environment: syncOptions.environment,
    };

    /** Native ids adopted but never attached; the probe keeps re-checking them. */
    const detachedNativeIds = yield* Ref.make<ReadonlySet<string>>(new Set<string>());

    const importThread = (thread: CodexExternalThreads.CodexNativeThreadSummary) =>
      Effect.gen(function* () {
        const failure = (cause: unknown) =>
          new NativeThreadImportError({ nativeThreadId: thread.nativeId, cause });
        const threadId = IdAllocator.deriveThreadFromProviderThread({
          driver: CODEX_DRIVER,
          providerInstanceId: syncOptions.instanceId,
          nativeThreadId: thread.nativeId,
        });
        const { project } = yield* projects
          .bootstrap({
            commandId: CommandId.make(`native-catalog:project:${thread.cwd}`),
            projectId: yield* ids.allocate.project({ fixtureName: thread.cwd }),
            title: thread.cwd.split("/").filter(Boolean).at(-1) ?? thread.cwd,
            workspaceRoot: thread.cwd,
          })
          .pipe(Effect.mapError(failure));
        const owner = yield* projectionStore
          .findThreadIdByNativeIdentity({
            driver: CODEX_DRIVER,
            providerInstanceId: syncOptions.instanceId,
            nativeThreadId: thread.nativeId,
          })
          .pipe(Effect.mapError(failure));
        if (owner !== null) {
          if (thread.title !== undefined) {
            yield* threadLaunch
              .reconcileImportedThread({
                projectId: project.id,
                commandId: CommandId.make(
                  `native-catalog:codex:${syncOptions.instanceId}:${thread.nativeId}:title:${thread.title}`,
                ),
                threadId: owner,
                title: thread.title,
              })
              .pipe(Effect.orElseSucceed(() => undefined));
          }
          return { kind: "reconciled" as const, threadId: owner };
        }
        yield* threadLaunch
          .launch({
            commandId: CommandId.make(
              `native-catalog:codex:${syncOptions.instanceId}:${thread.nativeId}`,
            ),
            threadId,
            projectId: project.id,
            title: thread.title ?? thread.nativeId,
            modelSelection: {
              instanceId: syncOptions.instanceId,
              model: thread.model ?? DEFAULT_MODEL,
            },
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            workspaceStrategy: { type: "root" },
            importedNativeThread: {
              ref: { driver: CODEX_DRIVER, nativeId: thread.nativeId, strength: "strong" },
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

    const syncPartition = (archived: boolean) =>
      Effect.gen(function* () {
        let imported = 0;
        let reconciled = 0;
        let failed = 0;
        let truncated = 0;
        const source: CatalogSource = { providerInstanceId: syncOptions.instanceId, archived };
        const { watermark, resumeCursor } = yield* readWatermark(sql, source);
        const scanned = yield* Effect.exit(
          Effect.scoped(
            NativeCatalog.scanNativeCatalog(
              (page) =>
                CodexExternalThreads.listNativeThreads(external, {
                  archived: page.archived,
                  cursor: page.cursor,
                  limit: page.limit,
                }),
              {
                archived,
                watermark,
                resumeCursor,
                pageSize: NativeCatalog.NATIVE_CATALOG_PAGE_SIZE,
                maxPages: NativeCatalog.NATIVE_CATALOG_MAX_PAGES_PER_PASS,
              },
            ),
          ),
        );
        if (Exit.isFailure(scanned)) {
          yield* Effect.logWarning("native catalog scan failed", {
            providerInstanceId: syncOptions.instanceId,
            archived,
          });
          return { imported, reconciled, failed: failed + 1, truncated };
        }
        const scan = scanned.value;

        const adopted = yield* Ref.get(detachedNativeIds);
        const probeCandidates = [
          ...new Set([...scan.changed.map((thread) => thread.nativeId), ...adopted]),
        ];
        const probeResults = yield* Effect.forEach(
          probeCandidates,
          (nativeThreadId) =>
            Effect.exit(
              Effect.scoped(CodexExternalThreads.readNativeActiveTurn(external, nativeThreadId)),
            ),
          { concurrency: 4 },
        );
        const running: Record<string, string> = {};
        probeResults.forEach((result, index) => {
          if (Exit.isSuccess(result) && result.value !== null) {
            running[probeCandidates[index]!] = result.value.turnId;
          }
        });

        let partitionFailed = false;
        for (const thread of scan.changed) {
          const outcome = yield* Effect.exit(importThread(thread));
          if (Exit.isSuccess(outcome)) {
            yield* Ref.update(detachedNativeIds, (existing) =>
              new Set(existing).add(thread.nativeId),
            );
            if (outcome.value.kind === "imported") imported += 1;
            else reconciled += 1;
            continue;
          }
          partitionFailed = true;
          failed += 1;
          yield* Effect.logWarning("native catalog import failed", {
            providerInstanceId: syncOptions.instanceId,
            nativeThreadId: thread.nativeId,
          });
        }

        for (const [nativeThreadId, nativeTurnId] of Object.entries(running)) {
          yield* Ref.update(detachedNativeIds, (existing) => {
            const next = new Set(existing);
            next.delete(nativeThreadId);
            return next;
          });
          const threadId = IdAllocator.deriveThreadFromProviderThread({
            driver: CODEX_DRIVER,
            providerInstanceId: syncOptions.instanceId,
            nativeThreadId,
          });
          const shell = yield* Effect.exit(projectionStore.getThreadShell(threadId));
          if (
            !Exit.isSuccess(shell) ||
            shell.value === null ||
            shell.value.projectId === undefined
          ) {
            continue;
          }
          yield* threadLaunch
            .attachRunningThread({
              commandId: CommandId.make(
                `native-catalog:codex:${syncOptions.instanceId}:${nativeThreadId}:attach`,
              ),
              projectId: shell.value.projectId,
              threadId,
              providerInstanceId: syncOptions.instanceId,
              nativeTurnId,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("native running conversation attach failed", {
                  providerInstanceId: syncOptions.instanceId,
                  nativeThreadId,
                  cause,
                }),
              ),
            );
        }

        if (!scan.complete) truncated += 1;
        const canCommit = scan.complete && !partitionFailed;
        yield* writeWatermark(sql, {
          ...source,
          watermark: canCommit ? scan.watermark : watermark,
          resumeCursor: canCommit ? null : scan.resumeCursor,
        }).pipe(Effect.orElseSucceed(() => undefined));
        return { imported, reconciled, failed, truncated };
      });

    const syncOnce = Effect.gen(function* () {
      const results = yield* Effect.forEach([false, true], syncPartition, { concurrency: 1 });
      return {
        instancesScanned: 1,
        threadsImported: results.reduce((total, result) => total + result.imported, 0),
        threadsReconciled: results.reduce((total, result) => total + result.reconciled, 0),
        threadsFailed: results.reduce((total, result) => total + result.failed, 0),
        truncatedPasses: results.reduce((total, result) => total + result.truncated, 0),
      } satisfies NativeCatalogSyncSummary;
    }).pipe(
      Effect.orElseSucceed(
        () =>
          ({
            instancesScanned: 0,
            threadsImported: 0,
            threadsReconciled: 0,
            threadsFailed: 0,
            truncatedPasses: 0,
          }) satisfies NativeCatalogSyncSummary,
      ),
    );

    return NativeCatalogSync.of({ syncOnce });
  });

export const layer = (syncOptions: NativeCatalogSyncOptions) =>
  Layer.effect(NativeCatalogSync, make(syncOptions));
