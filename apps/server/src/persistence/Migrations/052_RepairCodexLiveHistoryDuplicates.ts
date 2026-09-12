import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  dedupeCodexHistoryMessages,
  findCodexHistoryMessageMatchForExisting,
  isCodexHistoryMessageId,
} from "@t3tools/shared/codexMessageReconciliation";

interface ProjectionMessageRow {
  readonly messageId: string;
  readonly threadId: string;
  readonly turnId: string | null;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

/**
 * Repair the second copy created when a Codex live message arrived before its
 * App Server history item.
 *
 * Migration 051 handled the short-delay case. A long-running native turn can
 * leave the live row several minutes ahead of the imported row, so those
 * copies survived until the broader bounded matcher was added. Keep the
 * orchestration event log and native rollout immutable; only the derived
 * message projection is repaired here.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ProjectionMessageRow>`
    SELECT
      message_id AS "messageId",
      thread_id AS "threadId",
      turn_id AS "turnId",
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

  for (const threadRows of rowsByThread.values()) {
    const liveRows = threadRows.filter((row) => !row.messageId.startsWith("import:"));
    const availableLiveRows = [...liveRows];
    const retainedIds = new Set(dedupeCodexHistoryMessages(threadRows).map((row) => row.messageId));
    const duplicateImportedRows = threadRows.filter(
      (row) => isCodexHistoryMessageId(row.messageId) && !retainedIds.has(row.messageId),
    );

    for (const imported of duplicateImportedRows) {
      const live = findCodexHistoryMessageMatchForExisting(imported, availableLiveRows);
      if (live?.messageId !== undefined && imported.turnId !== null) {
        // The live id remains authoritative for the command/event path, but
        // it should still participate in native turn-based rendering.
        yield* sql`
          UPDATE projection_thread_messages
          SET turn_id = COALESCE(turn_id, ${imported.turnId})
          WHERE message_id = ${live.messageId}
        `;
      }
      if (live !== undefined) {
        const liveIndex = availableLiveRows.findIndex((row) => row.messageId === live.messageId);
        if (liveIndex >= 0) {
          availableLiveRows.splice(liveIndex, 1);
        }
      }
      yield* sql`
        DELETE FROM projection_thread_messages
        WHERE message_id = ${imported.messageId}
      `;
    }
  }
});
