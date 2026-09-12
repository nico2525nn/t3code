import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("054_ProjectionThreadMessagePhase", (it) => {
  it.effect("adds a nullable phase column for existing message projections", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 53 });
      yield* runMigrations({ toMigrationInclusive: 54 });

      const columns = yield* sql<{ readonly name: string; readonly notNull: number }>`
        SELECT name, "notnull" AS "notNull"
        FROM pragma_table_info('projection_thread_messages')
      `;
      const phase = columns.find((column) => column.name === "phase");
      assert.deepEqual(phase, { name: "phase", notNull: 0 });
    }),
  );
});
