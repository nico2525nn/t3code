import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  codexTurnIdFromCodexHistoryMessageId,
  findCodexHistoryMessageMatchForExisting,
  isCodexHistoryMessageId,
  type CodexMessageIdentity,
} from "@t3tools/shared/codexMessageReconciliation";

interface ProjectionMessageRow extends CodexMessageIdentity {
  readonly threadId: string;
  readonly turnId: string | null;
}

interface EventRow {
  readonly threadId: string;
  readonly payloadJson: string;
}

function readHistoryMessage(
  row: EventRow,
): (CodexMessageIdentity & { readonly threadId: string; readonly turnId: string }) | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payloadJson);
  } catch {
    return undefined;
  }
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return undefined;
  }
  const value = payload as Record<string, unknown>;
  const messageId = typeof value.messageId === "string" ? value.messageId : undefined;
  const role = value.role === "user" || value.role === "assistant" ? value.role : undefined;
  const text = typeof value.text === "string" ? value.text : undefined;
  const createdAt = typeof value.createdAt === "string" ? value.createdAt : undefined;
  const turnId =
    typeof value.turnId === "string" && value.turnId.length > 0
      ? value.turnId
      : messageId === undefined
        ? undefined
        : codexTurnIdFromCodexHistoryMessageId(messageId);
  if (
    messageId === undefined ||
    !isCodexHistoryMessageId(messageId) ||
    role === undefined ||
    text === undefined ||
    createdAt === undefined ||
    turnId === undefined
  ) {
    return undefined;
  }
  return { messageId, role, text, createdAt, turnId, threadId: row.threadId };
}

/**
 * Restore native turn associations on live rows that survived migration 052.
 *
 * The first history bridge wrote imported `thread.message-sent` events with a
 * null turnId. Later bridge passes corrected the imported event, but the
 * duplicate projection row was removed in favor of the live T3 row. The
 * canonical imported id still contains the native turn, so this migration
 * repairs only the derived `turn_id` column and leaves the event log intact.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projectedRows = yield* sql<ProjectionMessageRow>`
    SELECT
      message_id AS "messageId",
      thread_id AS "threadId",
      turn_id AS "turnId",
      role,
      text,
      created_at AS "createdAt"
    FROM projection_thread_messages
    WHERE turn_id IS NULL
      AND message_id NOT LIKE 'import:%'
    ORDER BY thread_id ASC, created_at ASC, message_id ASC
  `;
  const events = yield* sql<EventRow>`
    SELECT
      stream_id AS "threadId",
      payload_json AS "payloadJson"
    FROM orchestration_events
    WHERE event_type = 'thread.message-sent'
      AND payload_json LIKE '%import:codex:%'
    ORDER BY sequence ASC
  `;

  const availableByThread = new Map<string, Array<ProjectionMessageRow>>();
  for (const row of projectedRows) {
    const available = availableByThread.get(row.threadId) ?? [];
    available.push(row);
    availableByThread.set(row.threadId, available);
  }

  for (const event of events) {
    const imported = readHistoryMessage(event);
    if (imported === undefined) {
      continue;
    }
    const available = availableByThread.get(imported.threadId);
    if (available === undefined || available.length === 0) {
      continue;
    }
    const live = findCodexHistoryMessageMatchForExisting(imported, available);
    if (live === undefined) {
      continue;
    }
    yield* sql`
      UPDATE projection_thread_messages
      SET turn_id = ${imported.turnId}
      WHERE thread_id = ${imported.threadId}
        AND message_id = ${live.messageId}
        AND turn_id IS NULL
    `;
    const liveIndex = available.findIndex((row) => row.messageId === live.messageId);
    if (liveIndex >= 0) {
      available.splice(liveIndex, 1);
    }
  }
});
