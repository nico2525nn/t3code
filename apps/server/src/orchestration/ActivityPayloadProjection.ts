import { MessageId } from "@t3tools/contracts";
import type {
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import {
  codexLiveMessageIdFromCodexHistoryMessageId,
  isCodexHistoryMessageId,
  reconcileCodexHistoryMessages,
} from "@t3tools/shared/codexMessageReconciliation";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { projectCodexNativeActivities } from "./CodexNativeActivityProjection.ts";

/**
 * Keep the snapshot contract canonical even when an older projection or a
 * partially rebuilt cache contains both the live T3 row and its Codex history
 * copy. The normal projector already prevents this for new writes, but this
 * is the last server-side boundary before an unchanged client renders data.
 * Exact ids are also collapsed because an interrupted import can leave the
 * same immutable event in a replayed snapshot more than once.
 */
function normalizeThreadMessagesForWire(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  const uniqueMessages: Array<OrchestrationMessage> = [];
  const indexById = new Map<string, number>();

  for (const message of messages) {
    const id = String(message.id);
    const existingIndex = indexById.get(id);
    if (existingIndex === undefined) {
      indexById.set(id, uniqueMessages.length);
      uniqueMessages.push(message);
      continue;
    }

    const existing = uniqueMessages[existingIndex]!;
    const preferred = existing.streaming && !message.streaming ? message : existing;
    const other = preferred === existing ? message : existing;
    uniqueMessages[existingIndex] = {
      ...preferred,
      text: preferred.text.length >= other.text.length ? preferred.text : other.text,
      turnId: preferred.turnId ?? other.turnId,
      ...(preferred.phase === undefined && other.phase !== undefined ? { phase: other.phase } : {}),
      ...(preferred.attachments === undefined && other.attachments !== undefined
        ? { attachments: other.attachments }
        : {}),
      updatedAt:
        preferred.updatedAt.localeCompare(other.updatedAt) >= 0
          ? preferred.updatedAt
          : other.updatedAt,
    };
  }

  const reconciled = reconcileCodexHistoryMessages(
    uniqueMessages.map((message) => ({
      messageId: String(message.id),
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
      turnId: message.turnId,
      phase: message.phase,
      streaming: message.streaming,
    })),
  );
  const reconciledById = new Map(
    reconciled.map((message) => [message.messageId, message] as const),
  );
  return uniqueMessages.flatMap((message) => {
    const reconciledMessage = reconciledById.get(String(message.id));
    if (reconciledMessage === undefined) {
      return [];
    }
    return [
      {
        ...message,
        text: reconciledMessage.text,
        createdAt: reconciledMessage.createdAt,
        turnId: reconciledMessage.turnId ?? message.turnId,
        streaming: reconciledMessage.streaming ?? message.streaming,
        ...(reconciledMessage.phase !== undefined ? { phase: reconciledMessage.phase } : {}),
      },
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }

  const aggregatedOutput = asTrimmedString(item.aggregatedOutput);
  if (aggregatedOutput) {
    const summary = summarizeToolTextOutput(aggregatedOutput);
    if (summary) {
      projectedItem.aggregatedOutput = summary;
    }
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result) {
    const projectedResult: Record<string, unknown> = {};
    if ("command" in result) {
      projectedResult.command = result.command;
    }
    const content = asTrimmedString(result.content);
    if (content) {
      const summary = summarizeToolTextOutput(content);
      if (summary) {
        projectedResult.content = summary;
      }
    }
    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function projectCommandValue(data: Record<string, unknown>): unknown {
  if (data.command !== undefined) {
    return data.command;
  }

  const input = asRecord(data.input);
  if (input?.command !== undefined) {
    return input.command;
  }

  const stateInput = asRecord(asRecord(data.state)?.input);
  if (stateInput?.command !== undefined) {
    return stateInput.command;
  }

  return undefined;
}

function projectViewedImagePath(data: Record<string, unknown>): string | undefined {
  const directPath = asTrimmedString(data.imagePath);
  if (directPath && isWorkspaceImagePreviewPath(directPath)) {
    return directPath;
  }

  const toolName = asTrimmedString(data.toolName)?.toLowerCase();
  if (toolName !== "read" && toolName !== "read file") {
    return undefined;
  }
  const input = asRecord(data.input);
  const inputPath = asTrimmedString(input?.file_path) ?? asTrimmedString(input?.path);
  return inputPath && isWorkspaceImagePreviewPath(inputPath) ? inputPath : undefined;
}

function summarizeToolTextOutput(value: string): string | null {
  let meaningfulLineCount = 0;
  let offset = 0;

  while (offset <= value.length) {
    const newlineIndex = value.indexOf("\n", offset);
    const lineEnd = newlineIndex === -1 ? value.length : newlineIndex;
    const line = value.slice(offset, lineEnd).replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      meaningfulLineCount += 1;
      if (line !== "```") {
        const summary = line.length <= 84 ? line : `${line.slice(0, 83).trimEnd()}…`;
        // V8 can retain the full tool output behind a short sliced string.
        // Join a tiny character array so the returned preview owns its bytes.
        return Array.from(summary).join("");
      }
    }
    if (newlineIndex === -1) {
      break;
    }
    offset = newlineIndex + 1;
  }

  return meaningfulLineCount > 1 ? `${meaningfulLineCount.toLocaleString()} lines` : null;
}

/**
 * Fields of an MCP tool-call item both clients render in the expanded
 * work-log row. Everything else — notably `result`, which carries the full
 * tool output and dominates wire size on MCP-heavy threads — is summarized
 * or dropped. Full payloads remain in persistence.
 */
const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

/**
 * Pulls renderable text out of an MCP tool result: either a Codex-style
 * `{content: [{type: "text", text}, ...]}` record or a raw Claude
 * `tool_result` block whose `content` is a string or block array.
 */
function extractMcpResultText(result: unknown): string | null {
  const record = asRecord(result);
  if (!record) {
    return typeof result === "string" ? result : null;
  }
  if (typeof record.content === "string") {
    return record.content;
  }
  if (Array.isArray(record.content)) {
    const texts: string[] = [];
    for (const entry of record.content) {
      const text = asRecord(entry)?.text;
      if (typeof text === "string" && text.trim().length > 0) {
        texts.push(text);
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }
  return null;
}

function summarizeMcpResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const text = extractMcpResultText(result);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

/**
 * MCP tool calls carry full tool results (`data.item.result` on Codex,
 * `data.result` on Claude/OpenCode) that used to bypass slimming entirely to
 * keep the expanded-row UI working. Keep the fields the UI actually renders
 * and summarize the result like regular tool output.
 */
function projectMcpToolCallData(data: Record<string, unknown>): Record<string, unknown> {
  const projectedData: Record<string, unknown> = {};

  const item = asRecord(data.item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) {
        projectedItem[key] = item[key];
      }
    }
    const result = summarizeMcpResult(item.result);
    if (result) {
      projectedItem.result = result;
    }
    projectedData.item = projectedItem;
  }

  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }
  if ("input" in data) {
    projectedData.input = data.input;
  }
  if (!item) {
    const result = summarizeMcpResult(data.result);
    if (result) {
      projectedData.result = result;
    }
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  return projectedData;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const direct = asTrimmedString(value);
  if (direct) {
    const summary = summarizeToolTextOutput(direct);
    return summary ? { content: summary } : undefined;
  }

  const rawOutput = asRecord(value);
  if (!rawOutput) {
    return undefined;
  }

  if (typeof rawOutput.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }

  const content = asTrimmedString(rawOutput.content);
  if (content) {
    const summary = summarizeToolTextOutput(content);
    return summary ? { content: summary } : undefined;
  }

  const stdout = asTrimmedString(rawOutput.stdout);
  if (stdout) {
    const summary = summarizeToolTextOutput(stdout);
    return summary ? { content: summary } : undefined;
  }

  const stderr = asTrimmedString(rawOutput.stderr);
  if (stderr) {
    const summary = summarizeToolTextOutput(stderr);
    return summary ? { content: summary } : undefined;
  }

  return undefined;
}

function projectAcpContent(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const text = value
    .map((entryValue) => {
      const entry = asRecord(entryValue);
      const content = asRecord(entry?.content);
      return entry?.type === "content" && content?.type === "text"
        ? asTrimmedString(content.text)
        : null;
    })
    .filter((entry): entry is string => entry !== null)
    .join("\n");
  const summary = summarizeToolTextOutput(text);
  return summary ? { content: summary } : undefined;
}

/**
 * Removes activity payload fields that no current client reads while retaining
 * the full payload in persistence and the event store.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) {
    return activity;
  }

  const itemStatus = asRecord(data.item)?.status;
  const projectedPayload =
    payload.status === "completed" && (itemStatus === "failed" || itemStatus === "declined")
      ? { ...payload, status: itemStatus }
      : payload;

  if (payload.itemType === "mcp_tool_call") {
    return {
      ...activity,
      payload: {
        ...projectedPayload,
        data: projectMcpToolCallData(data),
      },
    };
  }

  const projectedData: Record<string, unknown> = {};
  const item = projectCommandData(data);
  if (item) {
    projectedData.item = item;
  }
  const command = projectCommandValue(data);
  if (command !== undefined) {
    projectedData.command = command;
  }
  const imagePath = projectViewedImagePath(data);
  if (imagePath) {
    projectedData.imagePath = imagePath;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    // Both clients discover file names by walking objects with path-like keys.
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }
  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }

  const rawOutput =
    projectRawOutput(data.rawOutput) ??
    projectAcpContent(data.content) ??
    (payload.itemType === "command_execution" ? summarizeMcpResult(data.result) : undefined);
  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  return {
    ...activity,
    payload: {
      ...projectedPayload,
      data: projectedData,
    },
  };
}

/**
 * Matches the validity rule in the web client's
 * `deriveLatestContextWindowSnapshot`: rows without a finite, non-negative
 * `usedTokens` are skipped during its backward walk, so they must not shadow
 * an earlier resolvable row here.
 */
function isResolvableContextWindowActivity(activity: OrchestrationThreadActivity): boolean {
  if (activity.kind !== "context-window.updated") {
    return false;
  }
  const payload = asRecord(activity.payload);
  const usedTokens = payload?.usedTokens;
  return typeof usedTokens === "number" && Number.isFinite(usedTokens) && usedTokens >= 0;
}

/**
 * Drops all but the last resolvable context-window activity per turn from a
 * snapshot. Clients only ever read the latest usage value (walking the array
 * backwards), so shipping the full history — often thousands of rows on long
 * threads — buys nothing. Retention is per turn rather than per thread because
 * a live `thread.reverted` makes the client discard whole turns; keeping each
 * turn's latest row means the meter can still resolve a value from the turns
 * that survive. Malformed rows pass through untouched rather than shadowing a
 * valid earlier row. Live `thread.activity-appended` events are untouched:
 * newer updates still stream through and supersede the retained rows on the
 * client.
 */
function dropStaleContextWindowActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const latestIndexByTurn = new Map<string | null, number>();
  for (let index = 0; index < activities.length; index += 1) {
    if (isResolvableContextWindowActivity(activities[index]!)) {
      latestIndexByTurn.set(activities[index]!.turnId, index);
    }
  }
  if (latestIndexByTurn.size === 0) {
    return activities;
  }
  return activities.filter(
    (activity, index) =>
      !isResolvableContextWindowActivity(activity) ||
      latestIndexByTurn.get(activity.turnId) === index,
  );
}

/**
 * Identity used to retain only the newest lifecycle row for each call in a
 * thread snapshot. Prefer the runtime item id, then the legacy nested id, and
 * finally the itemType/title/detail triple. Rows without any identity remain
 * untouched.
 */
function toolLifecycleIdentity(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  if (!payload) {
    return null;
  }

  const toolCallId =
    asTrimmedString(payload.toolCallId) ?? asTrimmedString(asRecord(payload.data)?.toolCallId);
  if (toolCallId) {
    return `id:${toolCallId}`;
  }

  const itemType = asTrimmedString(payload.itemType) ?? "";
  // Mirrors the clients' `normalizeCompactToolLabel`: a completion's title may
  // gain a trailing "complete"/"completed" the in-flight updates lack.
  const label = (asTrimmedString(payload.title) ?? activity.summary)
    .replace(/\s+(?:complete|completed)\s*$/iu, "")
    .trim();
  const detail = asTrimmedString(payload.detail) ?? "";
  if (itemType.length === 0 && label.length === 0 && detail.length === 0) {
    return null;
  }
  return [itemType, label, detail].join("");
}

/**
 * Drops `tool.updated` rows a `tool.completed` row already supersedes. An
 * update is the in-flight snapshot of a call; once the call completes, the
 * completion carries the final state and the clients fold every matching
 * update into it, so shipping the updates buys nothing — 47k such rows exist
 * in one real database, and a single thread carries 2,291 of them totalling
 * ~1MB post-slimming.
 *
 * Matching is per turn for the same reason `dropStaleContextWindowActivities`
 * retains per turn: a live `thread.reverted` makes the client discard whole
 * turns, so a completion in a different turn could vanish and leave the
 * dropped update unrepresented. The completion must also come *after* the
 * update within the turn — a later update belongs to a subsequent call that
 * reuses the same identity and is still in flight. Rows without a lifecycle
 * identity pass through, matching the clients, which never collapse them.
 * Deliberate divergence from client collapse: clients fold only *adjacent*
 * lifecycle rows, so a superseded update separated from its completion by an
 * interleaved parallel call renders as its own row today, and this drop
 * removes it. Measured against a real database, that affects 1.5% of dropped
 * rows (553 of 36,581), all pure in-flight state whose final result the
 * retained completion still shows. Dropping them is intentional; matching
 * adjacency server-side would forfeit most of the win for parallel-heavy
 * threads, which are exactly the heavy ones. Superseding completions always
 * carry a payload superset of their updates (verified across all 49,515
 * update rows: zero dropped rows held a client-merged field — detail, title,
 * command, item, kind, files — their completion lacked), so no expanded-row
 * content is lost.
 */
function dropSupersededToolUpdatedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const completionIndicesByKey = new Map<string, number[]>();
  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.kind !== "tool.completed") {
      continue;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      continue;
    }
    const key = `${activity.turnId ?? ""}\u0000${identity}`;
    const indices = completionIndicesByKey.get(key);
    if (indices) {
      indices.push(index);
    } else {
      completionIndicesByKey.set(key, [index]);
    }
  }
  if (completionIndicesByKey.size === 0) {
    return activities;
  }

  return activities.filter((activity, index) => {
    if (activity.kind !== "tool.updated") {
      return true;
    }
    const identity = toolLifecycleIdentity(activity);
    if (!identity) {
      return true;
    }
    const indices = completionIndicesByKey.get(`${activity.turnId ?? ""}\u0000${identity}`);
    return !indices?.some((completionIndex) => completionIndex > index);
  });
}

function toolCallId(activity: OrchestrationThreadActivity): string | null {
  const payload = asRecord(activity.payload);
  return (
    asTrimmedString(payload?.toolCallId) ?? asTrimmedString(asRecord(payload?.data)?.toolCallId)
  );
}

/**
 * A previous Codex/T3 bridge could persist the same completed item twice under
 * two event ids. The provider call id is the stable identity, so collapse only
 * duplicate completion rows at the server projection boundary. In-progress
 * updates are intentionally left alone: they are a lifecycle stream and are
 * handled by the supersession pass above.
 */
function dropDuplicateToolCompletedActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const bestIndexByToolCallId = new Map<string, number>();
  const dropped = new Set<number>();

  for (let index = 0; index < activities.length; index += 1) {
    const activity = activities[index]!;
    if (activity.kind !== "tool.completed") {
      continue;
    }
    const id = toolCallId(activity);
    if (id === null) {
      continue;
    }
    const previousIndex = bestIndexByToolCallId.get(id);
    if (previousIndex === undefined) {
      bestIndexByToolCallId.set(id, index);
      continue;
    }

    const previous = activities[previousIndex]!;
    const previousSize = JSON.stringify(previous.payload).length;
    const currentSize = JSON.stringify(activity.payload).length;
    if (
      currentSize > previousSize ||
      (currentSize === previousSize && activity.createdAt > previous.createdAt)
    ) {
      dropped.add(previousIndex);
      bestIndexByToolCallId.set(id, index);
    } else {
      dropped.add(index);
    }
  }

  return dropped.size === 0 ? activities : activities.filter((_, index) => !dropped.has(index));
}

export function projectThreadDetailSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  const retainedActivities = dropSupersededToolUpdatedActivities(
    dropDuplicateToolCompletedActivities(
      dropStaleContextWindowActivities(snapshot.thread.activities),
    ),
  );
  const projectedActivities = retainedActivities.map(projectActivityPayload);
  const nativeCompatibilityActivities = projectCodexNativeActivities(retainedActivities);
  return {
    ...snapshot,
    thread: {
      ...snapshot.thread,
      messages: normalizeThreadMessagesForWire(
        Array.isArray(snapshot.thread.messages) ? snapshot.thread.messages : [],
      ),
      activities: [...projectedActivities, ...nativeCompatibilityActivities].toSorted(
        (left, right) =>
          (left.sequence ?? -1) - (right.sequence ?? -1) ||
          left.createdAt.localeCompare(right.createdAt) ||
          String(left.id).localeCompare(String(right.id)),
      ),
    },
  };
}

export function projectActivityEvent(event: OrchestrationEvent): OrchestrationEvent {
  if (event.type === "thread.message-sent") {
    if (
      event.metadata.historyImport !== true ||
      event.payload.streaming ||
      event.payload.role !== "assistant" ||
      !isCodexHistoryMessageId(String(event.payload.messageId))
    ) {
      return event;
    }
    const liveMessageId = codexLiveMessageIdFromCodexHistoryMessageId(
      String(event.payload.messageId),
    );
    if (liveMessageId === undefined) {
      return event;
    }
    return {
      ...event,
      payload: {
        ...event.payload,
        messageId: MessageId.make(liveMessageId),
      },
    };
  }
  if (event.type !== "thread.activity-appended") {
    return event;
  }
  return {
    ...event,
    payload: {
      ...event.payload,
      activity: projectActivityPayload(event.payload.activity),
    },
  };
}
