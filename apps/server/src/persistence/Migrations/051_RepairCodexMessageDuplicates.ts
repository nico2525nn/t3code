import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { dedupeCodexHistoryMessages } from "@t3tools/shared/codexMessageReconciliation";

interface ProjectionMessageRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

/**
 * Remove only derived projection rows that duplicate a live T3 message.
 *
 * The orchestration event log and Codex's native history remain untouched. The
 * projection can be rebuilt from those sources, and the live reconciliation
 * path now prevents the same pair from being projected again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ProjectionMessageRow>`
    SELECT
      message_id AS "messageId",
      thread_id AS "threadId",
      role,
      text,
      created_at AS "createdAt"
    FROM projection_thread_messages
    ORDER BY thread_id ASC, created_at ASC, message_id ASC
  `;

  const rowsByThread = new Map<string, Array<ProjectionMessageRow>>();
  for (const row of rows) {
    const threadRows = rowsByThread.get(row.threadId) ?? [];
    threadRows.push(row);
    rowsByThread.set(row.threadId, threadRows);
  }

  const duplicateMessageIds: string[] = [];
  for (const threadRows of rowsByThread.values()) {
    const retainedIds = new Set(dedupeCodexHistoryMessages(threadRows).map((row) => row.messageId));
    for (const row of threadRows) {
      if (row.messageId.startsWith("import:codex:") && !retainedIds.has(row.messageId)) {
        duplicateMessageIds.push(row.messageId);
      }
    }
  }

  yield* Effect.forEach(
    duplicateMessageIds,
    (messageId) => sql`DELETE FROM projection_thread_messages WHERE message_id = ${messageId}`,
    { concurrency: 1 },
  );
});
