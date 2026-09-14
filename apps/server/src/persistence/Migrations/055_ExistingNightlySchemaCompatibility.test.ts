import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("055_ExistingNightlySchemaCompatibility", (it) => {
  it.effect("repairs schemas hidden by released Nightly migration ids", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 49 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES
          (50, 'CheckpointDiffBlobStatus'),
          (51, 'RepairCodexMessageDuplicates'),
          (52, 'RepairCodexLiveHistoryDuplicates'),
          (53, 'RepairCodexLiveMessageTurnIds'),
          (54, 'ProjectionThreadMessagePhase')
      `;

      yield* runMigrations();

      const pullRequestTable = yield* sql<{ readonly name: string }>`
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'projection_thread_pull_requests'
      `;
      const messageColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_thread_messages)
      `;
      const repairedMigration = yield* sql<{ readonly migrationId: number }>`
        SELECT migration_id AS "migrationId"
        FROM effect_sql_migrations
        WHERE migration_id = 55
      `;

      assert.equal(pullRequestTable.length, 1);
      assert.ok(messageColumns.some((column) => column.name === "context_json"));
      assert.deepStrictEqual(repairedMigration, [{ migrationId: 55 }]);
    }),
  );
});
