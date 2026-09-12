import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";

it.layer(NodeSqliteClient.layerMemory())("053_RepairCodexLiveMessageTurnIds", (it) => {
  it.effect("recovers the native turn from an older imported message id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 52 });

      yield* sql`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, is_streaming, created_at, updated_at
        )
        VALUES (
          'live-user-1', 'thread-1', NULL, 'user', 'same prompt', 0,
          '2026-09-10T02:51:46.681Z', '2026-09-10T02:51:46.681Z'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-import-1', 'thread', 'thread-1', 1, 'thread.message-sent',
          '2026-09-10T02:51:50.797Z', 'system',
          ${JSON.stringify({
            threadId: "thread-1",
            messageId: "import:codex:thread-1:turn-native:user-item",
            role: "user",
            text: "same prompt",
            turnId: null,
            createdAt: "2026-09-10T02:51:50.797Z",
          })}, '{}'
        )
      `;

      yield* runMigrations({ toMigrationInclusive: 53 });

      const rows = yield* sql<{
        readonly messageId: string;
        readonly turnId: string | null;
      }>`
        SELECT message_id AS "messageId", turn_id AS "turnId"
        FROM projection_thread_messages
        WHERE thread_id = 'thread-1'
      `;
      assert.deepEqual(rows, [{ messageId: "live-user-1", turnId: "turn-native" }]);
    }),
  );
});
