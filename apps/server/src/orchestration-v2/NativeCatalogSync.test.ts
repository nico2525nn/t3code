import { assert, describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as IdAllocator from "./IdAllocator.ts";
import * as NativeCatalogSync from "./NativeCatalogSync.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import type { ProviderAdapterV2NativeThreadSummary } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { runMigrations } from "../persistence/Migrations.ts";

const DRIVER = ProviderDriverKind.make("codex");
const INSTANCE = ProviderInstanceId.make("codex-default");

const nativeThread = (input: {
  readonly nativeId: string;
  readonly updatedAt: string;
}): ProviderAdapterV2NativeThreadSummary => ({
  nativeId: input.nativeId,
  title: input.nativeId,
  cwd: "/workspace",
  updatedAt: input.updatedAt,
  createdAt: undefined,
  archived: false,
  ephemeral: false,
  active: false,
});

/**
 * A catalog that pages newest-first like App Server does, and can be made to
 * fail so the test can prove a failed pass does not advance the watermark.
 */
const catalogAdapter = (input: {
  readonly threads: ReadonlyArray<ProviderAdapterV2NativeThreadSummary>;
  readonly unavailable: () => boolean;
}) => {
  const reads = { active: 0, archived: 0 };
  return {
    reads,
    adapter: ProviderAdapter.ProviderAdapterV2.of({
      instanceId: INSTANCE,
      driver: DRIVER,
      getCapabilities: () => Effect.die("unused"),
      withNativeCatalog: (use) =>
        use((request) => {
          reads[request.archived ? "archived" : "active"] += 1;
          if (input.unavailable()) {
            return Effect.fail(
              new ProviderAdapter.ProviderAdapterProtocolError({
                driver: DRIVER,
                detail: "catalog unavailable",
              }),
            );
          }
          const rows = request.archived ? [] : input.threads;
          const offset = request.cursor === undefined ? 0 : Number(request.cursor);
          const slice = rows.slice(offset, offset + request.limit);
          const nextOffset = offset + slice.length;
          return Effect.succeed({
            threads: slice,
            nextCursor: nextOffset >= rows.length ? null : String(nextOffset),
          });
        }),
      planSelectionTransition: () => Effect.die("unused"),
      openSession: () => Effect.die("unused"),
    }),
  };
};

const baseLayer = (
  adapter: ProviderAdapter.ProviderAdapterV2Shape,
  launched: string[],
  options?: {
    readonly failNativeThreadId?: () => string | undefined;
    /** Native ids already owned by a T3 thread, keyed by native id. */
    readonly existingOwner?: (nativeThreadId: string) => ThreadId | null;
    /** Titles written onto threads that already existed. */
    readonly reconciled?: string[];
  },
) =>
  NativeCatalogSync.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          get: () => Effect.succeed(adapter),
          list: () => Effect.succeed([INSTANCE]),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: (request) => {
            launched.push(String(request.commandId));
            const nativeId = request.importedNativeThread?.ref.nativeId;
            if (nativeId !== undefined && nativeId === options?.failNativeThreadId?.()) {
              return Effect.fail(
                new NativeCatalogSync.NativeThreadImportError({ nativeThreadId: nativeId }),
              ) as unknown as Effect.Effect<never>;
            }
            return Effect.succeed({
              threadId: request.threadId ?? ThreadId.make("missing"),
              // A catalog import never reads the launch projection.
              projection: null as unknown as OrchestrationV2ThreadProjection,
              resumed: false,
            });
          },
          reconcileImportedThread: (request) => {
            options?.reconciled?.push(request.title);
            return Effect.void;
          },
        }),
        Layer.mock(ProjectService.ProjectService)({
          bootstrap: () =>
            Effect.succeed({
              project: { id: ProjectId.make("project-1") } as never,
              created: false,
            }),
          getByWorkspaceRoot: () => Effect.succeed(Option.none()),
        }),
        IdAllocator.layer,
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          findThreadIdByNativeIdentity: (identity) =>
            Effect.succeed(options?.existingOwner?.(identity.nativeThreadId) ?? null),
        }),
      ),
    ),
    Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
  );

const readWatermarks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly watermark: string | null; readonly archived: number }>`
    SELECT watermark, archived
    FROM orchestration_v2_native_catalog_state
    WHERE driver = ${DRIVER} AND provider_instance_id = ${INSTANCE}
    ORDER BY archived ASC
  `;
});

describe("NativeCatalogSync", () => {
  it("imports the catalog once and then costs one page per pass", async () => {
    const launched: string[] = [];
    const unavailable = { value: false };
    const { adapter, reads } = catalogAdapter({
      threads: [
        nativeThread({ nativeId: "a", updatedAt: "2026-10-05T00:00:00Z" }),
        nativeThread({ nativeId: "b", updatedAt: "2026-10-04T00:00:00Z" }),
      ],
      unavailable: () => unavailable.value,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations({});
        const service = yield* NativeCatalogSync.NativeCatalogSync;
        const first = yield* service.syncOnce;
        const afterFirst = yield* readWatermarks;
        const second = yield* service.syncOnce;
        return { first, second, afterFirst };
      }).pipe(Effect.provide(baseLayer(adapter, launched))),
    );

    expect(result.first.threadsImported).toBe(2);
    // A row sitting exactly on the watermark is re-read every pass, because
    // updated_at is not a unique cursor and a tie must not hide a conversation.
    // The replay is absorbed by the deterministic command id.
    expect(result.second.threadsImported).toBe(1);
    expect(result.first.instancesScanned).toBe(1);
    // The archived partition is empty and completes in one request; nothing is
    // left unfinished.
    expect(result.second.truncatedPasses).toBe(0);

    // Both partitions record a commit point. The archived catalog is empty, so
    // its commit point is "no rows seen", recorded as NULL.
    assert.deepStrictEqual(
      result.afterFirst.map((row) => row.watermark),
      ["2026-10-05T00:00:00Z", null],
    );

    // Re-importing must replay the same command ids so the orchestrator's
    // receipts turn a repeated pass into a no-op.
    expect(launched.length).toBeGreaterThan(2);
    expect(new Set(launched).size).toBe(2);
  });

  it("does not commit the watermark when one row fails to import", async () => {
    const launched: string[] = [];
    const failFor = { nativeThreadId: "b" as string | undefined };
    const adapter = ProviderAdapter.ProviderAdapterV2.of({
      instanceId: INSTANCE,
      driver: DRIVER,
      getCapabilities: () => Effect.die("unused"),
      withNativeCatalog: (use) =>
        use((request) =>
          Effect.succeed({
            threads: request.archived
              ? []
              : [
                  nativeThread({ nativeId: "a", updatedAt: "2026-10-05T00:00:00Z" }),
                  nativeThread({ nativeId: "b", updatedAt: "2026-10-04T00:00:00Z" }),
                  nativeThread({ nativeId: "c", updatedAt: "2026-10-03T00:00:00Z" }),
                ],
            nextCursor: null,
          }),
        ),
      planSelectionTransition: () => Effect.die("unused"),
      openSession: () => Effect.die("unused"),
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations({});
        const service = yield* NativeCatalogSync.NativeCatalogSync;
        const first = yield* service.syncOnce;
        const afterFailure = yield* readWatermarks;
        // The next pass must retry b, and must not duplicate a or c.
        failFor.nativeThreadId = undefined;
        const second = yield* service.syncOnce;
        return { first, second, afterFailure, launched };
      }).pipe(
        Effect.provide(
          baseLayer(adapter, launched, { failNativeThreadId: () => failFor.nativeThreadId }),
        ),
      ),
    );

    expect(result.first.threadsImported).toBe(2);
    expect(result.first.threadsFailed).toBe(1);
    // Nothing committed: b is still ahead of the commit point, so the row the
    // failed pass saw still has no commit above it.
    expect(result.afterFailure.map((row) => row.watermark)).toEqual([null, null]);

    expect(result.second.threadsImported).toBe(3);
    // a and c replay harmlessly; only b had never succeeded.
    expect(result.launched.filter((id) => id.endsWith(":b"))).toHaveLength(2);
    expect(new Set(result.launched).size).toBe(3);
  });

  it("does not import a native conversation a T3 thread already owns", async () => {
    const launched: string[] = [];
    const adapter = ProviderAdapter.ProviderAdapterV2.of({
      instanceId: INSTANCE,
      driver: DRIVER,
      getCapabilities: () => Effect.die("unused"),
      withNativeCatalog: (use) =>
        use((request) =>
          Effect.succeed({
            threads: request.archived
              ? []
              : [
                  nativeThread({ nativeId: "owned", updatedAt: "2026-10-05T00:00:00Z" }),
                  nativeThread({ nativeId: "foreign", updatedAt: "2026-10-04T00:00:00Z" }),
                ],
            nextCursor: null,
          }),
        ),
      planSelectionTransition: () => Effect.die("unused"),
      openSession: () => Effect.die("unused"),
    });

    const reconciled: string[] = [];
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations({});
        const service = yield* NativeCatalogSync.NativeCatalogSync;
        const first = yield* service.syncOnce;
        return { first, launched, reconciled };
      }).pipe(
        Effect.provide(
          baseLayer(adapter, launched, {
            existingOwner: (nativeId) =>
              nativeId === "owned" ? ThreadId.make("thread-existing") : null,
            reconciled,
          }),
        ),
      ),
    );

    // "owned" was created by T3 itself; re-importing it would show the user
    // the same conversation twice.
    expect(result.first.threadsReconciled).toBe(1);
    expect(result.first.threadsImported).toBe(1);
    expect(result.launched).toHaveLength(1);
    expect(result.launched[0]).toContain(":foreign");
    // A rename has to reach the thread that already owns the conversation.
    expect(result.reconciled).toEqual(["owned"]);
  });

  it("keeps the watermark when a pass fails so the next pass still sees the thread", async () => {
    const launched: string[] = [];
    const unavailable = { value: true };
    const { adapter } = catalogAdapter({
      threads: [nativeThread({ nativeId: "a", updatedAt: "2026-10-05T00:00:00Z" })],
      unavailable: () => unavailable.value,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* runMigrations({});
        const service = yield* NativeCatalogSync.NativeCatalogSync;
        const failed = yield* service.syncOnce;
        const afterFailure = yield* readWatermarks;
        unavailable.value = false;
        const recovered = yield* service.syncOnce;
        return { failed, recovered, afterFailure, launched };
      }).pipe(Effect.provide(baseLayer(adapter, launched))),
    );

    expect(result.failed.threadsImported).toBe(0);
    expect(result.failed.threadsFailed).toBe(2);
    // Nothing was read, so nothing may be marked as already imported.
    expect(result.afterFailure).toHaveLength(0);

    expect(result.recovered.threadsImported).toBe(1);
    expect(result.launched).toHaveLength(1);
  });
});
