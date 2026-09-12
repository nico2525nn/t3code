/**
 * Identity helpers for reconciling Codex App Server history with messages
 * already written by T3's live turn path.
 *
 * Codex history uses `import:codex:<thread>:<turn>:<item>` ids while the live
 * provider path uses T3 ids for user messages and `assistant:<item>` ids for
 * assistant messages. The text is normally the same, but an old duplicate
 * bridge could make the live text incomplete or doubled, so comparing ids
 * alone creates a second projection row when history catches up later.
 */

export interface CodexMessageIdentity {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly createdAt: string;
  readonly turnId?: string | null;
  readonly phase?: string | undefined;
  readonly streaming?: boolean | undefined;
}

const CODEX_HISTORY_MESSAGE_PREFIX = "import:codex:";
const IMPORTED_MESSAGE_PREFIX = "import:";
// A live T3 message can be written before the corresponding Codex
// `UserMessage` reaches the durable App Server history. In particular, a
// long-running turn can make the history item appear several minutes after
// the live row. Keep the match bounded so repeated prompts are still
// consumed one-to-one rather than deduped wholesale.
const USER_MESSAGE_MATCH_WINDOW_MS = 10 * 60_000;

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

export function codexLiveMessageIdFromCodexHistoryMessageId(messageId: string): string | undefined {
  const nativeItemId = nativeItemIdFromCodexHistoryMessageId(messageId);
  return nativeItemId === undefined ? undefined : "assistant:" + nativeItemId;
}

/**
 * Recover the native turn embedded in a Codex history message id.
 *
 * Older T3 imports persisted a null `turnId` in the event payload even though
 * the canonical id already contained the turn. Keeping this parser next to
 * the other history-id helpers lets a projection repair recover that durable
 * association without changing the event log.
 */
export function codexTurnIdFromCodexHistoryMessageId(messageId: string): string | undefined {
  if (!isCodexHistoryMessageId(messageId)) {
    return undefined;
  }
  const remainder = messageId.slice(CODEX_HISTORY_MESSAGE_PREFIX.length);
  const threadSeparator = remainder.indexOf(":");
  const turnSeparator = remainder.indexOf(":", threadSeparator + 1);
  if (threadSeparator < 1 || turnSeparator <= threadSeparator + 1) {
    return undefined;
  }
  const turnId = remainder.slice(threadSeparator + 1, turnSeparator);
  return turnId.length > 0 ? turnId : undefined;
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

/**
 * Match an assistant history item to every live representation of that same
 * native item, even when the live text is incomplete or was duplicated by an
 * older second App Server bridge. Text equality is intentionally not part of
 * this identity: the native item id is the stable key and the history item is
 * the authoritative completed text.
 */
export function findCodexHistoryAssistantItemMatches<T extends CodexMessageIdentity>(
  imported: CodexMessageIdentity,
  existingMessages: ReadonlyArray<T>,
): Array<T> {
  if (!isCodexHistoryMessageId(imported.messageId) || imported.role !== "assistant") {
    return [];
  }
  return existingMessages
    .filter(
      (existing) =>
        !isImportedMessageId(existing.messageId) && isCodexAssistantItemMatch(imported, existing),
    )
    .toSorted((left, right) => {
      const nativeItemId = nativeItemIdFromCodexHistoryMessageId(imported.messageId);
      const baseId = nativeItemId === undefined ? "" : `assistant:${nativeItemId}`;
      return (
        Number(left.messageId !== baseId) - Number(right.messageId !== baseId) ||
        left.messageId.localeCompare(right.messageId)
      );
    });
}

function isCodexUserTimestampMatch(
  imported: CodexMessageIdentity,
  live: CodexMessageIdentity,
): boolean {
  if (imported.role !== "user" || live.role !== "user" || imported.text !== live.text) {
    return false;
  }
  if (
    imported.turnId !== undefined &&
    imported.turnId !== null &&
    live.turnId !== undefined &&
    live.turnId !== null
  ) {
    return imported.turnId === live.turnId;
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
 * Return the live row that is the corresponding copy of an imported history
 * row, if one exists. Callers that merge the two representations can preserve
 * the live message id while adopting the native turn id.
 */
export function findCodexHistoryMessageMatchForExisting<T extends CodexMessageIdentity>(
  imported: CodexMessageIdentity,
  existingMessages: ReadonlyArray<T>,
): T | undefined {
  if (!isCodexHistoryMessageId(imported.messageId)) {
    return undefined;
  }
  return existingMessages.find((existing) => isDuplicateCodexHistoryMessage(imported, existing));
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
 * Reconcile the durable Codex item with all live rows for the same native
 * assistant item. The old bridge could stream the same item twice, producing
 * a live row whose text is an interleaved/doubled version of the native
 * history row. Keep the stable live id (so turn/checkpoint references remain
 * usable), replace its text/identity fields with the native completed item,
 * and remove the imported and extra live representations.
 *
 * User messages still use `dedupeCodexHistoryMessages`'s one-to-one,
 * timestamp-bounded matching, so intentionally repeated prompts are retained.
 */
export function reconcileCodexHistoryMessages<T extends CodexMessageIdentity>(
  messages: ReadonlyArray<T>,
): Array<T> {
  // Do the native-item pass before text-based dedupe. A duplicated live
  // stream can contain one clean segment and one doubled base row; running
  // the old exact-text matcher first would consume the history row using the
  // segment and leave the doubled base row behind.
  const result = [...messages];
  const removedIndexes = new Set<number>();

  for (let importedIndex = 0; importedIndex < result.length; importedIndex += 1) {
    if (removedIndexes.has(importedIndex)) {
      continue;
    }
    const imported = result[importedIndex]!;
    if (!isCodexHistoryMessageId(imported.messageId) || imported.role !== "assistant") {
      continue;
    }

    const matches = findCodexHistoryAssistantItemMatches(imported, result).filter(
      (candidate) => candidate.messageId !== imported.messageId,
    );
    if (matches.length === 0) {
      continue;
    }

    const canonical = matches[0]!;
    const canonicalIndex = result.findIndex((message) => message.messageId === canonical.messageId);
    if (canonicalIndex < 0) {
      continue;
    }
    result[canonicalIndex] = {
      ...canonical,
      text: imported.text,
      createdAt: imported.createdAt,
      turnId: imported.turnId ?? canonical.turnId,
      ...(imported.phase !== undefined ? { phase: imported.phase } : {}),
      ...(imported.streaming !== undefined ? { streaming: imported.streaming } : {}),
    } as T;
    removedIndexes.add(importedIndex);
    for (const match of matches) {
      if (match.messageId === canonical.messageId) {
        continue;
      }
      const duplicateIndex = result.findIndex((message) => message.messageId === match.messageId);
      if (duplicateIndex >= 0) {
        removedIndexes.add(duplicateIndex);
      }
    }
  }

  return dedupeCodexHistoryMessages(result.filter((_, index) => !removedIndexes.has(index)));
}

/**
 * Checks one incoming history event against the messages already held by a
 * client or projection without requiring the caller to rebuild the list.
 */
export function isDuplicateCodexHistoryMessageForExisting(
  imported: CodexMessageIdentity,
  existingMessages: ReadonlyArray<CodexMessageIdentity>,
): boolean {
  return findCodexHistoryMessageMatchForExisting(imported, existingMessages) !== undefined;
}

/**
 * Returns existing Codex history rows that are the same message as one newly
 * received live T3 row. This is the reverse-order counterpart to
 * `isDuplicateCodexHistoryMessageForExisting`: history can arrive first, so
 * the live event must be able to remove the already-projected copy too.
 */
export function findCodexHistoryMessagesDuplicatedByLiveMessage<T extends CodexMessageIdentity>(
  live: CodexMessageIdentity,
  existingMessages: ReadonlyArray<T>,
): Array<T["messageId"]> {
  if (isImportedMessageId(live.messageId)) {
    return [];
  }

  return existingMessages
    .filter(
      (existing) =>
        isCodexHistoryMessageId(existing.messageId) &&
        isDuplicateCodexHistoryMessage(existing, live),
    )
    .map((existing) => existing.messageId);
}
