import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("051_RepairCodexMessageDuplicates", (it) => {
  it.effect("removes only Codex history rows that duplicate live T3 rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 50 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES
          ('live-user-1', 'thread-1', NULL, 'user', 'same prompt', 0,
            '2026-09-09T08:48:00.200Z', '2026-09-09T08:48:00.200Z'),
          ('import:codex:thread-1:turn-1:user', 'thread-1', NULL, 'user', 'same prompt', 0,
            '2026-09-09T08:48:00.000Z', '2026-09-09T08:48:00.000Z'),
          ('assistant:item-1', 'thread-1', 'turn-1', 'assistant', 'same answer', 0,
            '2026-09-09T08:48:40.000Z', '2026-09-09T08:48:40.000Z'),
          ('import:codex:thread-1:turn-1:item-1', 'thread-1', NULL, 'assistant', 'same answer', 0,
            '2026-09-09T08:48:32.000Z', '2026-09-09T08:48:32.000Z'),
          ('import:codex:thread-1:turn-2:item-only', 'thread-1', NULL, 'assistant', 'history only', 0,
            '2026-09-09T08:49:32.000Z', '2026-09-09T08:49:32.000Z'),
          ('import:claude:thread-1:turn-1:user', 'thread-1', NULL, 'user', 'same prompt', 0,
            '2026-09-09T08:48:00.000Z', '2026-09-09T08:48:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 51 });

      const rows = yield* sql<{ readonly messageId: string }>`
        SELECT message_id AS "messageId"
        FROM projection_thread_messages
        WHERE thread_id = 'thread-1'
        ORDER BY message_id
      `;
      assert.deepEqual(
        rows.map((row) => row.messageId),
        [
          "assistant:item-1",
          "import:claude:thread-1:turn-1:user",
          "import:codex:thread-1:turn-2:item-only",
          "live-user-1",
        ],
      );
    }),
  );
});
