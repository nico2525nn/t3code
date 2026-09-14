/**
 * Pure read-side projection for Codex App Server history.
 *
 * Codex owns the durable thread. This module translates one native snapshot
 * into the small provider catalog shape that the unchanged T3 projections and
 * clients already understand. It has no session state, database access, or
 * live-event routing, so importing history cannot create a second runtime.
 */
import { MessageId, TurnId, type OrchestrationCheckpointFile } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import type {
  ProviderStoredThreadTurn,
  ProviderStoredThreadHistory,
  ProviderStoredThreadSummary,
  ProviderStoredThreadTurnDiff,
} from "../Services/ProviderAdapter.ts";

function normalizeCodexThreadTitle(value: string | undefined | null): string | undefined {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  if (!normalized) {
    return undefined;
  }
  const characters = Array.from(normalized);
  return characters.length <= 160 ? normalized : `${characters.slice(0, 159).join("")}…`;
}

function codexUnixTimestampToIso(value: number | null | undefined, fallback: number): string {
  const seconds = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const date = DateTime.make(seconds * 1000);
  return Option.isSome(date)
    ? DateTime.formatIso(date.value)
    : DateTime.formatIso(DateTime.makeUnsafe(0));
}

export type CodexHistoryThread = Pick<
  EffectCodexSchema.V2ThreadReadResponse__Thread,
  "id" | "cwd" | "updatedAt" | "turns"
>;

function isCodexSubAgentSource(source: unknown): boolean {
  if (typeof source === "string") {
    return source === "subAgent" || source.startsWith("subAgent");
  }
  return typeof source === "object" && source !== null && "subAgent" in source;
}

function codexUserMessageText(
  item: Extract<
    EffectCodexSchema.V2ThreadReadResponse__ThreadItem,
    { readonly type: "userMessage" }
  >,
): string | undefined {
  const text = item.content
    .filter((content) => content.type === "text")
    .map((content) => content.text)
    .join("\n")
    .trim();
  if (text.length > 0) {
    return text;
  }

  const attachmentCount = item.content.filter(
    (content) =>
      content.type === "image" ||
      content.type === "localImage" ||
      content.type === "audio" ||
      content.type === "localAudio",
  ).length;
  return attachmentCount > 0
    ? `[${String(attachmentCount)} Codex attachment${attachmentCount === 1 ? "" : "s"}]`
    : undefined;
}

function codexUserMessageId(
  threadId: string,
  turnId: string,
  item: Extract<
    EffectCodexSchema.V2ThreadReadResponse__ThreadItem,
    { readonly type: "userMessage" }
  >,
): string {
  const clientId = item.clientId?.trim();
  return clientId !== undefined && clientId.length > 0 && !clientId.startsWith("import:")
    ? clientId
    : `codex:${threadId}:user:${turnId}:${item.id}`;
}

function normalizeCodexChangePath(cwd: string, value: string): string {
  const normalizedCwd = cwd.replaceAll("\\", "/").replace(/\/+$/u, "");
  const normalizedValue = value.replaceAll("\\", "/");
  if (normalizedValue === normalizedCwd) {
    return normalizedValue.split("/").at(-1) ?? normalizedValue;
  }
  if (normalizedValue.startsWith(`${normalizedCwd}/`)) {
    return normalizedValue.slice(normalizedCwd.length + 1);
  }

  // Older Codex records can retain a path from the same checkout mounted via
  // a different parent directory. Prefer a stable repository-relative path
  // when the workspace directory name matches; otherwise preserve the native
  // path. Do not match arbitrary parent suffixes: a sibling worktree such as
  // `t3code-work-codex-app-server` must not be treated as `t3code`.
  const cwdParts = normalizedCwd.split("/").filter(Boolean);
  const valueParts = normalizedValue.split("/").filter(Boolean);
  const cwdName = cwdParts.at(-1);
  if (cwdName !== undefined) {
    for (let index = valueParts.length - 2; index >= 0; index -= 1) {
      if (valueParts[index] === cwdName) {
        return valueParts.slice(index + 1).join("/");
      }
    }
  }
  return normalizedValue;
}

function diffLineStats(diff: string): Pick<OrchestrationCheckpointFile, "additions" | "deletions"> {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

interface RenderedCodexChange {
  readonly path: string;
  readonly diff: string;
  readonly files: OrchestrationCheckpointFile;
}

const isPatchBodyStart = (line: string): boolean =>
  /^@@+\s/u.test(line) || line === "GIT binary patch" || line.startsWith("literal ");

function splitPatchBody(patch: string): {
  readonly prefix: ReadonlyArray<string>;
  readonly body: ReadonlyArray<string>;
} {
  const lines = patch.split("\n");
  const bodyIndex = lines.findIndex(isPatchBodyStart);
  if (bodyIndex < 0) return { prefix: lines, body: [] };
  const rawBody = lines.slice(bodyIndex);
  const nextHeader = rawBody.findIndex(
    (line, index) => index > 0 && line.startsWith("diff --git "),
  );
  return {
    prefix: lines.slice(0, bodyIndex),
    body: trimPatchBody(nextHeader < 0 ? rawBody : rawBody.slice(0, nextHeader)),
  };
}

function trimPatchBody(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

/** Keep Codex's path field authoritative even when its diff body has old absolute headers. */
function canonicalCodexPatch(
  change: Extract<
    EffectCodexSchema.V2ThreadReadResponse__ThreadItem,
    { readonly type: "fileChange" }
  >["changes"][number],
  path: string,
  targetPath: string,
): string {
  const { prefix, body } = splitPatchBody(change.diff.trim());
  const nativeMetadata = prefix.filter((line) =>
    /^(?:similarity index |(?:old|new) file mode |(?:old|new) mode |deleted file mode |index )/u.test(
      line,
    ),
  );
  const metadata = [
    ...nativeMetadata,
    ...(change.kind.type === "add" &&
    !nativeMetadata.some((line) => line.startsWith("new file mode"))
      ? ["new file mode 100644"]
      : []),
    ...(change.kind.type === "delete" &&
    !nativeMetadata.some((line) => line.startsWith("deleted file mode"))
      ? ["deleted file mode 100644"]
      : []),
  ];
  const gitPath = (value: string) => value.replace(/^\/+\s*/u, "");
  return [
    `diff --git a/${gitPath(path)} b/${gitPath(targetPath)}`,
    ...metadata,
    `--- ${change.kind.type === "add" ? "/dev/null" : `a/${gitPath(path)}`}`,
    `+++ ${change.kind.type === "delete" ? "/dev/null" : `b/${gitPath(targetPath)}`}`,
    ...body,
  ].join("\n");
}

function mergeRenderedCodexChanges(
  changes: ReadonlyArray<RenderedCodexChange>,
): Array<RenderedCodexChange> {
  const merged = new Map<string, RenderedCodexChange>();
  for (const change of changes) {
    const previous = merged.get(change.path);
    if (previous === undefined) {
      merged.set(change.path, change);
      continue;
    }
    const previousPatch = splitPatchBody(previous.diff);
    const nextPatch = splitPatchBody(change.diff);
    const bodies = [...previousPatch.body, ...nextPatch.body];
    merged.set(change.path, {
      ...previous,
      diff:
        bodies.length === 0
          ? change.diff
          : [...previousPatch.prefix, ...trimPatchBody(bodies)].join("\n"),
      files: {
        ...previous.files,
        additions: previous.files.additions + change.files.additions,
        deletions: previous.files.deletions + change.files.deletions,
      },
    });
  }
  return [...merged.values()];
}

function renderCodexFileChange(
  cwd: string,
  change: Extract<
    EffectCodexSchema.V2ThreadReadResponse__ThreadItem,
    { readonly type: "fileChange" }
  >["changes"][number],
): RenderedCodexChange {
  const path = normalizeCodexChangePath(cwd, change.path);
  const movePath =
    change.kind.type === "update" && change.kind.move_path
      ? normalizeCodexChangePath(cwd, change.kind.move_path)
      : undefined;
  const targetPath = movePath ?? path;
  const renderedDiff = canonicalCodexPatch(change, path, targetPath);
  const stats = diffLineStats(renderedDiff);
  const kind =
    change.kind.type === "add"
      ? "added"
      : change.kind.type === "delete"
        ? "deleted"
        : movePath
          ? "renamed"
          : "modified";
  return {
    path: targetPath,
    diff: renderedDiff,
    files: {
      path: targetPath,
      kind,
      additions: stats.additions,
      deletions: stats.deletions,
    },
  };
}

/** Convert durable Codex file-change items into T3-compatible turn patches. */
export function codexAppServerThreadDiffs(
  thread: CodexHistoryThread,
): ReadonlyArray<ProviderStoredThreadTurnDiff> {
  const turnDiffs: Array<ProviderStoredThreadTurnDiff> = [];
  for (const turn of thread.turns) {
    const turnIsCompleted = turn.status === "completed";
    const turnIsInProgress = turn.status === "inProgress";
    const turnIsInterrupted = turn.status === "interrupted";
    const turnIsFailed = turn.status === "failed";
    if (!turnIsCompleted && !turnIsInProgress && !turnIsInterrupted && !turnIsFailed) {
      continue;
    }
    const renderedChanges = mergeRenderedCodexChanges(
      turn.items
        .filter(
          (item): item is Extract<typeof item, { readonly type: "fileChange" }> =>
            item.type === "fileChange" &&
            (item.status === "completed" || (turnIsInProgress && item.status === "inProgress")),
        )
        .flatMap((item) => item.changes.map((change) => renderCodexFileChange(thread.cwd, change))),
    );
    if (renderedChanges.length === 0) {
      continue;
    }

    const assistantMessage = turn.items.findLast(
      (item): item is Extract<typeof item, { readonly type: "agentMessage" }> =>
        item.type === "agentMessage" && item.text.trim().length > 0,
    );
    const assistantMessageId = assistantMessage
      ? MessageId.make(`assistant:${assistantMessage.id}`)
      : undefined;

    turnDiffs.push({
      turnId: TurnId.make(turn.id),
      completedAt: codexUnixTimestampToIso(turn.completedAt ?? turn.startedAt, thread.updatedAt),
      diff: renderedChanges.map((change) => change.diff).join("\n"),
      files: renderedChanges.map((change) => change.files),
      // Terminal failed/interrupted turns can still contain completed file
      // changes. Their native patch is final even though the turn outcome was
      // not successful; only an in-progress turn remains a preview.
      status: turnIsInProgress ? "missing" : "ready",
      ...(assistantMessageId ? { assistantMessageId } : {}),
    });
  }
  return turnDiffs;
}

/**
 * Keep only the native turn facts required to page a read-through snapshot.
 * The transcript itself stays in App Server; T3 does not need another turn
 * table just to decide which native rows belong on the next page.
 */
export function codexAppServerThreadTurns(
  thread: CodexHistoryThread,
): ReadonlyArray<ProviderStoredThreadTurn> {
  return thread.turns.flatMap((turn) => {
    if (
      turn.status !== "inProgress" &&
      turn.status !== "completed" &&
      turn.status !== "interrupted" &&
      turn.status !== "failed"
    ) {
      return [];
    }
    const startedAt = codexUnixTimestampToIso(turn.startedAt ?? turn.completedAt, thread.updatedAt);
    const completedAt =
      turn.completedAt === null || turn.completedAt === undefined
        ? null
        : codexUnixTimestampToIso(turn.completedAt, thread.updatedAt);
    return [
      {
        turnId: TurnId.make(turn.id),
        anchorAt: startedAt,
        status: turn.status,
        startedAt,
        completedAt,
        hasUserMessage: turn.items.some((item) => item.type === "userMessage"),
      },
    ];
  });
}

/**
 * Normalize the durable Codex thread shape at the adapter boundary. T3 keeps
 * text messages in its compatibility projection and also retains native file
 * changes as a fallback for turns whose filesystem checkpoint is unavailable.
 */
export function codexAppServerThreadSummary(
  thread:
    | EffectCodexSchema.V2ThreadListResponse__Thread
    | EffectCodexSchema.V2ThreadReadResponse__Thread,
  archived: boolean,
): ProviderStoredThreadSummary {
  return {
    nativeThreadId: thread.id,
    cwd: thread.cwd,
    title:
      normalizeCodexThreadTitle(thread.name) ??
      normalizeCodexThreadTitle(thread.preview) ??
      "Codex thread",
    preview: thread.preview,
    createdAt: codexUnixTimestampToIso(thread.createdAt, thread.createdAt),
    updatedAt: codexUnixTimestampToIso(thread.updatedAt, thread.createdAt),
    archived,
    ephemeral: thread.ephemeral,
    subAgent: isCodexSubAgentSource(thread.source),
    active: thread.status.type === "active",
    ...("turns" in thread
      ? (() => {
          const activeTurn = thread.turns.findLast((turn) => turn.status === "inProgress");
          const latestTurn = thread.turns.at(-1);
          return {
            ...(activeTurn ? { activeTurnId: TurnId.make(activeTurn.id) } : {}),
            ...(latestTurn ? { latestTurnId: TurnId.make(latestTurn.id) } : {}),
          };
        })()
      : {}),
  };
}
/** Convert only user/assistant text items; native operational items stay native. */
export function codexAppServerThreadMessages(
  thread: CodexHistoryThread,
): ReadonlyArray<ProviderStoredThreadHistory["messages"][number]> {
  const messages: Array<ProviderStoredThreadHistory["messages"][number]> = [];
  const seenMessageIds = new Set<string>();

  for (const turn of thread.turns) {
    for (const [itemIndex, item] of turn.items.entries()) {
      // A turn can contain several user/assistant messages interleaved with
      // reasoning and tools. App Server does not timestamp each item, so keep
      // the native item order with a stable millisecond offset.
      const createdAt = nativeHistoryItemTimestamp(turn, thread.updatedAt, itemIndex);
      const message =
        item.type === "userMessage"
          ? (() => {
              const text = codexUserMessageText(item);
              return text === undefined
                ? undefined
                : {
                    // App Server echoes turn/start's clientUserMessageId in
                    // the durable userMessage item. It is the one exact key
                    // shared by T3's optimistic row and native history.
                    messageId: codexUserMessageId(thread.id, turn.id, item),
                    role: "user" as const,
                    text,
                    turnId: TurnId.make(turn.id),
                    createdAt,
                  };
            })()
          : item.type === "agentMessage" && item.text.trim().length > 0
            ? {
                // App Server item ids are also the live ingestion ids. Using
                // one identity here makes history and live delivery a normal
                // upsert instead of a second reconciliation protocol.
                messageId: `assistant:${item.id}`,
                role: "assistant" as const,
                text: item.text,
                turnId: TurnId.make(turn.id),
                createdAt,
              }
            : undefined;
      if (message && !seenMessageIds.has(message.messageId)) {
        seenMessageIds.add(message.messageId);
        messages.push(message);
      }
    }
  }

  return messages;
}

export function nativeHistoryItemTimestamp(
  turn: EffectCodexSchema.V2ThreadReadResponse__Turn,
  fallback: number,
  itemIndex = 0,
): string {
  const turnTimestamp = turn.startedAt ?? turn.completedAt;
  return codexUnixTimestampToIso(
    typeof turnTimestamp === "number" && Number.isFinite(turnTimestamp)
      ? turnTimestamp + itemIndex / 1000
      : turnTimestamp,
    fallback,
  );
}

export function nativeHistoryItemRecord(
  item: EffectCodexSchema.V2ThreadReadResponse__ThreadItem,
): Record<string, unknown> {
  return item as unknown as Record<string, unknown>;
}
