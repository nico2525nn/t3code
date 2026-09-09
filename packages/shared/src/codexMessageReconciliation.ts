/**
 * Identity helpers for reconciling Codex App Server history with messages
 * already written by T3's live turn path.
 *
 * Codex history uses `import:codex:<thread>:<turn>:<item>` ids while the live
 * provider path uses T3 ids for user messages and `assistant:<item>` ids for
 * assistant messages. The text is the same, but the ids are not, so comparing
 * ids alone creates a second projection row when history catches up later.
 */

export interface CodexMessageIdentity {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
}

const CODEX_HISTORY_MESSAGE_PREFIX = "import:codex:";
const IMPORTED_MESSAGE_PREFIX = "import:";
const USER_MESSAGE_MATCH_WINDOW_MS = 5_000;

export function isCodexHistoryMessageId(messageId: string): boolean {
  return messageId.startsWith(CODEX_HISTORY_MESSAGE_PREFIX);
}

function isImportedMessageId(messageId: string): boolean {
  return messageId.startsWith(IMPORTED_MESSAGE_PREFIX);
}

function nativeItemIdFromCodexHistoryMessageId(messageId: string): string | undefined {
  if (!isCodexHistoryMessageId(messageId)) {
    return undefined;
  }
  const separator = messageId.lastIndexOf(":");
  const itemId = messageId.slice(separator + 1);
  return itemId.length > 0 ? itemId : undefined;
}

function parseTimestamp(value: string): number | undefined {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function isCodexAssistantItemMatch(
  imported: CodexMessageIdentity,
  live: CodexMessageIdentity,
): boolean {
  if (imported.role !== "assistant" || live.role !== "assistant") {
    return false;
  }
  const nativeItemId = nativeItemIdFromCodexHistoryMessageId(imported.messageId);
  if (nativeItemId === undefined) {
    return false;
  }
  return (
    live.messageId === `assistant:${nativeItemId}` ||
    live.messageId.startsWith(`assistant:${nativeItemId}:segment:`)
  );
}

function isCodexUserTimestampMatch(
  imported: CodexMessageIdentity,
  live: CodexMessageIdentity,
): boolean {
  if (imported.role !== "user" || live.role !== "user" || imported.text !== live.text) {
    return false;
  }
  const importedAt = parseTimestamp(imported.createdAt);
  const liveAt = parseTimestamp(live.createdAt);
  return (
    importedAt !== undefined &&
    liveAt !== undefined &&
    Math.abs(importedAt - liveAt) <= USER_MESSAGE_MATCH_WINDOW_MS
  );
}

function isDuplicateCodexHistoryMessage(
  imported: CodexMessageIdentity,
  live: CodexMessageIdentity,
): boolean {
  if (isImportedMessageId(live.messageId) || imported.role !== live.role) {
    return false;
  }
  if (imported.role === "assistant") {
    return isCodexAssistantItemMatch(imported, live) && imported.text === live.text;
  }
  return isCodexUserTimestampMatch(imported, live);
}

/**
 * Returns the rows from one thread with Codex history copies removed when a
 * corresponding live T3 message exists. Matching consumes each live message
 * at most once so two intentional identical prompts remain two messages.
 */
export function dedupeCodexHistoryMessages<T extends CodexMessageIdentity>(
  messages: ReadonlyArray<T>,
): Array<T> {
  const liveMessages = messages.filter((message) => !isImportedMessageId(message.messageId));
  const importedMessages = messages
    .filter((message) => isCodexHistoryMessageId(message.messageId))
    .toSorted(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.messageId.localeCompare(right.messageId),
    );
  const availableLiveMessages = [...liveMessages];
  const duplicateImportedIds = new Set<string>();

  for (const imported of importedMessages) {
    const liveIndex = availableLiveMessages.findIndex((live) =>
      isDuplicateCodexHistoryMessage(imported, live),
    );
    if (liveIndex < 0) {
      continue;
    }
    duplicateImportedIds.add(imported.messageId);
    availableLiveMessages.splice(liveIndex, 1);
  }

  return messages.filter((message) => !duplicateImportedIds.has(message.messageId));
}

/**
 * Checks one incoming history event against the messages already held by a
 * client or projection without requiring the caller to rebuild the list.
 */
export function isDuplicateCodexHistoryMessageForExisting(
  imported: CodexMessageIdentity,
  existingMessages: ReadonlyArray<CodexMessageIdentity>,
): boolean {
  if (!isCodexHistoryMessageId(imported.messageId)) {
    return false;
  }
  return existingMessages.some((existing) => isDuplicateCodexHistoryMessage(imported, existing));
}
