/**
 * Read-through view of a Codex thread.
 *
 * App Server owns Codex's transcript. T3 owns only the shell and the live
 * compatibility stream. This module joins those two facts at the server
 * boundary so the existing web, desktop, and mobile contracts stay unchanged
 * without copying a native transcript into T3's event store.
 */
import {
  CheckpointRef,
  MessageId,
  type OrchestrationSessionStatus,
  ProviderDriverKind,
  TurnId,
  type OrchestrationLatestTurn,
  type OrchestrationMessage,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadDetailWindow,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { runtimeEventsToActivities } from "../../orchestration/ProviderRuntimeActivityProjection.ts";

import { normalizeProviderDiff } from "../../checkpointing/ProviderDiffNormalization.ts";
import type { ProviderInstanceRegistryShape } from "../Services/ProviderInstanceRegistry.ts";
import type {
  ProviderStoredThreadHistory,
  ProviderStoredThreadTurn,
} from "../Services/ProviderAdapter.ts";
import {
  decodeThreadDetailPageCursor,
  encodeThreadDetailPageCursor,
} from "../../orchestration/threadDetailCursor.ts";

const NATIVE_THREAD_PREFIX = "codex:";

export class CodexAppServerHistoryUnavailableError extends Schema.TaggedError<CodexAppServerHistoryUnavailableError>()(
  "CodexAppServerHistoryUnavailableError",
  { threadId: Schema.String },
) {
  override get message(): string {
    return `Codex App Server history is unavailable for ${this.threadId}`;
  }
}

type CodexThreadSource = Pick<OrchestrationThread, "id" | "modelSelection" | "archivedAt">;

export function isCodexAppServerThread(threadId: string): boolean {
  return threadId.startsWith(NATIVE_THREAD_PREFIX) && threadId.length > NATIVE_THREAD_PREFIX.length;
}

function nativeThreadId(threadId: string): string {
  return threadId.slice(NATIVE_THREAD_PREFIX.length);
}

function compareTurns(left: ProviderStoredThreadTurn, right: ProviderStoredThreadTurn): number {
  return (
    left.anchorAt.localeCompare(right.anchorAt) ||
    String(left.turnId).localeCompare(String(right.turnId))
  );
}

function selectedNativeTurns(
  threadId: OrchestrationThread["id"],
  turns: ReadonlyArray<ProviderStoredThreadTurn>,
  window: OrchestrationThreadDetailWindow | undefined,
): {
  readonly turns: ReadonlyArray<ProviderStoredThreadTurn>;
  readonly hasMore: boolean;
} {
  const ordered = [...turns].toSorted(compareTurns);
  if (window?.turnLimit === undefined) {
    return { turns: ordered, hasMore: false };
  }

  const decoded =
    window.beforeCursor === undefined ? null : decodeThreadDetailPageCursor(window.beforeCursor);
  const cursor = decoded?.threadId === threadId ? decoded : null;
  const boundaryIndex = cursor?.beforeTurnId
    ? ordered.findIndex((turn) => String(turn.turnId) === cursor.beforeTurnId)
    : -1;
  const candidates =
    cursor !== null && boundaryIndex >= 0
      ? ordered.slice(0, boundaryIndex)
      : cursor !== null && cursor.beforeAnchorAt.length > 0
        ? ordered.filter(
            (turn) =>
              turn.anchorAt < cursor.beforeAnchorAt ||
              (turn.anchorAt === cursor.beforeAnchorAt &&
                String(turn.turnId) < cursor.beforeTurnId),
          )
        : ordered;

  const selected: Array<ProviderStoredThreadTurn> = [];
  let userTurns = 0;
  for (let index = candidates.length - 1; index >= 0; index -= 1) {
    const turn = candidates[index]!;
    selected.push(turn);
    if (turn.hasUserMessage) userTurns += 1;
    if (userTurns >= window.turnLimit && turn.hasUserMessage) break;
  }
  selected.reverse();
  return { turns: selected, hasMore: selected.length < candidates.length };
}

function messageForHistory(
  message: ProviderStoredThreadHistory["messages"][number],
): OrchestrationMessage {
  const id = MessageId.make(message.messageId);
  return {
    id,
    role: message.role,
    text: message.text,
    turnId: message.turnId ?? null,
    streaming: false,
    createdAt: message.createdAt,
    updatedAt: message.createdAt,
  };
}

function isLiveSession(status: OrchestrationSessionStatus): boolean {
  return status === "starting" || status === "running";
}

function currentTurnId(
  thread: OrchestrationThread,
  history: ProviderStoredThreadHistory,
): string | null {
  const nativeTurnId = history.activeTurnId ?? thread.session?.activeTurnId;
  if (nativeTurnId !== undefined && nativeTurnId !== null) return String(nativeTurnId);
  const latestTurn = thread.latestTurn;
  return latestTurn !== null &&
    latestTurn !== undefined &&
    (latestTurn.state === "running" || thread.updatedAt > history.updatedAt)
    ? String(latestTurn.turnId)
    : null;
}

function isCurrentPage(window: OrchestrationThreadDetailWindow | undefined): boolean {
  return window === undefined || window.beforeCursor === undefined;
}

function pendingLiveUserId(thread: OrchestrationThread): string | null {
  return (
    thread.messages
      .filter(
        (message) =>
          message.role === "user" &&
          message.turnId === null &&
          !String(message.id).startsWith("import:"),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) ||
          String(left.id).localeCompare(String(right.id)),
      )
      .at(-1)
      ?.id.toString() ?? null
  );
}

function nativeUserMessageForTurn(
  history: ProviderStoredThreadHistory,
  turnId: string | null,
): ProviderStoredThreadHistory["messages"][number] | undefined {
  if (turnId === null) return undefined;
  return history.messages.find(
    (message) => message.role === "user" && String(message.turnId) === turnId,
  );
}

function mergeById<T extends { readonly id: { toString(): string }; readonly createdAt: string }>(
  base: ReadonlyArray<T>,
  overlay: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const byId = new Map(base.map((entry) => [entry.id.toString(), entry]));
  for (const entry of overlay) byId.set(entry.id.toString(), entry);
  return [...byId.values()].toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.toString().localeCompare(right.id.toString()),
  );
}

function overlayLiveThreadState(
  snapshot: OrchestrationThreadDetailSnapshot,
  history: ProviderStoredThreadHistory,
  messages: ReadonlyArray<OrchestrationMessage>,
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  checkpoints: ReadonlyArray<OrchestrationThread["checkpoints"][number]>,
  window: OrchestrationThreadDetailWindow | undefined,
): {
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThread["activities"][number]>;
  readonly checkpoints: ReadonlyArray<OrchestrationThread["checkpoints"][number]>;
} {
  if (!isCurrentPage(window)) return { messages, activities, checkpoints };

  const activeTurn = currentTurnId(snapshot.thread, history);
  const sessionActive =
    snapshot.thread.session !== null && isLiveSession(snapshot.thread.session.status);
  const pendingUser = pendingLiveUserId(snapshot.thread);
  const liveMessages = snapshot.thread.messages.filter((message) => {
    if (String(message.id).startsWith("import:")) return false;
    const nativeUser =
      message.role === "user" &&
      message.turnId === null &&
      String(message.id) === pendingUser &&
      activeTurn !== null &&
      sessionActive &&
      String(history.activeTurnId) === activeTurn
        ? nativeUserMessageForTurn(history, activeTurn)
        : undefined;
    if (
      nativeUser !== undefined &&
      nativeUser.createdAt === message.createdAt &&
      nativeUser.text.trim() === message.text.trim()
    ) {
      // Older native records may not echo clientUserMessageId. The narrow
      // timestamp/turn check handles that legacy case without treating an
      // arbitrary same-text message as the same user input.
      return false;
    }
    const current =
      activeTurn !== null
        ? String(message.turnId) === activeTurn ||
          (message.turnId === null && String(message.id) === pendingUser)
        : sessionActive &&
          (message.streaming || (message.role === "user" && String(message.id) === pendingUser));
    return current;
  });

  const liveActivities = snapshot.thread.activities.filter(
    (activity) =>
      !String(activity.id).startsWith("codex-history:") &&
      activeTurn !== null &&
      String(activity.turnId) === activeTurn,
  );

  const nativeCheckpointsByTurn = new Map(
    checkpoints.map((checkpoint) => [String(checkpoint.turnId), checkpoint]),
  );
  if (activeTurn !== null) {
    for (const checkpoint of snapshot.thread.checkpoints) {
      if (String(checkpoint.turnId) !== activeTurn) continue;
      const native = nativeCheckpointsByTurn.get(activeTurn);
      if (native === undefined || (native.status === "missing" && checkpoint.status === "ready")) {
        nativeCheckpointsByTurn.set(activeTurn, checkpoint);
      }
    }
  }

  return {
    messages: mergeById(messages, liveMessages),
    activities: mergeById(activities, liveActivities),
    checkpoints: [...nativeCheckpointsByTurn.values()].toSorted(
      (left, right) => left.checkpointTurnCount - right.checkpointTurnCount,
    ),
  };
}

function messageBelongsToTurns(
  message: OrchestrationMessage,
  selected: ReadonlySet<string>,
  selectedTurns: ReadonlyArray<ProviderStoredThreadTurn>,
): boolean {
  if (message.turnId !== null) return selected.has(String(message.turnId));
  const oldest = selectedTurns[0];
  const newest = selectedTurns.at(-1);
  return (
    oldest !== undefined &&
    newest !== undefined &&
    message.createdAt >= oldest.anchorAt &&
    message.createdAt <= newest.anchorAt
  );
}

function activityBelongsToTurns(
  activity: OrchestrationThread["activities"][number],
  selected: ReadonlySet<string>,
  selectedTurns: ReadonlyArray<ProviderStoredThreadTurn>,
): boolean {
  if (activity.turnId !== null) return selected.has(String(activity.turnId));
  const oldest = selectedTurns[0];
  const newest = selectedTurns.at(-1);
  return (
    oldest !== undefined &&
    newest !== undefined &&
    activity.createdAt >= oldest.anchorAt &&
    activity.createdAt <= newest.anchorAt
  );
}

function nativeLatestTurn(
  thread: OrchestrationThread,
  history: ProviderStoredThreadHistory,
  preserveCurrent: boolean,
): OrchestrationLatestTurn | null {
  if (preserveCurrent && thread.latestTurn !== null) return thread.latestTurn;
  const last = history.turns?.toSorted(compareTurns).at(-1);
  if (last === undefined) return thread.latestTurn;
  const assistant = history.messages.findLast(
    (message) => message.role === "assistant" && message.turnId === last.turnId,
  );
  return {
    turnId: last.turnId,
    state:
      last.status === "inProgress"
        ? "running"
        : last.status === "failed"
          ? "error"
          : last.status === "interrupted"
            ? "interrupted"
            : "completed",
    requestedAt: last.anchorAt,
    startedAt: last.startedAt,
    completedAt: last.completedAt,
    assistantMessageId: assistant === undefined ? null : MessageId.make(assistant.messageId),
  };
}

function nativeCheckpoints(
  threadId: OrchestrationThread["id"],
  history: ProviderStoredThreadHistory,
) {
  return history.turnDiffs.map((diff, index) => ({
    turnId: diff.turnId,
    checkpointTurnCount: index + 1,
    checkpointRef: CheckpointRef.make(`provider-diff:${threadId}:${diff.turnId}`),
    status: diff.status === "missing" ? ("missing" as const) : ("ready" as const),
    files: [...diff.files],
    assistantMessageId: diff.assistantMessageId ?? null,
    completedAt: diff.completedAt,
  }));
}

/** Return a checkpoint-range patch directly from the native diff sequence. */
export function codexStoredDiffRange(
  history: ProviderStoredThreadHistory,
  fromTurnCount: number,
  toTurnCount: number,
): string | undefined {
  if (fromTurnCount < 0 || toTurnCount < fromTurnCount || toTurnCount > history.turnDiffs.length) {
    return undefined;
  }
  return normalizeProviderDiff(
    history.turnDiffs
      .slice(fromTurnCount, toTurnCount)
      .map((diff) => diff.diff)
      .join("\n"),
  );
}

function nativeSession(
  thread: OrchestrationThread,
  history: ProviderStoredThreadHistory,
  preserveCurrent: boolean,
): OrchestrationThread["session"] {
  if (preserveCurrent) return thread.session;
  if (!history.active && thread.session === null) return null;
  const existing = thread.session;
  const activeTurnId = history.activeTurnId ?? null;
  return {
    threadId: thread.id,
    status: history.active
      ? activeTurnId === null
        ? "ready"
        : "running"
      : existing?.status === "stopped"
        ? "stopped"
        : "idle",
    providerName: "codex",
    providerInstanceId: existing?.providerInstanceId ?? thread.modelSelection.instanceId,
    runtimeMode: thread.runtimeMode,
    activeTurnId,
    lastError: existing?.lastError ?? null,
    updatedAt: history.updatedAt,
  };
}

/** Project one App Server history read into the unchanged T3 detail contract. */
export function projectCodexStoredThreadHistory(
  snapshot: OrchestrationThreadDetailSnapshot,
  history: ProviderStoredThreadHistory,
  window?: OrchestrationThreadDetailWindow,
): OrchestrationThreadDetailSnapshot {
  const allTurns = history.turns ?? [];
  const page = selectedNativeTurns(snapshot.thread.id, allTurns, window);
  const selectedIds = new Set(page.turns.map((turn) => String(turn.turnId)));
  const allMessages = history.messages.map((message) => messageForHistory(message));
  const nativeMessages =
    window?.turnLimit === undefined
      ? allMessages
      : allMessages.filter((message) => messageBelongsToTurns(message, selectedIds, page.turns));
  const nativeActivities = runtimeEventsToActivities(history.runtimeEvents);
  const nativeActivitiesForPage =
    window?.turnLimit === undefined
      ? nativeActivities
      : nativeActivities.filter((activity) =>
          activityBelongsToTurns(activity, selectedIds, page.turns),
        );
  const nativeCheckpointsForPage =
    window?.turnLimit === undefined
      ? nativeCheckpoints(snapshot.thread.id, history)
      : nativeCheckpoints(snapshot.thread.id, history).filter((checkpoint) =>
          selectedIds.has(String(checkpoint.turnId)),
        );
  const liveState = overlayLiveThreadState(
    snapshot,
    history,
    nativeMessages,
    nativeActivitiesForPage,
    nativeCheckpointsForPage,
    window,
  );
  // An older page is a transcript slice, not a newer thread state. Keep the
  // shell's latest-turn/session facts while walking backwards; otherwise the
  // UI briefly reports an old turn as current or changes a running session to
  // idle just because its active turn is outside the requested page.
  const preserveCurrentState = window?.beforeCursor !== undefined;
  const latestTurn = nativeLatestTurn(snapshot.thread, history, preserveCurrentState);
  const thread: OrchestrationThread = {
    ...snapshot.thread,
    updatedAt:
      snapshot.thread.updatedAt.localeCompare(history.updatedAt) >= 0
        ? snapshot.thread.updatedAt
        : history.updatedAt,
    latestTurn,
    messages: liveState.messages,
    activities: liveState.activities,
    checkpoints: liveState.checkpoints,
    session: nativeSession(snapshot.thread, history, preserveCurrentState),
  };
  if (window?.turnLimit === undefined) {
    return { ...snapshot, thread };
  }
  const oldest = page.turns[0];
  return {
    ...snapshot,
    thread,
    page: {
      beforeCursor:
        page.hasMore && oldest !== undefined
          ? encodeThreadDetailPageCursor({
              threadId: snapshot.thread.id,
              beforeAnchorAt: oldest.anchorAt,
              beforeTurnId: String(oldest.turnId),
            })
          : null,
      hasMore: page.hasMore,
      snapshotSequence: snapshot.snapshotSequence,
      ...(snapshot.page?.threadSequence === undefined
        ? {}
        : { threadSequence: snapshot.page.threadSequence }),
    },
  };
}

/** Read native history only for canonical Codex threads; all other providers
 * and all legacy/custom T3 threads keep the existing projection path. */
export const readCodexStoredHistory = (
  thread: CodexThreadSource,
  providerInstances: ProviderInstanceRegistryShape,
  window?: OrchestrationThreadDetailWindow,
) =>
  Effect.gen(function* () {
    if (!isCodexAppServerThread(String(thread.id))) return undefined;
    const instance = yield* providerInstances.getInstance(thread.modelSelection.instanceId);
    if (instance === undefined || instance.driverKind !== ProviderDriverKind.make("codex")) {
      return undefined;
    }
    const catalog = instance.adapter.storedThreadCatalog;
    if (catalog === undefined) return undefined;
    const cursor =
      window?.beforeCursor === undefined ? null : decodeThreadDetailPageCursor(window.beforeCursor);
    const beforeTurnId = cursor?.threadId === thread.id ? cursor.beforeTurnId : undefined;
    return yield* catalog.readStoredThread({
      nativeThreadId: nativeThreadId(String(thread.id)),
      archived: thread.archivedAt !== null,
      ...(window?.turnLimit === undefined ? {} : { turnLimit: window.turnLimit }),
      ...(beforeTurnId === undefined ? {} : { beforeTurnId: TurnId.make(beforeTurnId) }),
    });
  });

export const readCodexThreadThrough = (
  snapshot: OrchestrationThreadDetailSnapshot,
  providerInstances: ProviderInstanceRegistryShape,
  window?: OrchestrationThreadDetailWindow,
) =>
  Effect.gen(function* () {
    const history = yield* readCodexStoredHistory(snapshot.thread, providerInstances, window);
    if (history === undefined) {
      if (!isCodexAppServerThread(String(snapshot.thread.id))) return snapshot;
      return yield* new CodexAppServerHistoryUnavailableError({
        threadId: String(snapshot.thread.id),
      });
    }
    return projectCodexStoredThreadHistory(snapshot, history, window);
  });
