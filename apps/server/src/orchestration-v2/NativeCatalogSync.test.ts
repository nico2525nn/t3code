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

const baseLayer = (adapter: ProviderAdapter.ProviderAdapterV2Shape, launched: string[]) =>
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
            return Effect.succeed({
              threadId: request.threadId ?? ThreadId.make("missing"),
              // A catalog import never reads the launch projection.
              projection: null as unknown as OrchestrationV2ThreadProjection,
              resumed: false,
            });
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
    expect(result.second.threadsImported).toBe(0);
    expect(result.first.instancesScanned).toBe(1);
    expect(result.second.truncatedPasses).toBe(0);

    // The watermark is the provider clock. An empty archived catalog has
    // nothing to record, so only the split that was actually read gets a row.
    assert.deepStrictEqual(
      result.afterFirst.map((row) => row.watermark),
      ["2026-10-05T00:00:00Z"],
    );

    // Re-importing must replay the same command ids so the orchestrator's
    // receipts turn a repeated pass into a no-op.
    expect(launched).toHaveLength(2);
    expect(new Set(launched).size).toBe(2);
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
