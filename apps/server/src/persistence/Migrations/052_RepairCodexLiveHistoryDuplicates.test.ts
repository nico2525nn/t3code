import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("052_RepairCodexLiveHistoryDuplicates", (it) => {
  it.effect("removes delayed Codex history copies and keeps native turn linkage", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 51 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES
          ('live-user-1', 'thread-1', NULL, 'user', 'same prompt', 0,
            '2026-09-09T08:48:00.200Z', '2026-09-09T08:48:00.200Z'),
          ('import:codex:thread-1:turn-1:user', 'thread-1', 'turn-1', 'user', 'same prompt', 0,
            '2026-09-09T08:53:15.000Z', '2026-09-09T08:53:15.000Z'),
          ('live-user-2', 'thread-1', NULL, 'user', 'same prompt', 0,
            '2026-09-09T08:54:00.200Z', '2026-09-09T08:54:00.200Z'),
          ('import:codex:thread-1:turn-2:user', 'thread-1', 'turn-2', 'user', 'same prompt', 0,
            '2026-09-09T08:55:00.000Z', '2026-09-09T08:55:00.000Z'),
          ('import:codex:thread-1:turn-3:history-only', 'thread-1', 'turn-3', 'user', 'history only', 0,
            '2026-09-09T08:56:00.000Z', '2026-09-09T08:56:00.000Z')
      `;

      yield* runMigrations({ toMigrationInclusive: 52 });

      const rows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
      }>`
        SELECT message_id AS "messageId", turn_id AS "turnId"
        FROM projection_thread_messages
        WHERE thread_id = 'thread-1'
        ORDER BY created_at, message_id
      `;
      assert.deepEqual(rows, [
        { messageId: "live-user-1", turnId: "turn-1" },
        { messageId: "live-user-2", turnId: "turn-2" },
        { messageId: "import:codex:thread-1:turn-3:history-only", turnId: "turn-3" },
      ]);
    }),
  );
});
