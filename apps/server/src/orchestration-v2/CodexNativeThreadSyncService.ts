import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as EventSink from "./EventSink.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { planProjectCommand } from "./ProjectCommands.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as CodexSchema from "effect-codex-app-server/schema";

const CODEX = ProviderDriverKind.make("codex");
const DEFAULT_CODEX_INSTANCE = ProviderInstanceId.make("codex");
const IMPORT_PREFIX = "import:";
const PREVIOUS_HISTORY_MAPPING_VERSION = 2;
const HISTORY_MAPPING_VERSION = 3;
const NATIVE_TIMELINE_ORDER_VERSION = 1;
const MAX_FULL_HISTORY_REMAP_ITEMS = 10_000;
type NativeThread = ProviderAdapter.ProviderAdapterV2NativeThread;
type NativeTurn = ProviderAdapter.ProviderAdapterV2NativeTurn;
type NativeItem = ProviderAdapter.ProviderAdapterV2NativeItem;
type NativeHistoryItem = CodexSchema.V2ThreadItemsListResponse__ThreadItem;
type ThreadRecords = ProjectionStore.ProjectionRecords<
  | "runs"
  | "attempts"
  | "nodes"
  | "providerThreads"
  | "providerTurns"
  | "messages"
  | "turnItems"
  | "checkpoints"
  | "plans"
  | "subagents"
>;
type ExistingMessagesByRoleAndText = ReadonlyMap<
  string,
  ReadonlyArray<OrchestrationV2ConversationMessage>
>;

const messageReuseKey = (role: "user" | "assistant", text: string) => JSON.stringify([role, text]);

type NativeHistoryEvent =
  | { readonly type: "message.updated"; readonly payload: OrchestrationV2ConversationMessage }
  | { readonly type: "turn-item.updated"; readonly payload: OrchestrationV2TurnItem }
  | { readonly type: "node.updated"; readonly payload: OrchestrationV2ExecutionNode }
  | { readonly type: "plan.updated"; readonly payload: OrchestrationV2PlanArtifact }
  | { readonly type: "subagent.updated"; readonly payload: OrchestrationV2Subagent };

export interface CodexNativeThreadSyncServiceShape {
  readonly syncCatalog: () => Effect.Effect<void>;
  readonly startCatalogSync: () => Effect.Effect<void>;
  readonly startThreadSync: (
    threadId: ThreadId,
    options?: { readonly force?: boolean; readonly resume?: boolean },
  ) => Effect.Effect<void>;
  readonly syncThread: (
    threadId: ThreadId,
    options?: {
      readonly force?: boolean;
      readonly catalogUpdatedAt?: string;
      readonly catalogWorkspaceRoot?: string;
    },
  ) => Effect.Effect<void>;
  readonly resumeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly applyThreadCommand: (command: {
    readonly type:
      | "thread.archive"
      | "thread.unarchive"
      | "thread.delete"
      | "thread.metadata.update";
    readonly threadId: ThreadId;
    readonly title?: string;
  }) => Effect.Effect<void>;
}

export class CodexNativeThreadSyncService extends Context.Service<
  CodexNativeThreadSyncService,
  CodexNativeThreadSyncServiceShape
>()("t3/orchestration-v2/CodexNativeThreadSyncService") {}

const utc = (seconds: number) => DateTime.makeUnsafe(seconds * 1_000);
const epoch = (time: DateTime.Utc) => DateTime.toEpochMillis(time);

export function nativeTimelineItemOrderFor(input: {
  readonly existingItems: ReadonlyArray<ProjectionStore.ProjectionTurnItemOrderRow>;
  readonly mappedItems: ReadonlyArray<{
    readonly item: OrchestrationV2TurnItem;
    readonly at: number;
    readonly order: readonly [number, number];
    readonly nativeTurnId: string;
    readonly nativeTurnOrdinal: number;
  }>;
}): ReadonlyArray<TurnItemId> {
  const withinTurnOrder = new Map<TurnItemId, number>();
  const nextWithinTurnOrder = new Map<string, number>();
  const itemsById = new Map<
    TurnItemId,
    {
      readonly id: TurnItemId;
      readonly ordinal: number;
      readonly startedAt: string | null;
      readonly updatedAt: string | null;
      readonly nativeTurnId: string | null;
      readonly nativeTurnOrdinal: number | null;
      readonly nativeOrder?: readonly [number, number];
      readonly withinTurnOrder: number;
    }
  >();

  for (const item of input.existingItems) {
    const turnId = item.nativeTurnId;
    const position = turnId === null ? item.ordinal : (nextWithinTurnOrder.get(turnId) ?? 0);
    if (turnId !== null) nextWithinTurnOrder.set(turnId, position + 1);
    withinTurnOrder.set(item.id, position);
    itemsById.set(item.id, { ...item, withinTurnOrder: position });
  }

  for (const mapped of input.mappedItems) {
    const existing = itemsById.get(mapped.item.id);
    itemsById.set(mapped.item.id, {
      id: mapped.item.id,
      ordinal: existing?.ordinal ?? mapped.item.ordinal,
      startedAt:
        mapped.item.startedAt === null
          ? DateTime.formatIso(utc(mapped.at))
          : DateTime.formatIso(mapped.item.startedAt),
      updatedAt: DateTime.formatIso(mapped.item.updatedAt),
      nativeTurnId: mapped.nativeTurnId,
      nativeTurnOrdinal: mapped.nativeTurnOrdinal,
      nativeOrder: mapped.order,
      withinTurnOrder: withinTurnOrder.get(mapped.item.id) ?? mapped.order[0],
    });
  }

  return Array.from(itemsById.values())
    .toSorted((left, right) => {
      const leftAt = Date.parse(left.startedAt ?? left.updatedAt ?? "");
      const rightAt = Date.parse(right.startedAt ?? right.updatedAt ?? "");
      const leftHasTime = Number.isFinite(leftAt);
      const rightHasTime = Number.isFinite(rightAt);
      if (leftHasTime && rightHasTime && leftAt !== rightAt) return leftAt - rightAt;
      if (leftHasTime !== rightHasTime) return leftHasTime ? -1 : 1;
      const leftTurnOrder = left.nativeTurnOrdinal ?? Number.MAX_SAFE_INTEGER;
      const rightTurnOrder = right.nativeTurnOrdinal ?? Number.MAX_SAFE_INTEGER;
      if (leftTurnOrder !== rightTurnOrder) return leftTurnOrder - rightTurnOrder;
      const [leftItemOrder, leftSubItemOrder] = left.nativeOrder ?? [left.withinTurnOrder, 0];
      const [rightItemOrder, rightSubItemOrder] = right.nativeOrder ?? [right.withinTurnOrder, 0];
      if (leftItemOrder !== rightItemOrder) return leftItemOrder - rightItemOrder;
      if (leftSubItemOrder !== rightSubItemOrder) return leftSubItemOrder - rightSubItemOrder;
      return left.ordinal - right.ordinal || String(left.id).localeCompare(String(right.id));
    })
    .map(({ id }) => id);
}

export function appThreadIdFor(instanceId: ProviderInstanceId, nativeThreadId: string): ThreadId {
  if (instanceId === DEFAULT_CODEX_INSTANCE) {
    return ThreadId.make(`codex:${nativeThreadId}`);
  }
  return ThreadId.make(`${IMPORT_PREFIX}${instanceId}:${nativeThreadId}`);
}

export function nativeConversationHeadRefFor(
  latestTurnId: string | null,
  existing: OrchestrationV2ProviderThread["nativeConversationHeadRef"] | undefined,
) {
  // thread/list can omit turns; keep the head learned from thread/read.
  return latestTurnId === null ? (existing ?? null) : nativeItemRef(latestTurnId);
}

export function nativeThreadSettlementFor(
  latestTurnStatus: string | undefined,
  existing: Pick<OrchestrationV2AppThread, "settledOverride" | "unsettledAt">,
  settledAt: DateTime.Utc,
): Pick<OrchestrationV2AppThread, "settledOverride" | "settledAt" | "unsettledAt"> {
  if (latestTurnStatus === "inProgress") {
    return {
      settledOverride: existing.settledOverride === "active" ? "active" : null,
      settledAt: null,
      unsettledAt: existing.unsettledAt ?? settledAt,
    };
  }
  return { settledOverride: "settled", settledAt, unsettledAt: null };
}

export function nativeThreadSyncPriorityFor(
  existing: Pick<OrchestrationV2AppThread, "settledOverride"> | null,
  nativeThreadActive = false,
  historyMappingNeedsRemap = false,
): number {
  if (!historyMappingNeedsRemap) {
    if (nativeThreadActive) return 0;
    if (existing?.settledOverride === "active") return 1;
  }
  return existing === null ? 3 : 2;
}

export function nativeHistoryTurnStatusForThread(input: {
  readonly nativeTurnId: string;
  readonly latestNativeTurnId: string | null;
  readonly turnStatus: string;
}): string {
  return input.turnStatus === "inProgress" && input.nativeTurnId !== input.latestNativeTurnId
    ? "interrupted"
    : input.turnStatus;
}

export function nativeTurnIdsForStaleRunningRuns(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly latestNativeTurnId: string | null | undefined;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "providerThreadId" | "activeAttemptId" | "status">
  >;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "providerTurnId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "providerThreadId" | "runAttemptId" | "nativeTurnRef">
  >;
}): ReadonlyArray<string> {
  if (input.latestNativeTurnId == null) return [];
  const turnIds = new Set<string>();
  for (const run of input.runs) {
    if (run.providerThreadId !== input.providerThreadId || run.status !== "running") continue;
    const attempt = input.attempts.find((candidate) => candidate.id === run.activeAttemptId);
    if (attempt === undefined) continue;
    const providerTurn = input.providerTurns.find(
      (candidate) =>
        candidate.providerThreadId === input.providerThreadId &&
        (candidate.id === attempt.providerTurnId || candidate.runAttemptId === attempt.id),
    );
    if (
      providerTurn?.nativeTurnRef?.driver === CODEX &&
      providerTurn.nativeTurnRef.strength === "strong" &&
      providerTurn.nativeTurnRef.nativeId !== null &&
      providerTurn.nativeTurnRef.nativeId !== input.latestNativeTurnId
    ) {
      turnIds.add(providerTurn.nativeTurnRef.nativeId);
    }
  }
  return [...turnIds];
}

export function nativeTurnIdsForDuplicateRuns(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "id" | "providerThreadId" | "activeAttemptId" | "status">
  >;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "providerTurnId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "providerThreadId" | "runAttemptId" | "nativeTurnRef">
  >;
}): ReadonlyArray<string> {
  const attemptsById = new Map(input.attempts.map((attempt) => [attempt.id, attempt] as const));
  const providerTurnsById = new Map(input.providerTurns.map((turn) => [turn.id, turn] as const));
  const runIdsByNativeTurnId = new Map<string, Set<RunId>>();
  for (const run of input.runs) {
    if (
      run.providerThreadId !== input.providerThreadId ||
      run.status === "cancelled" ||
      run.status === "interrupted" ||
      run.status === "rolled_back" ||
      run.activeAttemptId === null
    ) {
      continue;
    }
    const attempt = attemptsById.get(run.activeAttemptId);
    const providerTurn =
      attempt?.providerTurnId === null || attempt?.providerTurnId === undefined
        ? input.providerTurns.find((turn) => turn.runAttemptId === run.activeAttemptId)
        : providerTurnsById.get(attempt.providerTurnId);
    const nativeTurnRef = providerTurn?.nativeTurnRef;
    if (
      providerTurn?.providerThreadId !== input.providerThreadId ||
      nativeTurnRef?.driver !== CODEX ||
      nativeTurnRef.strength !== "strong" ||
      nativeTurnRef.nativeId === null
    ) {
      continue;
    }
    const runIds = runIdsByNativeTurnId.get(nativeTurnRef.nativeId) ?? new Set<RunId>();
    runIds.add(run.id);
    runIdsByNativeTurnId.set(nativeTurnRef.nativeId, runIds);
  }
  return Array.from(runIdsByNativeTurnId)
    .filter(([, runIds]) => runIds.size > 1)
    .map(([nativeTurnId]) => nativeTurnId);
}

export function hasStaleNativeRunningRun(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly latestNativeTurnId: string | null | undefined;
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2Run, "providerThreadId" | "activeAttemptId" | "status">
  >;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "providerTurnId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "providerThreadId" | "runAttemptId" | "nativeTurnRef">
  >;
}): boolean {
  return nativeTurnIdsForStaleRunningRuns(input).length > 0;
}

export function nativeHistoryRunningRunsMissing<
  TRun extends Pick<OrchestrationV2Run, "id" | "providerThreadId" | "activeAttemptId" | "status">,
>(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly retainedNativeTurnIds: ReadonlySet<string>;
  readonly runs: ReadonlyArray<TRun>;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "providerTurnId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "providerThreadId" | "runAttemptId" | "nativeTurnRef">
  >;
}): ReadonlyArray<TRun> {
  return input.runs.filter((run) => {
    if (run.providerThreadId !== input.providerThreadId || run.status !== "running") return false;
    const attempt = input.attempts.find((candidate) => candidate.id === run.activeAttemptId);
    if (attempt === undefined) return false;
    const providerTurn = input.providerTurns.find(
      (candidate) =>
        candidate.providerThreadId === input.providerThreadId &&
        (candidate.id === attempt.providerTurnId || candidate.runAttemptId === attempt.id),
    );
    const nativeTurnRef = providerTurn?.nativeTurnRef;
    return (
      nativeTurnRef?.driver === CODEX &&
      nativeTurnRef.strength === "strong" &&
      nativeTurnRef.nativeId !== null &&
      !input.retainedNativeTurnIds.has(nativeTurnRef.nativeId)
    );
  });
}

export function nativeHistoryDuplicateRuns<
  TRun extends Pick<OrchestrationV2Run, "id" | "providerThreadId" | "activeAttemptId" | "status">,
>(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly canonicalRunIdsByNativeTurnId: ReadonlyMap<string, RunId>;
  readonly runs: ReadonlyArray<TRun>;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "providerTurnId">>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "providerThreadId" | "nativeTurnRef">
  >;
}): ReadonlyArray<TRun> {
  const attemptsById = new Map(input.attempts.map((attempt) => [attempt.id, attempt] as const));
  const providerTurnsById = new Map(input.providerTurns.map((turn) => [turn.id, turn] as const));
  return input.runs.filter((run) => {
    if (
      run.providerThreadId !== input.providerThreadId ||
      run.status === "cancelled" ||
      run.status === "interrupted" ||
      run.status === "rolled_back"
    ) {
      return false;
    }
    const attempt =
      run.activeAttemptId === null ? undefined : attemptsById.get(run.activeAttemptId);
    const providerTurn =
      attempt?.providerTurnId === null || attempt?.providerTurnId === undefined
        ? undefined
        : providerTurnsById.get(attempt.providerTurnId);
    const nativeTurnRef = providerTurn?.nativeTurnRef;
    if (
      providerTurn?.providerThreadId !== input.providerThreadId ||
      nativeTurnRef?.driver !== CODEX ||
      nativeTurnRef.strength !== "strong" ||
      nativeTurnRef.nativeId === null
    ) {
      return false;
    }
    const canonicalRunId = input.canonicalRunIdsByNativeTurnId.get(nativeTurnRef.nativeId);
    return canonicalRunId !== undefined && canonicalRunId !== run.id;
  });
}

export function runCodexNativeThreadSyncWorkers(
  priorityQueue: Queue.Queue<ThreadId>,
  backgroundQueue: Queue.Queue<ThreadId>,
  process: (threadId: ThreadId) => Effect.Effect<void>,
) {
  const worker = (queue: Queue.Queue<ThreadId>) =>
    Effect.forever(Queue.take(queue).pipe(Effect.flatMap(process)));
  return Effect.all([worker(priorityQueue), worker(backgroundQueue)], {
    concurrency: 2,
    discard: true,
  });
}

export function shouldSyncNativeThreadHistory(input: {
  readonly becameActive: boolean;
  readonly nativeThreadActive?: boolean;
  readonly nativeThreadBecameIdle?: boolean;
  readonly nativeThreadNeedsStatusReconciliation?: boolean;
  readonly nativeHeadChanged?: boolean;
  readonly historyMappingVersion?: number;
  readonly historyMappingDeferred?: boolean;
  readonly timelineOrderVersion?: number;
  readonly historySyncUpdatedAt?: string;
  readonly historySyncCatalogUpdatedAt?: string;
  readonly catalogUpdatedAt?: string;
  readonly projectNeedsRemap?: boolean;
  readonly hasExistingThread: boolean;
  readonly previousUpdatedAt?: string | null;
  readonly nativeUpdatedAt: string;
}): boolean {
  // Live notifications can be missed across App Server connections, so reconcile active turns
  // from the latest native turn on each catalog pass.
  return (
    input.becameActive ||
    input.nativeThreadBecameIdle === true ||
    input.nativeThreadNeedsStatusReconciliation === true ||
    input.nativeHeadChanged === true ||
    input.nativeThreadActive === true ||
    input.timelineOrderVersion !== NATIVE_TIMELINE_ORDER_VERSION ||
    shouldRemapNativeHistory(input.historyMappingVersion, input.historyMappingDeferred === true) ||
    input.historySyncUpdatedAt === undefined ||
    (input.catalogUpdatedAt !== undefined &&
      input.historySyncCatalogUpdatedAt !== input.catalogUpdatedAt) ||
    input.projectNeedsRemap === true ||
    (input.hasExistingThread && input.previousUpdatedAt !== input.nativeUpdatedAt)
  );
}

function shouldRemapNativeHistory(version: number | undefined, deferred: boolean): boolean {
  return (
    version !== HISTORY_MAPPING_VERSION &&
    (!deferred || version === PREVIOUS_HISTORY_MAPPING_VERSION)
  );
}

export function nativeThreadSyncRequestFor(input: {
  readonly becameActive: boolean;
  readonly nativeThreadActive: boolean;
  readonly nativeThreadBecameIdle: boolean;
  readonly nativeThreadNeedsStatusReconciliation: boolean;
  readonly needsHistoryRemap: boolean;
  readonly projectNeedsRemap: boolean;
  readonly needsResume: boolean;
}): { readonly force: boolean; readonly priority: boolean; readonly resume: boolean } {
  return {
    force:
      input.nativeThreadActive ||
      input.becameActive ||
      input.nativeThreadBecameIdle ||
      input.nativeThreadNeedsStatusReconciliation ||
      input.needsHistoryRemap ||
      input.projectNeedsRemap,
    priority:
      !input.needsHistoryRemap &&
      (input.nativeThreadActive ||
        input.nativeThreadBecameIdle ||
        input.nativeThreadNeedsStatusReconciliation),
    resume: input.becameActive || input.needsResume,
  };
}

export function shouldResumeNativeTurn(input: {
  readonly threadId: ThreadId;
  readonly nativeTurnId: string | null;
  readonly active: boolean;
  readonly attachedNativeTurnKeys: ReadonlySet<string>;
}): boolean {
  return (
    input.active &&
    input.nativeTurnId !== null &&
    !input.attachedNativeTurnKeys.has(`${input.threadId}:${input.nativeTurnId}`)
  );
}

export function nativeResumeMessageFor(input: {
  readonly runMessageId: MessageId;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}): ProviderAdapter.ProviderAdapterV2TurnMessage {
  const message = input.messages.find(
    (candidate) => candidate.id === input.runMessageId && candidate.role === "user",
  );
  return {
    messageId: input.runMessageId,
    text: message?.text ?? "",
    attachments: message?.attachments ?? [],
    createdBy: message?.createdBy ?? "user",
    creationSource: message?.creationSource ?? "provider",
    ...(message?.scheduledTaskId === undefined ? {} : { scheduledTaskId: message.scheduledTaskId }),
    ...(message?.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
  };
}

export function nativeActiveRunEventMatches(input: {
  readonly event: ProviderAdapter.ProviderAdapterV2Event;
  readonly runId: RunId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
}): boolean {
  const { event, runId, providerThreadId, providerTurnId } = input;
  switch (event.type) {
    case "app_thread.created":
    case "provider_session.updated":
      return false;
    case "provider_thread.updated":
      return event.providerThread.id === providerThreadId;
    case "provider_turn.updated":
      return event.providerTurn.id === providerTurnId;
    case "node.updated":
      return event.node.runId === runId;
    case "subagent.updated":
      return event.subagent.runId === runId;
    case "message.updated":
      return event.message.runId === runId;
    case "turn_item.updated":
      return event.turnItem.runId === runId;
    case "command_output.delta":
      return false;
    case "runtime_request.updated":
      return event.runtimeRequest.providerTurnId === providerTurnId;
    case "plan.updated":
      return event.plan.runId === runId;
    case "turn.terminal":
      return event.providerThreadId === providerThreadId && event.providerTurnId === providerTurnId;
  }
}

export function nativeActiveRunEvents(
  events: Stream.Stream<
    ProviderAdapter.ProviderAdapterV2Event,
    ProviderAdapter.ProviderAdapterV2Error
  >,
  matches: (event: ProviderAdapter.ProviderAdapterV2Event) => boolean,
) {
  return events.pipe(
    Stream.filter(matches),
    Stream.takeUntil((event) => event.type === "turn.terminal"),
  );
}

export function shouldDeferNativeHistoryRemap(input: {
  readonly historyMappingVersion?: number;
  readonly historyMappingDeferred?: boolean;
  readonly turnItemCount: number;
}): boolean {
  return (
    input.historyMappingVersion !== HISTORY_MAPPING_VERSION &&
    input.historyMappingVersion !== PREVIOUS_HISTORY_MAPPING_VERSION &&
    input.historyMappingDeferred !== true &&
    input.turnItemCount > MAX_FULL_HISTORY_REMAP_ITEMS
  );
}

export function nativeRootTurnIdsWithConflictingRuns(input: {
  readonly turns: ReadonlyArray<Pick<NativeTurn, "nativeId" | "rootNativeId">>;
  readonly existingRunIdByNativeTurnId: ReadonlyMap<string, string>;
}): ReadonlySet<string> {
  const firstRootByRunId = new Map<string, string>();
  const conflictingRootIds = new Set<string>();
  for (const turn of input.turns) {
    const runId = input.existingRunIdByNativeTurnId.get(turn.nativeId);
    if (runId === undefined) continue;
    const rootNativeTurnId = rootNativeTurnIdFor(turn);
    const firstRootId = firstRootByRunId.get(runId);
    if (firstRootId === undefined) {
      firstRootByRunId.set(runId, rootNativeTurnId);
    } else if (firstRootId !== rootNativeTurnId) {
      conflictingRootIds.add(rootNativeTurnId);
    }
  }
  return conflictingRootIds;
}

export function nativeTurnIdsToSkipForHistoryRead(input: {
  readonly historyMappingVersion?: number;
  readonly existingNativeTurnIds: ReadonlyArray<string>;
  readonly latestNativeTurnId?: string | null;
  readonly nativeTurnIdsToReconcile?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  if (input.historyMappingVersion !== HISTORY_MAPPING_VERSION) return [];
  const nativeTurnIdsToReconcile = new Set(input.nativeTurnIdsToReconcile ?? []);
  return input.existingNativeTurnIds.filter(
    (nativeTurnId) =>
      nativeTurnId !== input.latestNativeTurnId && !nativeTurnIdsToReconcile.has(nativeTurnId),
  );
}

export function shouldReusePreviousNativeRun(input: {
  readonly hasUserMessage: boolean;
  readonly hasExistingRun: boolean;
  readonly hasPreviousRun: boolean;
  readonly sameRootTurn: boolean;
}): boolean {
  return (
    !input.hasUserMessage && !input.hasExistingRun && input.hasPreviousRun && input.sameRootTurn
  );
}

export function rootNativeTurnIdFor(turn: Pick<NativeTurn, "nativeId" | "rootNativeId">) {
  return turn.rootNativeId ?? turn.nativeId;
}

export function nativeAttemptProviderTurnIdForHistoryTurn(input: {
  readonly nativeTurnId: string;
  readonly rootNativeTurnId: string;
  readonly providerTurnId: ProviderTurnId;
  readonly rootProviderTurnId?: ProviderTurnId;
}): ProviderTurnId {
  return input.nativeTurnId !== input.rootNativeTurnId && input.rootProviderTurnId !== undefined
    ? input.rootProviderTurnId
    : input.providerTurnId;
}

export function nativeRunMatchesRootTurn(input: {
  readonly runStartedAt: string | null | undefined;
  readonly rootTurnStartedAt: string;
}): boolean {
  return input.runStartedAt === input.rootTurnStartedAt;
}

export function nativeRunMappingForHistoryTurn<
  TRun extends Pick<
    OrchestrationV2Run,
    | "id"
    | "ordinal"
    | "providerThreadId"
    | "activeAttemptId"
    | "status"
    | "startedAt"
    | "requestedAt"
  >,
  TAttempt extends Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerTurnId">,
>(input: {
  readonly providerThreadId: ProviderThreadId;
  readonly nativeTurnId: string;
  readonly rootNativeTurnId: string;
  readonly runs: ReadonlyArray<TRun>;
  readonly attempts: ReadonlyArray<TAttempt>;
  readonly providerTurns: ReadonlyArray<
    Pick<OrchestrationV2ProviderTurn, "id" | "providerThreadId" | "runAttemptId" | "nativeTurnRef">
  >;
}):
  | {
      readonly attempt: TAttempt;
      readonly run: TRun;
      readonly hasExactProviderTurnAssociation: boolean;
    }
  | undefined {
  const mappingTurn =
    input.providerTurns.find(
      (turn) =>
        turn.providerThreadId === input.providerThreadId &&
        turn.nativeTurnRef?.driver === CODEX &&
        turn.nativeTurnRef.nativeId === input.rootNativeTurnId,
    ) ??
    input.providerTurns.find(
      (turn) =>
        turn.providerThreadId === input.providerThreadId &&
        turn.nativeTurnRef?.driver === CODEX &&
        turn.nativeTurnRef.nativeId === input.nativeTurnId,
    );
  if (mappingTurn === undefined) return undefined;

  const runsById = new Map(input.runs.map((run) => [run.id, run] as const));
  const attemptsById = new Map(input.attempts.map((attempt) => [attempt.id, attempt] as const));
  const exactCandidates = input.attempts.flatMap((attempt) => {
    if (attempt.providerTurnId !== mappingTurn.id) return [];
    const run = runsById.get(attempt.runId);
    return run?.providerThreadId === input.providerThreadId && run.status !== "rolled_back"
      ? [{ attempt, run }]
      : [];
  });
  exactCandidates.sort((left, right) => right.run.ordinal - left.run.ordinal);
  const exactCandidate = exactCandidates[0];
  if (exactCandidate !== undefined) {
    return {
      ...exactCandidate,
      hasExactProviderTurnAssociation: true,
    };
  }

  const pointedAttempt =
    mappingTurn.runAttemptId === null ? undefined : attemptsById.get(mappingTurn.runAttemptId);
  if (pointedAttempt === undefined) return undefined;
  // For root turns, a provider-turn link to another turn's attempt is stale. A child turn can
  // intentionally point at its root attempt when the root provider-turn record is unavailable.
  if (
    pointedAttempt.providerTurnId !== mappingTurn.id &&
    input.rootNativeTurnId === input.nativeTurnId
  ) {
    return undefined;
  }
  const pointedRun = runsById.get(pointedAttempt.runId);
  return pointedRun?.providerThreadId === input.providerThreadId &&
    pointedRun.status !== "rolled_back"
    ? {
        attempt: pointedAttempt,
        run: pointedRun,
        hasExactProviderTurnAssociation: pointedAttempt.providerTurnId === mappingTurn.id,
      }
    : undefined;
}

export function shouldMaterializeNativeTurn(input: {
  readonly hasUserMessage: boolean;
  readonly hasExistingRun: boolean;
  readonly hasPreviousRun: boolean;
  readonly startsRootTurn: boolean;
}): boolean {
  return (
    input.hasUserMessage || input.hasExistingRun || input.hasPreviousRun || input.startsRootTurn
  );
}

export function createNativeProviderTurnOrdinalAllocator(existingOrdinals: ReadonlyArray<number>) {
  let nextOrdinal = Math.max(0, ...existingOrdinals);
  return () => ++nextOrdinal;
}

export function uniqueAvailableProjectIdForMissingNativeCwd(input: {
  readonly cwd: string;
  readonly candidates: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }>;
  readonly availableWorkspaceRoots: ReadonlySet<string>;
}): ProjectId | undefined {
  const cwdName = input.cwd.split(/[\\/]/u).findLast((part) => part.length > 0);
  if (cwdName === undefined) return undefined;
  const matches = input.candidates.filter(
    (project) =>
      project.workspaceRoot !== input.cwd &&
      project.workspaceRoot.split(/[\\/]/u).findLast((part) => part.length > 0) === cwdName &&
      input.availableWorkspaceRoots.has(project.workspaceRoot),
  );
  return matches.length === 1 ? matches.at(0)?.projectId : undefined;
}

function legacyNativeThreadIdFor(
  threadId: ThreadId,
  instanceId: ProviderInstanceId,
): string | undefined {
  const prefix = "codex:";
  const value = String(threadId);
  return instanceId === DEFAULT_CODEX_INSTANCE && value.startsWith(prefix)
    ? value.slice(prefix.length)
    : undefined;
}

function titleFor(thread: NativeThread): string {
  return thread.title?.trim() || thread.preview.trim() || "Codex thread";
}

export function modelSelectionFor(
  thread: NativeThread,
  instanceId: ProviderInstanceId,
  existing?: OrchestrationV2AppThread["modelSelection"],
) {
  const reasoningEffort = thread.reasoningEffort?.trim();
  const existingOptions = existing?.options;
  const options = Array.isArray(existingOptions)
    ? existingOptions.filter((option) => option.id !== "reasoningEffort")
    : Object.entries(existingOptions ?? {}).flatMap(([id, value]) =>
        id !== "reasoningEffort" && (typeof value === "string" || typeof value === "boolean")
          ? [{ id, value }]
          : [],
      );
  if (reasoningEffort) options.push({ id: "reasoningEffort", value: reasoningEffort });
  return {
    instanceId,
    model: thread.model?.trim() || DEFAULT_MODEL_BY_PROVIDER[CODEX] || DEFAULT_MODEL,
    ...(options.length === 0 ? {} : { options }),
  };
}

export function synchronizedNativeThreadForHistory(input: {
  readonly existing: OrchestrationV2AppThread;
  readonly native: NativeThread;
  readonly instanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly projectId?: ProjectId;
  readonly latestTurnStatus?: string;
  readonly historyUpdatedAt: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    ...input.existing,
    ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
    title: titleFor(input.native),
    providerInstanceId: input.instanceId,
    modelSelection: modelSelectionFor(
      input.native,
      input.instanceId,
      input.existing.modelSelection,
    ),
    activeProviderThreadId: input.providerThreadId,
    updatedAt:
      epoch(input.existing.updatedAt) < epoch(input.historyUpdatedAt)
        ? input.historyUpdatedAt
        : input.existing.updatedAt,
    ...nativeThreadSettlementFor(input.latestTurnStatus, input.existing, input.historyUpdatedAt),
  };
}

export function nativeThreadLineageFor(input: {
  readonly native: NativeThread;
  readonly instanceId: ProviderInstanceId;
  readonly threadId: ThreadId;
  readonly parentRootThreadId?: ThreadId;
  readonly sourceProviderThreadId?: ProviderThreadId;
  readonly existing?: Pick<OrchestrationV2AppThread, "lineage" | "forkedFrom">;
}): Pick<OrchestrationV2AppThread, "lineage" | "forkedFrom"> {
  const isSubagent = input.native.parentNativeId !== null;
  const parentNativeId = isSubagent
    ? input.native.parentNativeId
    : (input.native.forkedFromNativeId ?? null);
  if (parentNativeId === null) {
    return (
      input.existing ?? {
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: input.threadId,
        },
        forkedFrom: null,
      }
    );
  }

  const parentThreadId = appThreadIdFor(input.instanceId, parentNativeId);
  const lineage: OrchestrationV2AppThread["lineage"] = {
    parentThreadId,
    relationshipToParent: isSubagent ? "subagent" : "fork",
    rootThreadId: input.parentRootThreadId ?? parentThreadId,
  };
  if (isSubagent) return { lineage, forkedFrom: null };

  const existingFork = input.existing?.forkedFrom;
  const forkedFrom =
    existingFork?.type === "run" && existingFork.threadId === parentThreadId
      ? existingFork
      : input.sourceProviderThreadId === undefined
        ? null
        : { type: "provider_thread" as const, providerThreadId: input.sourceProviderThreadId };
  return { lineage, forkedFrom };
}

function nativeWebSearchPatterns(
  item: Extract<NativeHistoryItem, { type: "webSearch" }>,
): ReadonlyArray<string> {
  const action = item.action;
  const candidates =
    action == null
      ? [item.query]
      : action.type === "search"
        ? [...(action.queries ?? []), action.query, item.query]
        : action.type === "openPage"
          ? [action.url, item.query]
          : action.type === "findInPage"
            ? [action.pattern, action.url, item.query]
            : [item.query];
  return Array.from(
    new Set(
      candidates.flatMap((value) => {
        const trimmed = value?.trim();
        return trimmed ? [trimmed] : [];
      }),
    ),
  );
}

export function providerStatusFor(thread: {
  readonly archived: boolean;
  readonly status: string;
  readonly latestTurn?: { readonly status: string } | null;
}): OrchestrationV2ProviderThread["status"] {
  if (thread.archived) return "archived";
  if (thread.status === "systemError") return "error";
  if (thread.status === "active" || thread.latestTurn?.status === "inProgress") return "active";
  return "idle";
}

export function nativeHistoryRunIdsRemoved(input: {
  readonly runs: ReadonlyArray<{
    readonly id: string;
    readonly ordinal: number;
    readonly nativeTurnId: string | null;
  }>;
  readonly retainedTurnIds: ReadonlySet<string>;
}): ReadonlyArray<string> {
  const lastRetainedOrdinal = input.runs.reduce(
    (last, run) =>
      run.nativeTurnId !== null && input.retainedTurnIds.has(run.nativeTurnId)
        ? Math.max(last, run.ordinal)
        : last,
    0,
  );
  return input.runs
    .filter((run) =>
      run.nativeTurnId === null
        ? run.ordinal > lastRetainedOrdinal
        : !input.retainedTurnIds.has(run.nativeTurnId),
    )
    .map((run) => run.id);
}

function runsRemovedFromNativeHistory(input: {
  readonly records: ThreadRecords;
  readonly providerThreadId: ProviderThreadId;
  readonly retainedTurnIds: ReadonlySet<string>;
}): ReadonlyArray<OrchestrationV2Run> {
  const nativeTurnIdFor = (run: OrchestrationV2Run) => {
    const attempt = input.records.attempts.find(
      (candidate) => candidate.id === run.activeAttemptId,
    );
    if (attempt === undefined) return null;
    const ref = input.records.providerTurns.find(
      (turn) =>
        turn.providerThreadId === input.providerThreadId &&
        (turn.id === attempt.providerTurnId || turn.runAttemptId === attempt.id),
    )?.nativeTurnRef;
    return ref?.driver === CODEX && ref.strength === "strong" ? ref.nativeId : null;
  };
  const settled = input.records.runs.flatMap((run) =>
    run.providerThreadId === input.providerThreadId &&
    (run.status === "completed" || run.status === "interrupted" || run.status === "failed")
      ? [{ run, nativeTurnId: nativeTurnIdFor(run) }]
      : [],
  );
  const removedRunIds = new Set(
    nativeHistoryRunIdsRemoved({
      runs: settled.map(({ run, nativeTurnId }) => ({
        id: run.id,
        ordinal: run.ordinal,
        nativeTurnId,
      })),
      retainedTurnIds: input.retainedTurnIds,
    }),
  );
  return settled.flatMap(({ run }) => (removedRunIds.has(run.id) ? [run] : []));
}

function runStatusFor(
  status: string,
): Extract<OrchestrationV2Run["status"], "running" | "completed" | "failed" | "interrupted"> {
  switch (status) {
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "interrupted";
  }
}

export function nativeHistoryItemStatus(
  item: NativeHistoryItem,
  turnStatus: string,
  completedAt: number | null,
  isLatestItem: boolean,
) {
  const nativeStatus = "status" in item ? String(item.status) : null;
  if (nativeStatus === "inProgress" || nativeStatus === "running") return "running" as const;
  if (nativeStatus === "failed" || nativeStatus === "errored") return "failed" as const;
  if (nativeStatus === "declined" || nativeStatus === "shutdown") return "cancelled" as const;
  if (nativeStatus === "interrupted") return "interrupted" as const;
  if (completedAt !== null || nativeStatus === "completed") return "completed" as const;
  const canStream =
    item.type === "agentMessage" ||
    item.type === "reasoning" ||
    item.type === "plan" ||
    item.type === "contextCompaction";
  return turnStatus === "inProgress" && isLatestItem && canStream ? "running" : "completed";
}

function nodeStatusFor(
  status: OrchestrationV2TurnItem["status"],
): OrchestrationV2ExecutionNode["status"] {
  return status === "pending" || status === "idle" ? "pending" : status;
}

function textFromUserItem(item: Extract<NativeHistoryItem, { type: "userMessage" }>): string {
  return item.content
    .flatMap((part) => {
      switch (part.type) {
        case "text":
          return part.text === "" ? [] : [part.text];
        case "localImage":
          return [`[Image attachment: ${part.path}]`];
        case "image":
          return ["[Image attachment]"];
        case "localAudio":
          return [`[Audio attachment: ${part.path}]`];
        case "audio":
          return ["[Audio attachment]"];
        case "skill":
          return [`[Skill: ${part.name}]`];
        case "mention":
          return [`[Mention: ${part.name}]`];
      }
    })
    .join("");
}

function nativeSubagentStatus(status: string): OrchestrationV2Subagent["status"] {
  switch (status) {
    case "pendingInit":
      return "pending";
    case "running":
      return "running";
    case "interrupted":
      return "interrupted";
    case "completed":
      return "completed";
    case "errored":
    case "notFound":
      return "failed";
    case "shutdown":
      return "cancelled";
    default:
      return "running";
  }
}

function nativeItemRef(nativeItemId: string) {
  return { driver: CODEX, nativeId: nativeItemId, strength: "strong" as const };
}

function eventBase(input: {
  readonly id: EventId;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly occurredAt: DateTime.Utc;
  readonly event: { readonly type: string; readonly [key: string]: unknown };
}): OrchestrationV2DomainEvent {
  return {
    ...input.event,
    id: input.id,
    threadId: input.threadId,
    providerInstanceId: input.providerInstanceId,
    occurredAt: input.occurredAt,
  } as OrchestrationV2DomainEvent;
}

const make = Effect.gen(function* () {
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const fs = yield* FileSystem.FileSystem;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
  const catalogStarted = yield* Ref.make(false);
  const layerScope = yield* Effect.scope;
  const activeNativeRunSubscriptions = yield* Ref.make(new Set<string>());
  // This is process-local: after a restart, active native turns need a fresh subscription.
  const attachedNativeTurnKeys = yield* Ref.make(new Set<string>());
  const threadSyncQueue = yield* Queue.unbounded<ThreadId>();
  const priorityThreadSyncQueue = yield* Queue.unbounded<ThreadId>();
  const pendingThreadSyncs = yield* Ref.make(
    new Map<
      ThreadId,
      {
        readonly sync: boolean;
        readonly force: boolean;
        readonly resume: boolean;
        readonly priority: boolean;
        readonly running: boolean;
        readonly catalogUpdatedAt?: string;
        readonly catalogWorkspaceRoot?: string;
      }
    >(),
  );

  const allocateEvent = (threadId: ThreadId) => ids.allocate.event({ threadId });
  const providerThreadIdFor = (instanceId: ProviderInstanceId, nativeThreadId: string) =>
    ids.derive.providerThread({
      driver: CODEX,
      providerInstanceId: instanceId,
      nativeThreadId,
    });
  const readRecords = (threadId: ThreadId, filter?: ProjectionStore.ProjectionRecordFilter) =>
    projections
      .getThreadRecords(
        threadId,
        [
          "runs",
          "attempts",
          "nodes",
          "providerThreads",
          "providerTurns",
          "messages",
          "turnItems",
          "checkpoints",
          "plans",
          "subagents",
        ],
        filter,
      )
      .pipe(
        Effect.catchTags({
          ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
        }),
      );
  const readThreadMetadata = (threadId: ThreadId) =>
    projections.getThreadRecords(threadId, ["providerThreads"]).pipe(
      Effect.catchTags({
        ProjectionStoreThreadNotFoundError: () => Effect.succeed(null),
      }),
    );
  const enqueueThreadSync = Effect.fn("CodexNativeThreadSyncService.enqueueThreadSync")(function* (
    threadId: ThreadId,
    options?: {
      readonly force?: boolean;
      readonly resume?: boolean;
      readonly priority?: boolean;
      readonly catalogUpdatedAt?: string;
      readonly catalogWorkspaceRoot?: string;
    },
  ) {
    const priority = options?.priority === true || options?.resume === true;
    const shouldQueue = yield* Ref.modify(pendingThreadSyncs, (pending) => {
      const previous = pending.get(threadId);
      const shouldPromote =
        previous !== undefined && priority && !previous.priority && !previous.running;
      const next = new Map(pending);
      const catalogUpdatedAt = options?.catalogUpdatedAt ?? previous?.catalogUpdatedAt;
      const catalogWorkspaceRoot = options?.catalogWorkspaceRoot ?? previous?.catalogWorkspaceRoot;
      next.set(threadId, {
        sync: true,
        force: options?.force === true || previous?.force === true,
        resume: options?.resume === true || previous?.resume === true,
        priority: priority || previous?.priority === true,
        running: previous?.running ?? false,
        ...(catalogUpdatedAt === undefined ? {} : { catalogUpdatedAt }),
        ...(catalogWorkspaceRoot === undefined ? {} : { catalogWorkspaceRoot }),
      });
      return [previous === undefined || shouldPromote, next] as const;
    });
    if (shouldQueue) {
      yield* Queue.offer(priority ? priorityThreadSyncQueue : threadSyncQueue, threadId).pipe(
        Effect.asVoid,
      );
    }
  });

  const ensureProject = Effect.fn("CodexNativeThreadSyncService.ensureProject")(function* (
    workspaceRoot: string,
  ) {
    const existing = yield* projects.findActiveByWorkspaceRoot(workspaceRoot);
    const realWorkspaceRoot = yield* fs.realPath(workspaceRoot).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    if (realWorkspaceRoot && Option.isSome(existing)) return { id: existing.value.projectId };
    const rows = yield* projects.list({ includeDeleted: true });
    if (
      rows.some((project) => project.workspaceRoot === workspaceRoot && project.deletedAt !== null)
    ) {
      return null;
    }
    if (!realWorkspaceRoot) {
      const cwdName = workspaceRoot.split(/[\\/]/u).findLast((part) => part.length > 0);
      const availableWorkspaceRoots = new Set(
        yield* Effect.forEach(
          rows.filter(
            (project) =>
              project.deletedAt === null &&
              project.workspaceRoot !== workspaceRoot &&
              project.workspaceRoot.split(/[\\/]/u).findLast((part) => part.length > 0) === cwdName,
          ),
          (project) =>
            fs.realPath(project.workspaceRoot).pipe(
              Effect.as(project.workspaceRoot),
              Effect.orElseSucceed(() => null),
            ),
          { concurrency: 4 },
        ).pipe(Effect.map((roots) => roots.filter((root): root is string => root !== null))),
      );
      const availableProjectId = uniqueAvailableProjectIdForMissingNativeCwd({
        cwd: workspaceRoot,
        candidates: rows.filter((project) => project.deletedAt === null),
        availableWorkspaceRoots,
      });
      if (availableProjectId !== undefined) return { id: availableProjectId };
    }
    if (Option.isSome(existing)) return { id: existing.value.projectId };
    const projectId = yield* ids.allocate.project({ fixtureName: `codex:${workspaceRoot}` });
    const commandId = yield* ids.allocate.command({
      fixtureName: "codex-native-thread-sync",
      commandName: `project:${workspaceRoot}`,
    });
    const eventId = yield* ids.allocate.event({ commandId });
    const now = yield* DateTime.now;
    const command = {
      type: "project.create" as const,
      commandId,
      projectId,
      title: workspaceRoot.split(/[\\/]/u).findLast((part) => part.length > 0) || workspaceRoot,
      workspaceRoot,
    };
    const planned = planProjectCommand({
      command,
      state: { project: undefined, workspaceOwner: undefined },
      eventId,
      now,
    });
    if (Result.isFailure(planned)) return null;
    yield* eventSink.commitProjectCommand({
      commandId,
      projectId,
      commandType: command.type,
      acceptedAt: now,
      event: planned.success,
    });
    const created = yield* projects.findActiveByWorkspaceRoot(workspaceRoot);
    return Option.isSome(created) ? { id: created.value.projectId } : null;
  });

  const providerThreadFor = (input: {
    readonly native: NativeThread;
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly existingModelSelection?: OrchestrationV2AppThread["modelSelection"];
    readonly existing?: OrchestrationV2ProviderThread;
  }): OrchestrationV2ProviderThread => {
    const { native, instanceId, threadId } = input;
    const updatedAt = utc(native.updatedAt);
    const createdAt = utc(native.createdAt);
    const latestTurn = native.latestTurn;
    return {
      ...input.existing,
      id: input.existing?.id ?? providerThreadIdFor(instanceId, native.nativeId),
      driver: CODEX,
      providerInstanceId: instanceId,
      providerSessionId: input.existing?.providerSessionId ?? null,
      appThreadId: threadId,
      ownerNodeId: input.existing?.ownerNodeId ?? null,
      nativeThreadRef: nativeItemRef(native.nativeId),
      nativeConversationHeadRef: nativeConversationHeadRefFor(
        latestTurn?.nativeId ?? null,
        input.existing?.nativeConversationHeadRef,
      ),
      status: providerStatusFor(native),
      firstRunOrdinal: input.existing?.firstRunOrdinal ?? null,
      lastRunOrdinal: input.existing?.lastRunOrdinal ?? null,
      handoffIds: input.existing?.handoffIds ?? [],
      forkedFrom:
        native.parentNativeId === null && native.forkedFromNativeId
          ? {
              providerThreadId: providerThreadIdFor(instanceId, native.forkedFromNativeId),
            }
          : (input.existing?.forkedFrom ?? null),
      pendingBackgroundTasks: input.existing?.pendingBackgroundTasks ?? [],
      contextUsage: input.existing?.contextUsage ?? null,
      nativeMetadata: {
        ...input.existing?.nativeMetadata,
        modelSelection: modelSelectionFor(native, instanceId, input.existingModelSelection),
        title: titleFor(native),
        updatedAt: DateTime.formatIso(updatedAt),
      },
      createdAt: input.existing?.createdAt ?? createdAt,
      updatedAt,
    };
  };

  const materializeThread = Effect.fn("CodexNativeThreadSyncService.materializeThread")(function* (
    native: NativeThread,
    instanceId: ProviderInstanceId,
  ) {
    if (native.cwd.trim() === "") return;
    const project = yield* ensureProject(native.cwd).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not map a Codex thread to a T3 project", {
          nativeThreadId: native.nativeId,
          cwd: native.cwd,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (project === null) return;

    let threadId = appThreadIdFor(instanceId, native.nativeId);
    let records = yield* readThreadMetadata(threadId);
    const legacyImportThreadId = ThreadId.make(`${IMPORT_PREFIX}${instanceId}:${native.nativeId}`);
    const legacyImportRecords =
      legacyImportThreadId === threadId ? null : yield* readThreadMetadata(legacyImportThreadId);
    if (
      records === null &&
      legacyImportRecords !== null &&
      legacyImportRecords.providerThreads.some(
        (thread) => thread.nativeThreadRef?.nativeId === native.nativeId,
      )
    ) {
      threadId = legacyImportThreadId;
      records = legacyImportRecords;
    }
    if (records?.thread.deletedAt !== null && records?.thread.deletedAt !== undefined) return;
    const providerThreadId = ids.derive.providerThread({
      driver: CODEX,
      providerInstanceId: instanceId,
      nativeThreadId: native.nativeId,
    });
    const existingProviderThread = records?.providerThreads.find(
      (thread) => thread.nativeThreadRef?.nativeId === native.nativeId,
    );
    const providerThread = providerThreadFor({
      native,
      instanceId,
      threadId,
      ...(records === null ? {} : { existingModelSelection: records.thread.modelSelection }),
      ...(existingProviderThread === undefined ? {} : { existing: existingProviderThread }),
    });
    const reclaimFromThreadId =
      threadId !== legacyImportThreadId &&
      legacyImportRecords?.thread.deletedAt === null &&
      legacyImportRecords.providerThreads.some((thread) => thread.id === providerThread.id)
        ? legacyImportThreadId
        : undefined;
    const createdAt = utc(native.createdAt);
    const updatedAt = utc(native.updatedAt);
    const nativeTurnIsActive = providerStatusFor(native) === "active";
    const modelSelection = modelSelectionFor(native, instanceId, records?.thread.modelSelection);
    const parentNativeId = native.parentNativeId ?? native.forkedFromNativeId ?? null;
    const parentThreadId =
      parentNativeId === null ? null : appThreadIdFor(instanceId, parentNativeId);
    const parentRecords =
      parentThreadId === null || parentThreadId === threadId
        ? null
        : yield* readThreadMetadata(parentThreadId);
    const isSubagent = native.parentNativeId !== null;
    const relationship = nativeThreadLineageFor({
      native,
      instanceId,
      threadId,
      ...(parentRecords === null
        ? {}
        : { parentRootThreadId: parentRecords.thread.lineage.rootThreadId }),
      ...(parentNativeId === null
        ? {}
        : { sourceProviderThreadId: providerThreadIdFor(instanceId, parentNativeId) }),
      ...(records === null ? {} : { existing: records.thread }),
    });
    const appThread: OrchestrationV2AppThread = records
      ? {
          ...records.thread,
          projectId: project.id,
          title: titleFor(native),
          providerInstanceId: instanceId,
          modelSelection,
          activeProviderThreadId: providerThreadId,
          ...relationship,
          updatedAt:
            epoch(records.thread.updatedAt) < epoch(updatedAt)
              ? updatedAt
              : records.thread.updatedAt,
          archivedAt: native.archived ? (records.thread.archivedAt ?? updatedAt) : null,
          ...(nativeTurnIsActive
            ? {
                settledOverride:
                  records.thread.settledOverride === "active" ? ("active" as const) : null,
                settledAt: null,
                unsettledAt: records.thread.unsettledAt ?? updatedAt,
              }
            : {}),
          ...(isSubagent
            ? {
                createdBy: "agent" as const,
                creationSource: "provider" as const,
                lineage: {
                  parentThreadId: parentThreadId!,
                  relationshipToParent: "subagent" as const,
                  rootThreadId: parentRecords!.thread.lineage.rootThreadId,
                },
              }
            : {}),
        }
      : {
          createdBy: isSubagent ? "agent" : "system",
          creationSource: isSubagent ? "provider" : "server",
          id: threadId,
          projectId: project.id,
          title: titleFor(native),
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          pullRequests: [],
          activeProviderThreadId: providerThreadId,
          historyOrigin: "native",
          ...relationship,
          createdAt,
          updatedAt,
          archivedAt: native.archived ? updatedAt : null,
          settledOverride: nativeTurnIsActive ? null : "settled",
          settledAt: nativeTurnIsActive ? null : updatedAt,
          unsettledAt: nativeTurnIsActive ? updatedAt : null,
          snoozedUntil: null,
          snoozedAt: null,
          pinnedAt: null,
          autoSettleDisabledAt: null,
          pinOrderKey: null,
          activeOrderKey: null,
          lastVisitedAt: null,
          deletedAt: null,
        };

    const events: Array<OrchestrationV2DomainEvent> = [];
    if (records === null) {
      events.push(
        eventBase({
          id: yield* allocateEvent(threadId),
          threadId,
          providerInstanceId: instanceId,
          occurredAt: createdAt,
          event: { type: "thread.created", payload: appThread },
        }),
      );
    } else if (!Equal.equals(records.thread, appThread)) {
      events.push(
        eventBase({
          id: yield* allocateEvent(threadId),
          threadId,
          providerInstanceId: instanceId,
          occurredAt: updatedAt,
          event: { type: "thread.metadata-updated", payload: appThread },
        }),
      );
    }
    if (!Equal.equals(existingProviderThread, providerThread)) {
      events.push(
        eventBase({
          id: yield* allocateEvent(threadId),
          threadId,
          providerInstanceId: instanceId,
          occurredAt: updatedAt,
          event: { type: "provider-thread.updated", driver: CODEX, payload: providerThread },
        }),
      );
    }
    if (events.length > 0) {
      const committed = yield* eventSink.write({
        events,
        unlessNativeThreadOwned: {
          id: providerThread.id,
          driver: CODEX,
          providerInstanceId: instanceId,
          appThreadId: threadId,
          nativeThreadRef: providerThread.nativeThreadRef,
          ...(reclaimFromThreadId === undefined ? {} : { reclaimFromThreadId }),
        },
      });
      if (reclaimFromThreadId !== undefined) {
        if (committed.length === 0) {
          yield* Effect.logWarning(
            "Kept a non-empty legacy Codex import as the native thread owner",
            {
              nativeThreadId: native.nativeId,
              legacyThreadId: reclaimFromThreadId,
              canonicalThreadId: threadId,
            },
          );
          return;
        }
        const staleImport = legacyImportRecords!.thread;
        yield* eventSink.write({
          events: [
            eventBase({
              id: yield* allocateEvent(reclaimFromThreadId),
              threadId: reclaimFromThreadId,
              providerInstanceId: instanceId,
              occurredAt: updatedAt,
              event: {
                type: "thread.deleted",
                payload: {
                  ...staleImport,
                  deletedAt: staleImport.deletedAt ?? updatedAt,
                  titleRegeneration: null,
                  updatedAt,
                },
              },
            }),
          ],
        });
      }
    }

    const nativeUpdatedAt = DateTime.formatIso(updatedAt);
    const previousUpdatedAt = existingProviderThread?.nativeMetadata?.updatedAt;
    const nativeThreadActive = providerStatusFor(native) === "active";
    const nativeThreadNeedsStatusReconciliation =
      !nativeThreadActive && native.latestTurn?.status === "inProgress";
    const becameActive = nativeThreadActive && existingProviderThread?.status !== "active";
    const nativeThreadBecameIdle =
      !nativeThreadActive && existingProviderThread?.status === "active";
    const historySyncUpdatedAt = existingProviderThread?.nativeMetadata?.historySyncUpdatedAt;
    const historySyncCatalogUpdatedAt =
      existingProviderThread?.nativeMetadata?.historySyncCatalogUpdatedAt;
    const historyMappingVersion = existingProviderThread?.nativeMetadata?.historyMappingVersion;
    const historyMappingDeferred =
      existingProviderThread?.nativeMetadata?.historyMappingDeferred === true;
    const timelineOrderVersion = existingProviderThread?.nativeMetadata?.timelineOrderVersion;
    const nativeHeadChanged =
      existingProviderThread === undefined ||
      (native.latestTurn !== null &&
        (existingProviderThread.nativeConversationHeadRef?.driver === CODEX
          ? existingProviderThread.nativeConversationHeadRef.nativeId
          : null) !== native.latestTurn.nativeId);
    const nativeHead = nativeConversationHeadRefFor(
      native.latestTurn?.nativeId ?? null,
      existingProviderThread?.nativeConversationHeadRef,
    );
    if (!nativeThreadActive) {
      const threadKeyPrefix = `${threadId}:`;
      yield* Ref.update(
        attachedNativeTurnKeys,
        (current) => new Set([...current].filter((key) => !key.startsWith(threadKeyPrefix))),
      );
    }
    const nativeThreadNeedsResume = shouldResumeNativeTurn({
      threadId,
      nativeTurnId:
        nativeHead?.driver === CODEX && nativeHead.nativeId !== null ? nativeHead.nativeId : null,
      active: nativeThreadActive,
      attachedNativeTurnKeys: yield* Ref.get(attachedNativeTurnKeys),
    });
    const catalogUpdatedAt = DateTime.formatIso(updatedAt);
    const needsHistoryRemap =
      existingProviderThread !== undefined &&
      historyMappingVersion !== HISTORY_MAPPING_VERSION &&
      !historyMappingDeferred;
    const projectNeedsRemap = records !== null && records.thread.projectId !== project.id;
    if (
      nativeThreadNeedsResume ||
      shouldSyncNativeThreadHistory({
        becameActive,
        nativeThreadActive,
        nativeThreadBecameIdle,
        nativeThreadNeedsStatusReconciliation,
        nativeHeadChanged,
        ...(historyMappingVersion === undefined ? {} : { historyMappingVersion }),
        historyMappingDeferred,
        ...(timelineOrderVersion === undefined ? {} : { timelineOrderVersion }),
        ...(historySyncUpdatedAt === undefined ? {} : { historySyncUpdatedAt }),
        ...(historySyncCatalogUpdatedAt === undefined ? {} : { historySyncCatalogUpdatedAt }),
        catalogUpdatedAt,
        projectNeedsRemap,
        hasExistingThread: records !== null,
        ...(previousUpdatedAt === undefined ? {} : { previousUpdatedAt }),
        nativeUpdatedAt,
      })
    ) {
      const syncRequest = nativeThreadSyncRequestFor({
        becameActive,
        nativeThreadActive,
        nativeThreadBecameIdle,
        nativeThreadNeedsStatusReconciliation,
        needsHistoryRemap,
        projectNeedsRemap,
        needsResume: nativeThreadNeedsResume,
      });
      yield* enqueueThreadSync(threadId, {
        ...syncRequest,
        catalogUpdatedAt,
        catalogWorkspaceRoot: native.cwd,
      });
    }
  });

  const syncCatalog = Effect.fn("CodexNativeThreadSyncService.syncCatalog")(function* () {
    const available = (yield* instances.listInstances).filter(
      (instance) =>
        instance.driverKind === CODEX &&
        instance.enabled &&
        instance.orchestrationAdapter.nativeThreadManagement !== undefined,
    );
    if (available.length === 0) {
      yield* Effect.logWarning(
        "No enabled Codex App Server instances are available for thread sync",
      );
      return;
    }
    yield* Effect.forEach(
      available,
      (instance) =>
        instance.orchestrationAdapter.nativeThreadManagement!.listThreads().pipe(
          Effect.flatMap((threads) =>
            Effect.gen(function* () {
              const prioritized = yield* Effect.forEach(
                threads,
                (thread) =>
                  readThreadMetadata(appThreadIdFor(instance.instanceId, thread.nativeId)).pipe(
                    Effect.map((records) => {
                      const providerThread = records?.providerThreads.find(
                        (candidate) => candidate.nativeThreadRef?.nativeId === thread.nativeId,
                      );
                      const historyMappingNeedsRemap =
                        records === null ||
                        (providerThread !== undefined &&
                          shouldRemapNativeHistory(
                            providerThread.nativeMetadata?.historyMappingVersion,
                            providerThread.nativeMetadata?.historyMappingDeferred === true,
                          ));
                      return {
                        thread,
                        historyMappingNeedsRemap,
                        priority: nativeThreadSyncPriorityFor(
                          records?.thread ?? null,
                          thread.status === "active" ||
                            (thread.status !== "active" &&
                              thread.latestTurn?.status === "inProgress"),
                          historyMappingNeedsRemap,
                        ),
                      };
                    }),
                  ),
                { concurrency: 1 },
              );
              yield* Effect.forEach(
                prioritized.toSorted(
                  (left, right) =>
                    left.priority - right.priority ||
                    Number(left.historyMappingNeedsRemap) -
                      Number(right.historyMappingNeedsRemap) ||
                    Number(
                      left.thread.parentNativeId !== null || left.thread.forkedFromNativeId != null,
                    ) -
                      Number(
                        right.thread.parentNativeId !== null ||
                          right.thread.forkedFromNativeId != null,
                      ) ||
                    right.thread.updatedAt - left.thread.updatedAt ||
                    right.thread.createdAt - left.thread.createdAt,
                ),
                ({ thread }) =>
                  materializeThread(thread, instance.instanceId).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Could not materialize a Codex App Server thread", {
                        providerInstanceId: instance.instanceId,
                        nativeThreadId: thread.nativeId,
                        cause,
                      }),
                    ),
                  ),
                { concurrency: 1, discard: true },
              );
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not synchronize Codex App Server threads", {
              providerInstanceId: instance.instanceId,
              cause,
            }),
          ),
        ),
      { concurrency: 1, discard: true },
    );
  });

  const startCatalogSync = Effect.fn("CodexNativeThreadSyncService.startCatalogSync")(function* () {
    const shouldStart = yield* Ref.modify(catalogStarted, (started) => [!started, true] as const);
    if (!shouldStart) return;
    yield* Effect.logInfo("Starting Codex App Server native thread synchronization");
    yield* Effect.forkIn(
      Effect.forever(
        syncCatalog().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Codex App Server thread sync failed", { cause }),
          ),
          Effect.andThen(Effect.sleep("15 seconds")),
        ),
      ),
      layerScope,
    );
  });

  const syncThread = Effect.fn("CodexNativeThreadSyncService.syncThread")(function* (
    threadId: ThreadId,
    options?: {
      readonly force?: boolean;
      readonly catalogUpdatedAt?: string;
      readonly catalogWorkspaceRoot?: string;
    },
  ) {
    const metadata = yield* readThreadMetadata(threadId);
    if (metadata === null || metadata.thread.deletedAt !== null) return;
    const metadataProviderThread = metadata.providerThreads.find(
      (candidate) =>
        candidate.nativeThreadRef?.driver === CODEX && candidate.nativeThreadRef.nativeId,
    );
    const historyMappingVersion = metadataProviderThread?.nativeMetadata?.historyMappingVersion;
    const timelineOrderVersion = metadataProviderThread?.nativeMetadata?.timelineOrderVersion;
    const needsTimelineOrderRepair = timelineOrderVersion !== NATIVE_TIMELINE_ORDER_VERSION;
    const historyMappingDeferred =
      metadataProviderThread?.nativeMetadata?.historyMappingDeferred === true &&
      historyMappingVersion !== PREVIOUS_HISTORY_MAPPING_VERSION;
    const historyAlreadyMapped = historyMappingVersion === HISTORY_MAPPING_VERSION;
    const selectiveRootRemap = historyMappingVersion === PREVIOUS_HISTORY_MAPPING_VERSION;
    const needsHistoryRemap = shouldRemapNativeHistory(
      historyMappingVersion,
      historyMappingDeferred,
    );
    const historyItemCount =
      needsHistoryRemap && !selectiveRootRemap && projections.getTurnItemCount !== undefined
        ? yield* projections.getTurnItemCount(threadId)
        : null;
    const deferHistoryRemap =
      !selectiveRootRemap &&
      historyItemCount !== null &&
      shouldDeferNativeHistoryRemap({
        ...(historyMappingVersion === undefined ? {} : { historyMappingVersion }),
        historyMappingDeferred,
        turnItemCount: historyItemCount,
      });
    const incrementalHistory =
      historyAlreadyMapped || historyMappingDeferred || selectiveRootRemap || deferHistoryRemap;
    const records = yield* readRecords(
      threadId,
      incrementalHistory ? { turnItemIds: [] } : undefined,
    );
    if (records === null || records.thread.deletedAt !== null) return;
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.nativeThreadRef?.driver === CODEX && candidate.nativeThreadRef.nativeId,
    );
    const nativeThreadId =
      providerThread?.nativeThreadRef?.driver === CODEX
        ? providerThread.nativeThreadRef.nativeId
        : legacyNativeThreadIdFor(threadId, records.thread.providerInstanceId);
    if (!nativeThreadId) return;
    const syncedAt = providerThread?.nativeMetadata?.historySyncUpdatedAt;
    const syncedAtMillis = syncedAt === undefined ? Number.NaN : Date.parse(syncedAt);
    const knownUpdatedAt = Number.isFinite(syncedAtMillis) ? syncedAtMillis / 1_000 : undefined;
    const catalogUpdatedAt =
      options?.catalogUpdatedAt ?? providerThread?.nativeMetadata?.updatedAt ?? undefined;
    const historySyncCatalogUpdatedAt = providerThread?.nativeMetadata?.historySyncCatalogUpdatedAt;
    const needsCatalogHistorySync =
      catalogUpdatedAt !== undefined && historySyncCatalogUpdatedAt !== catalogUpdatedAt;
    const latestProviderTurn = records.providerTurns
      .filter((turn) => turn.providerThreadId === providerThread?.id)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0];
    const latestNativeTurnId =
      providerThread?.nativeConversationHeadRef?.driver === CODEX &&
      providerThread.nativeConversationHeadRef.nativeId !== null
        ? providerThread.nativeConversationHeadRef.nativeId
        : latestProviderTurn?.nativeTurnRef?.driver === CODEX
          ? latestProviderTurn.nativeTurnRef.nativeId
          : undefined;
    const existingNativeTurnIds = records.providerTurns.flatMap((turn) =>
      turn.providerThreadId === providerThread?.id &&
      turn.nativeTurnRef?.driver === CODEX &&
      turn.nativeTurnRef.nativeId !== null &&
      turn.nativeTurnRef.nativeId !== undefined
        ? [turn.nativeTurnRef.nativeId]
        : [],
    );
    const nativeTurnIdsToReconcile =
      providerThread === undefined
        ? []
        : Array.from(
            new Set([
              ...nativeTurnIdsForStaleRunningRuns({
                providerThreadId: providerThread.id,
                latestNativeTurnId,
                runs: records.runs,
                attempts: records.attempts,
                providerTurns: records.providerTurns,
              }),
              ...nativeTurnIdsForDuplicateRuns({
                providerThreadId: providerThread.id,
                runs: records.runs,
                attempts: records.attempts,
                providerTurns: records.providerTurns,
              }),
            ]),
          );
    const knownNativeTurnIds = nativeTurnIdsToSkipForHistoryRead({
      ...(providerThread?.nativeMetadata?.historyMappingVersion === undefined
        ? {}
        : { historyMappingVersion: providerThread.nativeMetadata.historyMappingVersion }),
      existingNativeTurnIds,
      ...(latestNativeTurnId === undefined ? {} : { latestNativeTurnId }),
      nativeTurnIdsToReconcile,
    });
    const needsStatusReconciliation =
      (records.thread.settledOverride === "active" && latestProviderTurn?.status !== "running") ||
      nativeTurnIdsToReconcile.length > 0;
    const instance = yield* instances.getInstance(records.thread.providerInstanceId);
    const nativeManagement = instance?.orchestrationAdapter.nativeThreadManagement;
    if (nativeManagement === undefined) return;
    let history = yield* nativeManagement.readThread({
      nativeThreadId,
      archived: records.thread.archivedAt !== null,
      knownNativeTurnIds,
      ...(knownUpdatedAt === undefined ||
      options?.force === true ||
      needsStatusReconciliation ||
      needsHistoryRemap ||
      needsTimelineOrderRepair ||
      needsCatalogHistorySync
        ? {}
        : { knownUpdatedAt }),
      ...(incrementalHistory && !needsStatusReconciliation ? { latestTurnOnly: true } : {}),
    });
    if (
      knownUpdatedAt !== undefined &&
      options?.force !== true &&
      !needsStatusReconciliation &&
      !needsHistoryRemap &&
      !needsTimelineOrderRepair &&
      !needsCatalogHistorySync &&
      history.thread.updatedAt === knownUpdatedAt
    ) {
      return;
    }
    let nativeRootTurnIdsToRebuild: ReadonlySet<string> = new Set();
    if (selectiveRootRemap) {
      const attemptById = new Map(
        records.attempts.map((attempt) => [attempt.id, attempt] as const),
      );
      const runIdByNativeTurnId = new Map<string, string>();
      for (const providerTurn of records.providerTurns) {
        if (
          providerTurn.providerThreadId !== providerThread?.id ||
          providerTurn.nativeTurnRef?.driver !== CODEX ||
          providerTurn.nativeTurnRef.nativeId == null
        ) {
          continue;
        }
        const attempt = providerTurn.runAttemptId
          ? attemptById.get(providerTurn.runAttemptId)
          : records.attempts.find((candidate) => candidate.providerTurnId === providerTurn.id);
        if (attempt !== undefined) {
          runIdByNativeTurnId.set(providerTurn.nativeTurnRef.nativeId, attempt.runId);
        }
      }
      nativeRootTurnIdsToRebuild = nativeRootTurnIdsWithConflictingRuns({
        turns: history.turns,
        existingRunIdByNativeTurnId: runIdByNativeTurnId,
      });
      const latestNativeTurnId =
        history.thread.latestTurn?.nativeId ?? history.turns.at(-1)?.nativeId;
      const turnsToRead = new Set(
        history.turns
          .filter(
            (turn) =>
              nativeRootTurnIdsToRebuild.has(rootNativeTurnIdFor(turn)) ||
              turn.nativeId === latestNativeTurnId,
          )
          .map((turn) => turn.nativeId),
      );
      const unchangedTurnIds = existingNativeTurnIds.filter((id) => !turnsToRead.has(id));
      history = yield* nativeManagement.readThread({
        nativeThreadId,
        archived: records.thread.archivedAt !== null,
        knownNativeTurnIds: unchangedTurnIds,
      });
    }
    const latestRecords = yield* readThreadMetadata(threadId);
    if (latestRecords === null) return;
    const workspaceRoot = options?.catalogWorkspaceRoot ?? history.thread.cwd;
    const project = yield* ensureProject(workspaceRoot).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not map a Codex thread to a T3 project", {
          nativeThreadId,
          cwd: workspaceRoot,
          cause,
        }).pipe(Effect.as(null)),
      ),
    );
    if (project !== null && latestRecords.thread.projectId !== project.id) {
      yield* Effect.logInfo("Remapping Codex thread to its current catalog project", {
        nativeThreadId,
        projectId: project.id,
        workspaceRoot,
      });
    }
    const latestThread = latestRecords.thread;
    const currentProviderThread = latestRecords.providerThreads.find(
      (candidate) =>
        candidate.nativeThreadRef?.driver === CODEX &&
        candidate.nativeThreadRef.nativeId === nativeThreadId,
    );
    const existingProviderThread = currentProviderThread ?? providerThread;
    const allNativeTurnIds = history.turns.map((turn) => turn.nativeId);
    const missingActiveRuns =
      existingProviderThread === undefined
        ? []
        : nativeHistoryRunningRunsMissing({
            providerThreadId: existingProviderThread.id,
            retainedNativeTurnIds: new Set(allNativeTurnIds),
            runs: records.runs,
            attempts: records.attempts,
            providerTurns: records.providerTurns,
          });
    const latestNativeTurnIdForHistory =
      history.thread.latestTurn?.nativeId ?? history.turns.at(-1)?.nativeId ?? null;
    const latestNativeTurn =
      history.turns.find((turn) => turn.nativeId === latestNativeTurnIdForHistory) ??
      history.turns.at(-1);
    const existingLatestNativeTurn = records.providerTurns.find(
      (turn) =>
        turn.providerThreadId === existingProviderThread?.id &&
        turn.nativeTurnRef?.driver === CODEX &&
        turn.nativeTurnRef.nativeId === latestNativeTurn?.nativeId,
    );
    const latestAttempt = records.attempts.find(
      (attempt) => attempt.id === existingLatestNativeTurn?.runAttemptId,
    );
    const latestRunId = latestAttempt?.runId;
    const turnItemFilter: ProjectionStore.ProjectionRecordFilter = selectiveRootRemap
      ? {
          turnItemIds: history.turns.flatMap((turn) =>
            turn.items.map((item) =>
              ids.derive.turnItemFromProviderItem({ driver: CODEX, nativeItemId: item.nativeId }),
            ),
          ),
        }
      : latestRunId
        ? { turnItemRunId: latestRunId }
        : {
            turnItemIds:
              latestNativeTurn?.items.map((item) =>
                ids.derive.turnItemFromProviderItem({ driver: CODEX, nativeItemId: item.nativeId }),
              ) ?? [],
          };
    let currentTurnItems = incrementalHistory
      ? yield* projections
          .getThreadRecords(threadId, ["turnItems"], turnItemFilter)
          .pipe(Effect.map((result) => result.turnItems))
      : records.turnItems;
    if (incrementalHistory && missingActiveRuns.length > 0) {
      const missingRunItems = yield* projections
        .getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: missingActiveRuns.map((run) => run.id),
        })
        .pipe(Effect.map((result) => result.turnItems));
      const itemsById = new Map(currentTurnItems.map((item) => [item.id, item] as const));
      for (const item of missingRunItems) itemsById.set(item.id, item);
      currentTurnItems = Array.from(itemsById.values());
    }
    const recordsForMaterialization = {
      ...records,
      turnItems: currentTurnItems,
      thread: latestThread,
      providerThreads: latestRecords.providerThreads,
    };
    const effectiveProviderThread = providerThreadFor({
      native: history.thread,
      instanceId: latestThread.providerInstanceId,
      threadId,
      existingModelSelection: latestThread.modelSelection,
      ...(existingProviderThread === undefined ? {} : { existing: existingProviderThread }),
    });
    yield* materializeHistory({
      threadId,
      instanceId: latestThread.providerInstanceId,
      providerThread: effectiveProviderThread,
      history,
      records: recordsForMaterialization,
      nativeRootTurnIdsToRebuild,
      retainedNativeTurnIds: allNativeTurnIds,
      incrementalHistory,
      needsTimelineOrderRepair,
      deferHistoryRemap,
      ...(project === null ? {} : { projectId: project.id }),
      ...(catalogUpdatedAt === undefined ? {} : { catalogUpdatedAt }),
    });
  });

  const materializeHistory = Effect.fn("CodexNativeThreadSyncService.materializeHistory")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly instanceId: ProviderInstanceId;
      readonly providerThread: OrchestrationV2ProviderThread;
      readonly history: {
        readonly thread: NativeThread;
        readonly turns: ReadonlyArray<NativeTurn>;
      };
      readonly records: ThreadRecords;
      readonly nativeRootTurnIdsToRebuild: ReadonlySet<string>;
      readonly retainedNativeTurnIds: ReadonlyArray<string>;
      readonly incrementalHistory: boolean;
      readonly needsTimelineOrderRepair: boolean;
      readonly deferHistoryRemap: boolean;
      readonly projectId?: ProjectId;
      readonly catalogUpdatedAt?: string;
    }) {
      const events: Array<OrchestrationV2DomainEvent> = [];
      const mappedTurnItems: Array<{
        readonly item: OrchestrationV2TurnItem;
        readonly at: number;
        readonly order: readonly [number, number];
        readonly nativeTurnId: string;
        readonly nativeTurnOrdinal: number;
      }> = [];
      const materializedRuns = new Map<RunId, OrchestrationV2Run>();
      const materializedAttempts = new Map<RunAttemptId, OrchestrationV2RunAttempt>();
      const materializedNodes = new Map<NodeId, OrchestrationV2ExecutionNode>();
      const canonicalRunIdsByNativeTurnId = new Map<string, RunId>();
      let previousRunContext:
        | {
            readonly run: OrchestrationV2Run;
            readonly attempt: OrchestrationV2RunAttempt;
            readonly rootNode: OrchestrationV2ExecutionNode;
            readonly rootNativeTurnId: string;
          }
        | undefined;
      const existingItemsByNativeId = new Map(
        input.records.turnItems.flatMap((item) =>
          item.nativeItemRef?.driver !== CODEX || item.nativeItemRef.nativeId === null
            ? []
            : [[item.nativeItemRef.nativeId, item] as const],
        ),
      );
      const existingByNativeTurn = new Map(
        input.records.providerTurns.flatMap((turn) =>
          turn.nativeTurnRef?.driver !== CODEX || turn.nativeTurnRef.nativeId === null
            ? []
            : [[turn.nativeTurnRef.nativeId, turn] as const],
        ),
      );
      const existingNodesById = new Map(
        input.records.nodes.map((node) => [node.id, node] as const),
      );
      const existingMessagesById = new Map(
        input.records.messages.map((message) => [message.id, message] as const),
      );
      const existingTurnItemsById = new Map(
        input.records.turnItems.map((item) => [item.id, item] as const),
      );
      const nextProviderTurnOrdinal = createNativeProviderTurnOrdinalAllocator(
        input.records.providerTurns
          .filter((turn) => turn.providerThreadId === input.providerThread.id)
          .map((turn) => turn.ordinal),
      );
      const existingSubagentsById = new Map(
        input.records.subagents.map((task) => [task.id, task] as const),
      );
      const existingMessagesByRoleAndText = new Map<
        string,
        Array<OrchestrationV2ConversationMessage>
      >();
      for (const message of input.records.messages) {
        if (message.role !== "user" && message.role !== "assistant") continue;
        const key = messageReuseKey(message.role, message.text);
        const candidates = existingMessagesByRoleAndText.get(key) ?? [];
        candidates.push(message);
        existingMessagesByRoleAndText.set(key, candidates);
      }
      const existingMessageTurnItemsByMessageId = new Map<MessageId, OrchestrationV2TurnItem>();
      const existingSubagentsByChildThreadId = new Map<ThreadId, OrchestrationV2Subagent>();
      const existingSubagentTurnItemsBySubagentId = new Map<
        OrchestrationV2Subagent["id"],
        OrchestrationV2TurnItem
      >();
      for (const item of input.records.turnItems) {
        if (
          (item.type === "user_message" || item.type === "assistant_message") &&
          !existingMessageTurnItemsByMessageId.has(item.messageId)
        ) {
          existingMessageTurnItemsByMessageId.set(item.messageId, item);
        }
        if (
          item.type === "subagent" &&
          !existingSubagentTurnItemsBySubagentId.has(item.subagentId)
        ) {
          existingSubagentTurnItemsBySubagentId.set(item.subagentId, item);
        }
      }
      for (const task of input.records.subagents) {
        if (task.childThreadId === null) continue;
        if (!existingSubagentsByChildThreadId.has(task.childThreadId)) {
          existingSubagentsByChildThreadId.set(task.childThreadId, task);
        }
      }
      const usedMessageIds = new Set<MessageId>();
      const messageIdsByNativeItemId = new Map<string, MessageId>();
      const sortedTurns = input.history.turns.toSorted(
        (left, right) => (left.startedAt ?? 0) - (right.startedAt ?? 0),
      );
      const nativeTurnsById = new Map(sortedTurns.map((turn) => [turn.nativeId, turn] as const));
      const latestTurn = sortedTurns.at(-1) ?? input.history.thread.latestTurn ?? undefined;
      const latestNativeTurnId = latestTurn?.nativeId ?? null;
      const historyUpdatedAt = utc(input.history.thread.updatedAt);
      const synchronizedThread = synchronizedNativeThreadForHistory({
        existing: input.records.thread,
        native: input.history.thread,
        instanceId: input.instanceId,
        providerThreadId: input.providerThread.id,
        ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
        ...(latestTurn === undefined
          ? {}
          : {
              latestTurnStatus: nativeHistoryTurnStatusForThread({
                nativeTurnId: latestTurn.nativeId,
                latestNativeTurnId,
                turnStatus: latestTurn.status,
              }),
            }),
        historyUpdatedAt,
      });
      if (!Equal.equals(input.records.thread, synchronizedThread)) {
        events.push(
          eventBase({
            id: yield* allocateEvent(input.threadId),
            threadId: input.threadId,
            providerInstanceId: input.instanceId,
            occurredAt: historyUpdatedAt,
            event: { type: "thread.metadata-updated", payload: synchronizedThread },
          }),
        );
      }
      let nextRunOrdinal = Math.max(0, ...input.records.runs.map((run) => run.ordinal));
      for (const [turnIndex, turn] of sortedTurns.entries()) {
        const turnStatus = nativeHistoryTurnStatusForThread({
          nativeTurnId: turn.nativeId,
          latestNativeTurnId,
          turnStatus: turn.status,
        });
        const staleInProgress = turn.status === "inProgress" && turnStatus !== "inProgress";
        const completedAtSeconds =
          turn.completedAt ??
          (staleInProgress
            ? (sortedTurns[turnIndex + 1]?.startedAt ?? input.history.thread.updatedAt)
            : null);
        const nativeUserItem = turn.items.find(
          (item) => (item.payload as NativeHistoryItem).type === "userMessage",
        );
        const userText =
          nativeUserItem === undefined
            ? ""
            : textFromUserItem(
                nativeUserItem.payload as Extract<NativeHistoryItem, { type: "userMessage" }>,
              );
        const rootNativeTurnId = rootNativeTurnIdFor(turn);
        const rootNativeTurn = nativeTurnsById.get(rootNativeTurnId);
        const startedAtSeconds = turn.startedAt ?? input.history.thread.createdAt;
        const rootStartedAtSeconds =
          rootNativeTurn?.startedAt ?? turn.startedAt ?? input.history.thread.createdAt;
        const rootStartedAt = DateTime.formatIso(utc(rootStartedAtSeconds));
        const existingNativeTurn = existingByNativeTurn.get(turn.nativeId);
        const existingRootNativeTurn = existingByNativeTurn.get(rootNativeTurnId);
        const candidateMapping = nativeRunMappingForHistoryTurn({
          providerThreadId: input.providerThread.id,
          nativeTurnId: turn.nativeId,
          rootNativeTurnId,
          runs: input.records.runs,
          attempts: input.records.attempts,
          providerTurns: input.records.providerTurns,
        });
        const candidateAttempt = candidateMapping?.attempt;
        const candidateRun = candidateMapping?.run;
        const candidateRunStartedAt = candidateRun?.startedAt ?? candidateRun?.requestedAt;
        const existingRun =
          !input.nativeRootTurnIdsToRebuild.has(rootNativeTurnId) &&
          (candidateMapping?.hasExactProviderTurnAssociation === true ||
            (candidateRunStartedAt != null &&
              nativeRunMatchesRootTurn({
                runStartedAt: DateTime.formatIso(candidateRunStartedAt),
                rootTurnStartedAt: rootStartedAt,
              })))
            ? candidateRun
            : undefined;
        const existingAttempt = existingRun === undefined ? undefined : candidateAttempt;
        const sameRootAsPrevious = previousRunContext?.rootNativeTurnId === rootNativeTurnId;
        const reusePreviousRun = shouldReusePreviousNativeRun({
          hasUserMessage: nativeUserItem !== undefined,
          hasExistingRun: existingRun !== undefined,
          hasPreviousRun: sameRootAsPrevious,
          sameRootTurn: sameRootAsPrevious,
        });
        if (
          !shouldMaterializeNativeTurn({
            hasUserMessage: nativeUserItem !== undefined,
            hasExistingRun: existingRun !== undefined,
            hasPreviousRun: reusePreviousRun,
            startsRootTurn: rootNativeTurnId === turn.nativeId,
          })
        )
          continue;
        const baseRun =
          (existingRun === undefined ? undefined : materializedRuns.get(existingRun.id)) ??
          existingRun ??
          (reusePreviousRun ? previousRunContext?.run : undefined);
        const baseAttempt =
          (existingAttempt === undefined
            ? undefined
            : materializedAttempts.get(existingAttempt.id)) ??
          existingAttempt ??
          (reusePreviousRun ? previousRunContext?.attempt : undefined);
        const baseRootNode =
          reusePreviousRun && existingRun === undefined ? previousRunContext?.rootNode : undefined;

        const runStatus = runStatusFor(turnStatus);
        const completedAt = completedAtSeconds === null ? null : utc(completedAtSeconds);
        const occurredAt =
          runStatus === "running" ? utc(startedAtSeconds) : (completedAt ?? historyUpdatedAt);
        const ordinal = baseRun?.ordinal ?? ++nextRunOrdinal;
        const runId = baseRun?.id ?? ids.derive.run({ threadId: input.threadId, ordinal });
        const attemptId = baseAttempt?.id ?? ids.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = baseRun?.rootNodeId ?? ids.derive.rootNode({ runId });
        const existingRootNode = existingNodesById.get(rootNodeId);
        const previousMaterializedNode = materializedNodes.get(rootNodeId);
        const providerTurnId =
          existingNativeTurn?.id ??
          ids.derive.providerTurn({ driver: CODEX, nativeTurnId: turn.nativeId });
        const nativeUserMessageId = nativeUserItem
          ? findOrDeriveMessageId({
              nativeItem: nativeUserItem,
              existingItemsByNativeId,
              text: userText,
              role: "user",
              existingMessages: input.records.messages,
              existingMessagesByRoleAndText,
              usedMessageIds,
              messageIdsByNativeItemId,
              deriveMessageId: (nativeItemId) =>
                ids.derive.messageFromProviderItem({ driver: CODEX, nativeItemId }),
            })
          : undefined;
        const syntheticUserMessageId = ids.derive.messageFromProviderItem({
          driver: CODEX,
          nativeItemId: `root-turn:${rootNativeTurnId}`,
        });
        const userMessageId =
          baseRun?.userMessageId !== undefined && baseRun.userMessageId !== syntheticUserMessageId
            ? baseRun.userMessageId
            : (nativeUserMessageId ?? syntheticUserMessageId);
        const attemptStatus =
          runStatus === "running"
            ? "running"
            : runStatus === "completed"
              ? "completed"
              : runStatus === "failed"
                ? "failed"
                : "interrupted";
        const run: OrchestrationV2Run = {
          ...baseRun,
          id: runId,
          threadId: input.threadId,
          ordinal,
          providerInstanceId: input.instanceId,
          modelSelection: modelSelectionFor(
            input.history.thread,
            input.instanceId,
            input.records.thread.modelSelection,
          ),
          providerThreadId: input.providerThread.id,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: runStatus,
          requestedAt: baseRun?.requestedAt ?? occurredAt,
          startedAt: baseRun?.startedAt ?? utc(rootStartedAtSeconds),
          completedAt,
          checkpointId: baseRun?.checkpointId ?? null,
          contextHandoffId: baseRun?.contextHandoffId ?? null,
        };
        const attempt: OrchestrationV2RunAttempt = {
          ...baseAttempt,
          id: attemptId,
          nativeThreadId: input.history.thread.nativeId,
          runId,
          attemptOrdinal: baseAttempt?.attemptOrdinal ?? 1,
          rootNodeId,
          providerInstanceId: input.instanceId,
          providerThreadId: input.providerThread.id,
          providerTurnId: nativeAttemptProviderTurnIdForHistoryTurn({
            nativeTurnId: turn.nativeId,
            rootNativeTurnId,
            providerTurnId,
            ...(existingRootNativeTurn === undefined
              ? {}
              : { rootProviderTurnId: existingRootNativeTurn.id }),
          }),
          reason: baseAttempt?.reason ?? "initial",
          status: attemptStatus,
          startedAt: baseAttempt?.startedAt ?? utc(rootStartedAtSeconds),
          completedAt,
        };
        const rootNode: OrchestrationV2ExecutionNode = {
          ...previousMaterializedNode,
          ...existingRootNode,
          ...baseRootNode,
          id: rootNodeId,
          threadId: input.threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: runStatus,
          countsForRun: true,
          providerThreadId: input.providerThread.id,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt:
            baseRootNode?.startedAt ??
            previousMaterializedNode?.startedAt ??
            existingRootNode?.startedAt ??
            utc(rootStartedAtSeconds),
          completedAt,
        };
        const providerTurn: OrchestrationV2ProviderTurn = {
          ...existingNativeTurn,
          id: providerTurnId,
          providerThreadId: input.providerThread.id,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: nativeItemRef(turn.nativeId),
          ordinal: existingNativeTurn?.ordinal ?? nextProviderTurnOrdinal(),
          status: runStatus === "running" ? "running" : attemptStatus,
          startedAt: existingNativeTurn?.startedAt ?? occurredAt,
          completedAt,
        };

        const previousMaterializedRun = materializedRuns.get(runId);
        const previousRun = previousMaterializedRun ?? existingRun;
        const runEventType = previousRun === undefined ? "run.created" : "run.updated";
        if (previousRun === undefined || !Equal.equals(previousRun, run)) {
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt,
              event: { type: runEventType, payload: run } as never,
            }),
          );
        }
        const previousMaterializedAttempt = materializedAttempts.get(attemptId);
        const previousAttempt = previousMaterializedAttempt ?? existingAttempt;
        const attemptEventType =
          previousAttempt === undefined ? "run-attempt.created" : "run-attempt.updated";
        if (previousAttempt === undefined || !Equal.equals(previousAttempt, attempt)) {
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt,
              event: { type: attemptEventType, payload: attempt } as never,
            }),
          );
        }
        const previousRootNode = previousMaterializedNode ?? existingRootNode;
        if (previousRootNode === undefined || !Equal.equals(previousRootNode, rootNode)) {
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt,
              event: { type: "node.updated", payload: rootNode },
            }),
          );
        }
        if (existingNativeTurn === undefined || !Equal.equals(existingNativeTurn, providerTurn)) {
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt,
              event: { type: "provider-turn.updated", payload: providerTurn },
            }),
          );
        }
        materializedRuns.set(run.id, run);
        materializedAttempts.set(attempt.id, attempt);
        materializedNodes.set(rootNode.id, rootNode);
        canonicalRunIdsByNativeTurnId.set(turn.nativeId, run.id);
        canonicalRunIdsByNativeTurnId.set(rootNativeTurnId, run.id);
        previousRunContext = { run, attempt, rootNode, rootNativeTurnId };

        for (const [itemIndex, nativeItem] of turn.items.entries()) {
          const mapped = mapNativeItem({
            nativeItem,
            threadId: input.threadId,
            ...(input.records.thread.lineage.relationshipToParent === "subagent" &&
            input.records.thread.lineage.parentThreadId !== null
              ? { senderThreadId: input.records.thread.lineage.parentThreadId }
              : {}),
            instanceId: input.instanceId,
            providerThreadId: input.providerThread.id,
            providerTurnId,
            runId,
            nodeId: rootNodeId,
            planId: PlanId.make(`codex-native:${nativeItem.nativeId}`),
            turnStatus,
            turnCompletedAt: completedAtSeconds,
            isLatestItem: itemIndex === turn.items.length - 1,
            fallbackAt: startedAtSeconds,
            existingItems: input.records.turnItems,
            existingItemsByNativeId,
            existingMessages: input.records.messages,
            existingMessagesByRoleAndText,
            existingMessageTurnItemsByMessageId,
            messageIdsByNativeItemId,
            existingSubagents: input.records.subagents,
            existingSubagentsByChildThreadId,
            existingSubagentTurnItemsBySubagentId,
            usedMessageIds,
            deriveMessageId: (nativeItemId) =>
              ids.derive.messageFromProviderItem({ driver: CODEX, nativeItemId }),
            deriveTurnItemId: (nativeItemId) =>
              ids.derive.turnItemFromProviderItem({ driver: CODEX, nativeItemId }),
            deriveNodeId: (nativeItemId) =>
              ids.derive.nodeFromProviderItem({ driver: CODEX, nativeItemId }),
            deriveProviderThreadId: (nativeThreadId) =>
              ids.derive.providerThread({
                driver: CODEX,
                providerInstanceId: input.instanceId,
                nativeThreadId,
              }),
          });
          if (mapped === null) continue;
          const at = nativeItem.startedAt ?? startedAtSeconds;
          for (const [mappedIndex, item] of mapped.turnItems.entries()) {
            mappedTurnItems.push({
              item,
              at,
              order: [itemIndex, mappedIndex],
              nativeTurnId: turn.nativeId,
              nativeTurnOrdinal: providerTurn.ordinal,
            });
          }
          for (const itemEvent of mapped.events) {
            const existing =
              itemEvent.type === "message.updated"
                ? existingMessagesById.get(itemEvent.payload.id)
                : itemEvent.type === "turn-item.updated"
                  ? existingTurnItemsById.get(itemEvent.payload.id)
                  : itemEvent.type === "node.updated"
                    ? existingNodesById.get(itemEvent.payload.id)
                    : itemEvent.type === "subagent.updated"
                      ? existingSubagentsById.get(itemEvent.payload.id)
                      : undefined;
            if (existing !== undefined && Equal.equals(existing, itemEvent.payload)) continue;
            events.push(
              eventBase({
                id: yield* allocateEvent(input.threadId),
                threadId: input.threadId,
                providerInstanceId: input.instanceId,
                occurredAt: utc(nativeItem.completedAt ?? at),
                event: itemEvent as never,
              }),
            );
          }
        }
      }

      const retainedTurnIds = new Set(input.retainedNativeTurnIds);
      const removedRuns = runsRemovedFromNativeHistory({
        records: input.records,
        providerThreadId: input.providerThread.id,
        retainedTurnIds,
      });
      if (removedRuns.length > 0) {
        const removedRunIds = new Set(removedRuns.map((run) => run.id));
        const rollbackAt = yield* DateTime.now;
        for (const checkpoint of input.records.checkpoints) {
          if (checkpoint.status !== "ready" || checkpoint.runId === null) continue;
          if (!removedRunIds.has(checkpoint.runId)) continue;
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt: rollbackAt,
              event: {
                type: "checkpoint.captured",
                payload: { ...checkpoint, status: "stale" },
              },
            }),
          );
        }
        for (const run of removedRuns) {
          const rootNode = input.records.nodes.find((node) => node.id === run.rootNodeId);
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: run.providerInstanceId,
              occurredAt: rollbackAt,
              event: {
                type: "run.updated",
                payload: { ...run, status: "rolled_back", completedAt: rollbackAt },
              },
            }),
          );
          if (rootNode !== undefined) {
            events.push(
              eventBase({
                id: yield* allocateEvent(input.threadId),
                threadId: input.threadId,
                providerInstanceId: run.providerInstanceId,
                occurredAt: rollbackAt,
                event: {
                  type: "node.updated",
                  payload: { ...rootNode, status: "rolled_back", completedAt: rollbackAt },
                },
              }),
            );
          }
        }
      }

      const missingActiveRuns = nativeHistoryRunningRunsMissing({
        providerThreadId: input.providerThread.id,
        retainedNativeTurnIds: retainedTurnIds,
        runs: input.records.runs,
        attempts: input.records.attempts,
        providerTurns: input.records.providerTurns,
      });
      const duplicateRuns = nativeHistoryDuplicateRuns({
        providerThreadId: input.providerThread.id,
        canonicalRunIdsByNativeTurnId,
        runs: input.records.runs,
        attempts: input.records.attempts,
        providerTurns: input.records.providerTurns,
      });
      const duplicateRunIds = new Set(duplicateRuns.map((run) => run.id));
      const runsToReconcile = new Map(
        [...missingActiveRuns, ...duplicateRuns].map((run) => [run.id, run] as const),
      );
      const cleanupTurnItemsById = new Map(
        input.records.turnItems.map((item) => [item.id, item] as const),
      );
      if (input.incrementalHistory && duplicateRuns.length > 0) {
        const duplicateRunItems = yield* projections
          .getThreadRecords(input.threadId, ["turnItems"], {
            turnItemRunIds: duplicateRuns.map((run) => run.id),
          })
          .pipe(Effect.map((result) => result.turnItems));
        for (const item of duplicateRunItems) cleanupTurnItemsById.set(item.id, item);
      }
      for (const run of runsToReconcile.values()) {
        const isDuplicateRun = duplicateRunIds.has(run.id);
        const runStatus: OrchestrationV2Run["status"] =
          isDuplicateRun && run.status !== "running" ? "cancelled" : "interrupted";
        const reconciledRun = {
          ...run,
          status: runStatus,
          completedAt: historyUpdatedAt,
        };
        events.push(
          eventBase({
            id: yield* allocateEvent(input.threadId),
            threadId: input.threadId,
            providerInstanceId: input.instanceId,
            occurredAt: historyUpdatedAt,
            event: { type: "run.updated", payload: reconciledRun },
          }),
        );
        materializedRuns.set(run.id, reconciledRun);

        const attempt = input.records.attempts.find(
          (candidate) => candidate.id === run.activeAttemptId,
        );
        if (
          attempt !== undefined &&
          attempt.status !== "cancelled" &&
          attempt.status !== "superseded" &&
          (isDuplicateRun || attempt.status === "running")
        ) {
          const attemptStatus: OrchestrationV2RunAttempt["status"] =
            isDuplicateRun && attempt.status !== "running" ? "cancelled" : "interrupted";
          const reconciledAttempt = {
            ...attempt,
            status: attemptStatus,
            completedAt: historyUpdatedAt,
          };
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt: historyUpdatedAt,
              event: { type: "run-attempt.updated", payload: reconciledAttempt },
            }),
          );
          materializedAttempts.set(attempt.id, reconciledAttempt);
        }

        const providerTurn = input.records.providerTurns.find(
          (candidate) =>
            candidate.providerThreadId === input.providerThread.id &&
            (candidate.runAttemptId === run.activeAttemptId ||
              candidate.id === attempt?.providerTurnId),
        );
        if (!isDuplicateRun && providerTurn?.status === "running") {
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt: historyUpdatedAt,
              event: {
                type: "provider-turn.updated",
                payload: {
                  ...providerTurn,
                  status: "interrupted",
                  completedAt: historyUpdatedAt,
                },
              },
            }),
          );
        }

        for (const node of input.records.nodes) {
          if (node.runId !== run.id) continue;
          if (
            isDuplicateRun
              ? node.status === "cancelled" || node.status === "rolled_back"
              : node.status !== "running"
          ) {
            continue;
          }
          const nodeStatus: OrchestrationV2ExecutionNode["status"] = isDuplicateRun
            ? "cancelled"
            : "interrupted";
          const reconciledNode = {
            ...node,
            status: nodeStatus,
            completedAt: historyUpdatedAt,
          };
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt: historyUpdatedAt,
              event: { type: "node.updated", payload: reconciledNode },
            }),
          );
          materializedNodes.set(node.id, reconciledNode);
        }

        for (const item of cleanupTurnItemsById.values()) {
          if (item.runId !== run.id) continue;
          if (isDuplicateRun ? item.status === "cancelled" : item.status !== "running") continue;
          const itemStatus: OrchestrationV2TurnItem["status"] = isDuplicateRun
            ? "cancelled"
            : "interrupted";
          const reconciledItem = {
            ...item,
            status: itemStatus,
            completedAt: historyUpdatedAt,
            updatedAt: historyUpdatedAt,
          };
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt: historyUpdatedAt,
              event: { type: "turn-item.updated", payload: reconciledItem },
            }),
          );
        }
      }

      const shouldWriteTimelineOrder = !input.incrementalHistory || input.needsTimelineOrderRepair;
      let timelineItemIds: ReadonlyArray<TurnItemId> | undefined;
      if (shouldWriteTimelineOrder) {
        const existingOrderRows =
          projections.getTurnItemOrder !== undefined
            ? yield* projections.getTurnItemOrder(input.threadId)
            : input.incrementalHistory
              ? undefined
              : (() => {
                  const providerTurns = new Map(
                    input.records.providerTurns.map((turn) => [turn.id, turn] as const),
                  );
                  return input.records.turnItems.map((item) => {
                    const providerTurn =
                      item.providerTurnId === null
                        ? undefined
                        : providerTurns.get(item.providerTurnId);
                    return {
                      id: item.id,
                      ordinal: item.ordinal,
                      startedAt:
                        item.startedAt === null ? null : DateTime.formatIso(item.startedAt),
                      updatedAt: DateTime.formatIso(item.updatedAt),
                      nativeTurnId:
                        providerTurn?.nativeTurnRef?.driver === CODEX
                          ? providerTurn.nativeTurnRef.nativeId
                          : null,
                      nativeTurnOrdinal: providerTurn?.ordinal ?? null,
                    };
                  });
                })();
        if (existingOrderRows !== undefined) {
          timelineItemIds = nativeTimelineItemOrderFor({
            existingItems: existingOrderRows,
            mappedItems: mappedTurnItems,
          });
        }
      }

      const runsById = new Map(input.records.runs.map((run) => [run.id, run] as const));
      for (const run of materializedRuns.values()) runsById.set(run.id, run);
      for (const run of removedRuns) {
        runsById.set(run.id, { ...run, status: "rolled_back" });
      }
      const providerThreadRuns = Array.from(runsById.values()).filter(
        (run) => run.providerThreadId === input.providerThread.id && run.status !== "rolled_back",
      );
      const synchronizedProviderThread: OrchestrationV2ProviderThread = {
        ...input.providerThread,
        firstRunOrdinal:
          providerThreadRuns.length === 0
            ? null
            : Math.min(...providerThreadRuns.map((run) => run.ordinal)),
        lastRunOrdinal:
          providerThreadRuns.length === 0
            ? null
            : Math.max(...providerThreadRuns.map((run) => run.ordinal)),
        nativeConversationHeadRef:
          latestTurn === undefined ? null : nativeItemRef(latestTurn.nativeId),
        status: providerStatusFor(input.history.thread),
        nativeMetadata: {
          ...(() => {
            const { historyMappingDeferred: _historyMappingDeferred, ...metadata } =
              input.providerThread.nativeMetadata ?? {};
            return metadata;
          })(),
          ...(input.catalogUpdatedAt === undefined
            ? {}
            : {
                updatedAt: input.catalogUpdatedAt,
                historySyncCatalogUpdatedAt: input.catalogUpdatedAt,
              }),
          title: titleFor(input.history.thread),
          historySyncUpdatedAt: DateTime.formatIso(historyUpdatedAt),
          ...(timelineItemIds === undefined
            ? {}
            : { timelineOrderVersion: NATIVE_TIMELINE_ORDER_VERSION }),
          ...(input.deferHistoryRemap
            ? { historyMappingDeferred: true }
            : { historyMappingVersion: HISTORY_MAPPING_VERSION }),
        },
        updatedAt: historyUpdatedAt,
      };

      let positionOrder: ReadonlyArray<OrchestrationV2TurnItem> = [];
      let ordinalByItemId = new Map<TurnItemId, number>();
      if (!input.incrementalHistory) {
        const allItems = new Map(input.records.turnItems.map((item) => [item.id, item] as const));
        for (const { item } of mappedTurnItems) allItems.set(item.id, item);
        const orderedItemIds =
          timelineItemIds ??
          Array.from(allItems.values())
            .toSorted(
              (left, right) =>
                (left.startedAt === null ? 0 : epoch(left.startedAt)) -
                  (right.startedAt === null ? 0 : epoch(right.startedAt)) ||
                left.ordinal - right.ordinal,
            )
            .map((item) => item.id);
        positionOrder = orderedItemIds.flatMap((itemId) => {
          const item = allItems.get(itemId);
          return item === undefined ? [] : [item];
        });
        ordinalByItemId = new Map(
          positionOrder.map((item, index) => [item.id, index + 1] as const),
        );
        const updatedItemIds = new Set(
          events.flatMap((event) => (event.type === "turn-item.updated" ? [event.payload.id] : [])),
        );
        for (const [index, item] of positionOrder.entries()) {
          const ordinal = index + 1;
          if (updatedItemIds.has(item.id) || item.ordinal === ordinal) continue;
          events.push(
            eventBase({
              id: yield* allocateEvent(input.threadId),
              threadId: input.threadId,
              providerInstanceId: input.instanceId,
              occurredAt: item.updatedAt,
              event: { type: "turn-item.updated", payload: { ...item, ordinal } },
            }),
          );
        }
      }
      if (!Equal.equals(input.providerThread, synchronizedProviderThread)) {
        events.push(
          eventBase({
            id: yield* allocateEvent(input.threadId),
            threadId: input.threadId,
            providerInstanceId: input.instanceId,
            occurredAt: historyUpdatedAt,
            event: {
              type: "provider-thread.updated",
              driver: CODEX,
              payload: synchronizedProviderThread,
            },
          }),
        );
      }
      const orderedEvents = events.map((event) => {
        if (event.type !== "turn-item.updated") return event;
        const ordinal = ordinalByItemId.get(event.payload.id);
        return ordinal === undefined || ordinal === event.payload.ordinal
          ? event
          : { ...event, payload: { ...event.payload, ordinal } };
      });
      if (orderedEvents.length > 0) {
        yield* eventSink.write({
          events: orderedEvents,
          ...(timelineItemIds === undefined
            ? {}
            : { turnItemOrder: { threadId: input.threadId, turnItemIds: timelineItemIds } }),
        });
      }
    },
  );

  const resumeThread = Effect.fn("CodexNativeThreadSyncService.resumeThread")(function* (
    threadId: ThreadId,
  ) {
    const records = yield* readRecords(threadId, { turnItemIds: [] });
    if (records === null || records.thread.deletedAt !== null || records.thread.archivedAt !== null)
      return;
    const providerThread = records.providerThreads.find(
      (candidate) =>
        candidate.nativeThreadRef?.driver === CODEX && candidate.nativeThreadRef.nativeId,
    );
    if (
      providerThread?.nativeThreadRef?.nativeId === null ||
      providerThread?.nativeThreadRef === null ||
      providerThread === undefined
    ) {
      return;
    }
    const instance = yield* instances.getInstance(records.thread.providerInstanceId);
    if (instance?.orchestrationAdapter.nativeThreadManagement === undefined) return;
    const providerSessionId = ids.derive.providerSession({
      providerInstanceId: records.thread.providerInstanceId,
    });
    const selection = records.thread.modelSelection;
    const policy = yield* runtimePolicy.resolve({
      thread: records.thread,
      modelSelection: selection,
    });
    const nativeHead = providerThread.nativeConversationHeadRef;
    const nativeHeadId =
      providerThread.status === "active" &&
      nativeHead?.driver === CODEX &&
      nativeHead.nativeId !== null
        ? nativeHead.nativeId
        : null;
    const nativeResumeKey = nativeHeadId === null ? null : `${threadId}:${nativeHeadId}`;
    if (nativeResumeKey !== null && (yield* Ref.get(attachedNativeTurnKeys)).has(nativeResumeKey)) {
      return;
    }
    const nativeActiveTurn =
      nativeHeadId === null
        ? undefined
        : records.runs
            .flatMap((run) => {
              if (
                run.providerThreadId !== providerThread.id ||
                run.status !== "running" ||
                run.rootNodeId === null ||
                run.activeAttemptId === null
              ) {
                return [];
              }
              const attempt = records.attempts.find(
                (candidate) => candidate.id === run.activeAttemptId,
              );
              const providerTurn = records.providerTurns.find(
                (candidate) =>
                  candidate.providerThreadId === providerThread.id &&
                  (candidate.id === attempt?.providerTurnId ||
                    candidate.runAttemptId === run.activeAttemptId),
              );
              if (
                attempt === undefined ||
                providerTurn?.nativeTurnRef?.driver !== CODEX ||
                providerTurn.nativeTurnRef.strength !== "strong" ||
                providerTurn.nativeTurnRef.nativeId !== nativeHeadId
              ) {
                return [];
              }
              return [
                {
                  run,
                  attempt,
                  providerTurn,
                  message: nativeResumeMessageFor({
                    runMessageId: run.userMessageId,
                    messages: records.messages,
                  }),
                },
              ];
            })
            .toSorted((left, right) => right.run.ordinal - left.run.ordinal)[0];
    const nativeActiveTurnInput =
      nativeActiveTurn === undefined || nativeHeadId === null
        ? undefined
        : {
            providerTurn: nativeActiveTurn.providerTurn,
            nativeTurnId: nativeHeadId,
            startedAt: nativeActiveTurn.run.startedAt ?? nativeActiveTurn.run.requestedAt,
            turnInput: {
              appThread: records.thread,
              threadId,
              runId: nativeActiveTurn.run.id,
              runOrdinal: nativeActiveTurn.run.ordinal,
              nativeThreadHasTurns: true,
              providerTurnOrdinal: nativeActiveTurn.providerTurn.ordinal,
              attemptId: nativeActiveTurn.attempt.id,
              rootNodeId: nativeActiveTurn.run.rootNodeId!,
              providerThread: { ...providerThread, providerSessionId },
              message: nativeActiveTurn.message,
              modelSelection: selection,
              runtimePolicy: policy,
            },
          };
    const runtime = yield* sessions.open({
      threadId,
      providerSessionId,
      modelSelection: selection,
      runtimePolicy: policy,
      initialNativeThreadId: providerThread.nativeThreadRef.nativeId,
      initialProviderItemIdentityVersion: 2,
    });
    const nativeRunSubscriptionKey =
      nativeActiveTurnInput === undefined
        ? undefined
        : `${threadId}:${nativeActiveTurnInput.providerTurn.id}`;
    let nativeRunSubscription: ProviderAdapter.ProviderAdapterV2EventSubscription | undefined;
    let ownsNativeRunSubscription = false;
    if (nativeRunSubscriptionKey !== undefined && runtime.subscribeEvents !== undefined) {
      ownsNativeRunSubscription = yield* Ref.modify(activeNativeRunSubscriptions, (current) => {
        if (current.has(nativeRunSubscriptionKey)) return [false, current] as const;
        const updated = new Set(current);
        updated.add(nativeRunSubscriptionKey);
        return [true, updated] as const;
      });
      if (ownsNativeRunSubscription) {
        nativeRunSubscription = yield* runtime.subscribeEvents.pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit)
              ? Effect.void
              : Ref.update(activeNativeRunSubscriptions, (current) => {
                  const updated = new Set(current);
                  updated.delete(nativeRunSubscriptionKey);
                  return updated;
                }),
          ),
        );
      }
    }
    const resumeEffect = runtime.resumeThread({
      threadId,
      providerThread: { ...providerThread, providerSessionId },
      modelSelection: selection,
      runtimePolicy: policy,
      ...(nativeActiveTurnInput === undefined ? {} : { nativeActiveTurn: nativeActiveTurnInput }),
    });
    const resumed = yield* Effect.gen(function* () {
      if (nativeRunSubscription === undefined || nativeRunSubscriptionKey === undefined) {
        return yield* resumeEffect;
      }
      const subscription = nativeRunSubscription;
      const subscriptionKey = nativeRunSubscriptionKey;
      return yield* resumeEffect.pipe(
        Effect.onExit((exit) =>
          Exit.isSuccess(exit)
            ? Effect.void
            : subscription.close.pipe(
                Effect.andThen(
                  Ref.update(activeNativeRunSubscriptions, (current) => {
                    const updated = new Set(current);
                    updated.delete(subscriptionKey);
                    return updated;
                  }),
                ),
              ),
        ),
      );
    });
    // CodexAdapterV2.resumeThread describes a freshly attached T3 session as idle.
    // App Server's latest turn status remains authoritative for externally running work.
    const attached = { ...resumed, status: providerThread.status };
    if (!Equal.equals(providerThread, attached)) {
      yield* eventSink
        .write({
          events: [
            eventBase({
              id: yield* allocateEvent(threadId),
              threadId,
              providerInstanceId: records.thread.providerInstanceId,
              occurredAt: attached.updatedAt,
              event: { type: "provider-thread.updated", driver: CODEX, payload: attached },
            }),
          ],
        })
        .pipe(
          Effect.onExit((exit) => {
            if (
              Exit.isSuccess(exit) ||
              nativeRunSubscription === undefined ||
              nativeRunSubscriptionKey === undefined
            ) {
              return Effect.void;
            }
            return nativeRunSubscription.close.pipe(
              Effect.andThen(
                Ref.update(activeNativeRunSubscriptions, (current) => {
                  const updated = new Set(current);
                  updated.delete(nativeRunSubscriptionKey);
                  return updated;
                }),
              ),
            );
          }),
        );
    }
    if (nativeResumeKey !== null) {
      yield* Ref.update(attachedNativeTurnKeys, (current) => {
        const next = new Set(current);
        next.add(nativeResumeKey);
        return next;
      });
      yield* Effect.logInfo("Attached to Codex App Server thread", {
        threadId,
        providerThreadId: providerThread.id,
        activeNativeTurn: nativeActiveTurn !== undefined,
      });
    }
    if (nativeRunSubscription !== undefined && nativeActiveTurn !== undefined) {
      const subscription = nativeRunSubscription;
      const subscriptionKey = nativeRunSubscriptionKey!;
      const nativeTurnInput = nativeActiveTurnInput!;
      const terminalSeen = yield* Ref.make(false);
      const isMatchingEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        nativeActiveRunEventMatches({
          event,
          runId: nativeActiveTurn.run.id,
          providerThreadId: providerThread.id,
          providerTurnId: nativeActiveTurn.providerTurn.id,
        });
      const pump = nativeActiveRunEvents(subscription.events, isMatchingEvent).pipe(
        Stream.tap((event) =>
          event.type === "turn.terminal" ? Ref.set(terminalSeen, true) : Effect.void,
        ),
        Stream.runForEach((event) =>
          providerEventIngestor
            .ingestNormalized({
              providerSessionId,
              providerInstanceId: records.thread.providerInstanceId,
              threadId,
              runId: nativeActiveTurn.run.id,
              writeIfRunCurrent: {
                runId: nativeActiveTurn.run.id,
                activeAttemptId: nativeActiveTurn.attempt.id,
                expectedStatus: "running",
              },
              event,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not persist a native Codex run event", {
                  threadId,
                  providerTurnId: nativeTurnInput.providerTurn.id,
                  eventType: event.type,
                  cause,
                }),
              ),
            ),
        ),
      );
      yield* Effect.forkIn(
        pump.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Native Codex run event stream ended", {
              threadId,
              providerTurnId: nativeTurnInput.providerTurn.id,
              cause,
            }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              if (!(yield* Ref.get(terminalSeen))) return;
              yield* syncThread(threadId, { force: true }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Could not settle a synchronized native Codex run", {
                    threadId,
                    providerTurnId: nativeTurnInput.providerTurn.id,
                    cause,
                  }),
                ),
              );
            }),
          ),
          Effect.ensuring(subscription.close),
          Effect.ensuring(
            Ref.update(activeNativeRunSubscriptions, (current) => {
              const updated = new Set(current);
              updated.delete(subscriptionKey);
              return updated;
            }),
          ),
          Effect.ensuring(
            nativeResumeKey === null
              ? Effect.void
              : Ref.update(attachedNativeTurnKeys, (current) => {
                  const updated = new Set(current);
                  updated.delete(nativeResumeKey);
                  return updated;
                }),
          ),
        ),
        layerScope,
      );
    } else if (ownsNativeRunSubscription && nativeRunSubscriptionKey !== undefined) {
      yield* Ref.update(activeNativeRunSubscriptions, (current) => {
        const updated = new Set(current);
        updated.delete(nativeRunSubscriptionKey);
        return updated;
      });
    }
  });

  const processThreadSync = Effect.fn("CodexNativeThreadSyncService.processThreadSync")(function* (
    threadId: ThreadId,
  ) {
    while (true) {
      const request = yield* Ref.modify(pendingThreadSyncs, (pending) => {
        const current = pending.get(threadId);
        if (current === undefined || current.running) return [null, pending] as const;
        const next = new Map(pending);
        if (current.sync || current.force || current.resume) {
          next.set(threadId, {
            ...current,
            sync: false,
            force: false,
            resume: false,
            running: true,
          });
          return [current, next] as const;
        }
        next.delete(threadId);
        return [null, next] as const;
      });
      if (request === null) return;

      yield* Effect.logInfo("Reading Codex App Server thread history", { threadId });
      const synchronized = yield* syncThread(threadId, {
        force: request.force,
        ...(request.catalogUpdatedAt === undefined
          ? {}
          : { catalogUpdatedAt: request.catalogUpdatedAt }),
        ...(request.catalogWorkspaceRoot === undefined
          ? {}
          : { catalogWorkspaceRoot: request.catalogWorkspaceRoot }),
      }).pipe(
        Effect.matchCauseEffect({
          onFailure: (cause) =>
            Effect.logWarning("Could not hydrate Codex App Server thread history", {
              threadId,
              cause,
            }).pipe(Effect.as(false)),
          onSuccess: () => Effect.succeed(true),
        }),
      );
      if (synchronized) {
        yield* Effect.logInfo("Synchronized Codex App Server thread history", { threadId });
      }
      if (request.resume && synchronized) {
        yield* resumeThread(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not attach to Codex App Server thread", { threadId, cause }),
          ),
        );
      }
      const continueProcessing = yield* Ref.modify(pendingThreadSyncs, (pending) => {
        const current = pending.get(threadId);
        if (current === undefined) return [false, pending] as const;
        const next = new Map(pending);
        if (current.sync || current.force || current.resume) {
          next.set(threadId, { ...current, running: false });
          return [true, next] as const;
        }
        next.delete(threadId);
        return [false, next] as const;
      });
      if (!continueProcessing) return;
    }
  });

  // Keep a live sync slot free while a background worker remaps an old thread.
  yield* Effect.forkIn(
    runCodexNativeThreadSyncWorkers(priorityThreadSyncQueue, threadSyncQueue, processThreadSync),
    layerScope,
  );

  const applyThreadCommand = Effect.fn("CodexNativeThreadSyncService.applyThreadCommand")(
    function* (command: {
      readonly type:
        | "thread.archive"
        | "thread.unarchive"
        | "thread.delete"
        | "thread.metadata.update";
      readonly threadId: ThreadId;
      readonly title?: string;
    }) {
      const records = yield* readThreadMetadata(command.threadId);
      if (records === null) return;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.nativeThreadRef?.driver === CODEX && candidate.nativeThreadRef.nativeId,
      );
      if (
        providerThread?.nativeThreadRef?.nativeId === null ||
        providerThread?.nativeThreadRef === null ||
        providerThread === undefined
      ) {
        return;
      }
      const instance = yield* instances.getInstance(records.thread.providerInstanceId);
      const native = instance?.orchestrationAdapter.nativeThreadManagement;
      if (native === undefined) return;
      switch (command.type) {
        case "thread.archive":
          yield* native.archive(providerThread.nativeThreadRef.nativeId);
          break;
        case "thread.unarchive":
          yield* native.unarchive(providerThread.nativeThreadRef.nativeId);
          yield* resumeThread(command.threadId);
          break;
        case "thread.delete":
          yield* native.delete(providerThread.nativeThreadRef.nativeId);
          break;
        case "thread.metadata.update":
          if (command.title !== undefined) {
            yield* native.setName({
              nativeThreadId: providerThread.nativeThreadRef.nativeId,
              name: command.title,
            });
          }
          break;
      }
    },
  );

  return CodexNativeThreadSyncService.of({
    startCatalogSync,
    startThreadSync: Effect.fn("CodexNativeThreadSyncService.startThreadSync")(
      (threadId, options) => enqueueThreadSync(threadId, options),
    ),
    syncCatalog: Effect.fn("CodexNativeThreadSyncService.syncCatalog")(() =>
      syncCatalog().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Codex App Server thread sync failed", { cause }),
        ),
      ),
    ),
    syncThread: Effect.fn("CodexNativeThreadSyncService.syncThread")((threadId, options) =>
      syncThread(threadId, options).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not hydrate Codex App Server thread history", {
            threadId,
            cause,
          }),
        ),
      ),
    ),
    resumeThread: Effect.fn("CodexNativeThreadSyncService.resumeThread")((threadId) =>
      resumeThread(threadId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not attach to Codex App Server thread", { threadId, cause }),
        ),
      ),
    ),
    applyThreadCommand: Effect.fn("CodexNativeThreadSyncService.applyThreadCommand")((command) =>
      applyThreadCommand(command).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not apply T3 thread change to Codex App Server", {
            threadId: command.threadId,
            type: command.type,
            cause,
          }),
        ),
      ),
    ),
  });
});

export function findOrDeriveMessageId(input: {
  readonly nativeItem: NativeItem;
  readonly existingItemsByNativeId: ReadonlyMap<string, OrchestrationV2TurnItem>;
  readonly text: string;
  readonly role: "user" | "assistant";
  readonly existingMessages: ThreadRecords["messages"];
  readonly existingMessagesByRoleAndText?: ExistingMessagesByRoleAndText;
  readonly usedMessageIds: Set<MessageId>;
  readonly messageIdsByNativeItemId?: Map<string, MessageId>;
  readonly deriveMessageId: (nativeItemId: string) => MessageId;
}): MessageId {
  const resolvedNativeMessage = input.messageIdsByNativeItemId?.get(input.nativeItem.nativeId);
  if (resolvedNativeMessage !== undefined) return resolvedNativeMessage;
  const nativeTurnItem = input.existingItemsByNativeId.get(input.nativeItem.nativeId);
  const existingNativeMessage =
    nativeTurnItem?.type === "user_message" || nativeTurnItem?.type === "assistant_message"
      ? nativeTurnItem.messageId
      : undefined;
  if (existingNativeMessage !== undefined) {
    input.usedMessageIds.add(existingNativeMessage);
    input.messageIdsByNativeItemId?.set(input.nativeItem.nativeId, existingNativeMessage);
    return existingNativeMessage;
  }
  const candidates =
    input.existingMessagesByRoleAndText?.get(messageReuseKey(input.role, input.text)) ??
    input.existingMessages;
  let existing: OrchestrationV2ConversationMessage | undefined;
  let closestTime = Number.POSITIVE_INFINITY;
  for (const message of candidates) {
    if (
      input.usedMessageIds.has(message.id) ||
      message.role !== input.role ||
      message.text !== input.text
    ) {
      continue;
    }
    const distance =
      input.nativeItem.startedAt === null
        ? epoch(message.createdAt)
        : Math.abs(epoch(message.createdAt) - input.nativeItem.startedAt * 1_000);
    if (distance < closestTime) {
      existing = message;
      closestTime = distance;
    }
  }
  const id = existing?.id ?? input.deriveMessageId(input.nativeItem.nativeId);
  input.usedMessageIds.add(id);
  input.messageIdsByNativeItemId?.set(input.nativeItem.nativeId, id);
  return id;
}

export function mapNativeItem(input: {
  readonly nativeItem: NativeItem;
  readonly threadId: ThreadId;
  readonly senderThreadId?: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly runId: RunId;
  readonly nodeId: NodeId;
  readonly planId: PlanId;
  readonly turnStatus: string;
  readonly turnCompletedAt: number | null;
  readonly isLatestItem: boolean;
  readonly fallbackAt: number;
  readonly existingItems: ThreadRecords["turnItems"];
  readonly existingItemsByNativeId: ReadonlyMap<string, OrchestrationV2TurnItem>;
  readonly existingMessages: ThreadRecords["messages"];
  readonly existingMessagesByRoleAndText?: ExistingMessagesByRoleAndText;
  readonly messageIdsByNativeItemId?: Map<string, MessageId>;
  readonly existingMessageTurnItemsByMessageId?: ReadonlyMap<MessageId, OrchestrationV2TurnItem>;
  readonly existingSubagents: ThreadRecords["subagents"];
  readonly existingSubagentsByChildThreadId?: ReadonlyMap<ThreadId, OrchestrationV2Subagent>;
  readonly existingSubagentTurnItemsBySubagentId?: ReadonlyMap<
    OrchestrationV2Subagent["id"],
    OrchestrationV2TurnItem
  >;
  readonly usedMessageIds: Set<MessageId>;
  readonly deriveMessageId: (nativeItemId: string) => MessageId;
  readonly deriveTurnItemId: (nativeItemId: string) => TurnItemId;
  readonly deriveNodeId: (nativeItemId: string) => NodeId;
  readonly deriveProviderThreadId: (nativeThreadId: string) => ProviderThreadId;
}): {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly events: ReadonlyArray<NativeHistoryEvent>;
} | null {
  const native = input.nativeItem.payload as NativeHistoryItem;
  const nativeRef = nativeItemRef(input.nativeItem.nativeId);
  const startedAt = utc(input.nativeItem.startedAt ?? input.fallbackAt);
  const status = nativeHistoryItemStatus(
    native,
    input.turnStatus,
    input.nativeItem.completedAt,
    input.isLatestItem,
  );
  const completedAt =
    status === "running"
      ? null
      : input.nativeItem.completedAt !== null
        ? utc(input.nativeItem.completedAt)
        : input.turnCompletedAt === null
          ? null
          : utc(input.turnCompletedAt);
  const updatedAt = completedAt ?? startedAt;
  const existing = input.existingItemsByNativeId.get(input.nativeItem.nativeId);
  const nodeId = input.deriveNodeId(input.nativeItem.nativeId);
  const common = {
    id: existing?.id ?? input.deriveTurnItemId(input.nativeItem.nativeId),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: nativeRef,
    parentItemId: null,
    ordinal: existing?.ordinal ?? 0,
    status,
    title: null,
    startedAt,
    completedAt,
    updatedAt,
  };
  let turnItem: OrchestrationV2TurnItem | null = null;
  const subagentTurnItems: Array<OrchestrationV2TurnItem> = [];
  let messageEvent: OrchestrationV2ConversationMessage | null = null;
  const extraEvents: Array<NativeHistoryEvent> = [];

  if (native.type === "collabAgentToolCall" || native.type === "subAgentActivity") {
    const childNativeIds =
      native.type === "collabAgentToolCall"
        ? Array.from(
            new Set([
              ...(native.tool === "spawnAgent" ? native.receiverThreadIds : []),
              ...Object.keys(native.agentsStates),
            ]),
          )
        : [native.agentThreadId];

    for (const childNativeId of childNativeIds) {
      const childThreadId = appThreadIdFor(input.instanceId, childNativeId);
      const existingTask =
        input.existingSubagentsByChildThreadId?.get(childThreadId) ??
        input.existingSubagents.find((task) => task.childThreadId === childThreadId);
      const state =
        native.type === "collabAgentToolCall" ? native.agentsStates[childNativeId] : undefined;
      if (
        existingTask === undefined &&
        ((native.type === "subAgentActivity" && native.kind !== "started") ||
          (native.type === "collabAgentToolCall" &&
            native.tool !== "spawnAgent" &&
            state === undefined))
      ) {
        continue;
      }
      const taskNativeItemId =
        existingTask?.nativeTaskRef?.nativeId ?? `${native.id}:${childNativeId}`;
      const taskId = existingTask?.id ?? input.deriveNodeId(taskNativeItemId);
      const status =
        state !== undefined
          ? nativeSubagentStatus(state.status)
          : native.type === "subAgentActivity"
            ? native.kind === "completed"
              ? "completed"
              : native.kind === "interrupted"
                ? "interrupted"
                : (existingTask?.status ?? "running")
            : "running";
      const active = status === "pending" || status === "running" || status === "waiting";
      const childTitle =
        native.type === "subAgentActivity" && native.agentPath !== ""
          ? native.agentPath
          : (existingTask?.title ?? null);
      const model =
        native.type === "collabAgentToolCall" && typeof native.model === "string"
          ? native.model
          : (existingTask?.model ?? null);
      const prompt =
        native.type === "collabAgentToolCall"
          ? (native.prompt ?? existingTask?.prompt ?? "")
          : (existingTask?.prompt ?? "");
      const result =
        state?.message === null || state?.message === undefined
          ? (existingTask?.result ?? null)
          : state.message;
      const subagentCompletedAt = active
        ? null
        : (existingTask?.completedAt ?? completedAt ?? updatedAt);
      const task: OrchestrationV2Subagent = {
        ...existingTask,
        id: taskId,
        threadId: input.threadId,
        runId: input.runId,
        parentNodeId: input.nodeId,
        origin: "provider_native",
        createdBy: "agent",
        driver: CODEX,
        providerInstanceId: input.instanceId,
        providerThreadId: input.providerThreadId,
        childThreadId,
        nativeTaskRef: existingTask?.nativeTaskRef ?? nativeItemRef(taskNativeItemId),
        prompt,
        title: childTitle,
        model,
        status,
        result,
        startedAt: existingTask?.startedAt ?? startedAt,
        completedAt: subagentCompletedAt,
        updatedAt,
      };
      const subagentNode: OrchestrationV2ExecutionNode = {
        id: task.id,
        threadId: input.threadId,
        runId: input.runId,
        parentNodeId: input.nodeId,
        rootNodeId: input.nodeId,
        kind: "subagent",
        status: status === "idle" ? "pending" : status,
        countsForRun: false,
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
        nativeItemRef: nativeRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: task.startedAt ?? startedAt,
        completedAt: subagentCompletedAt,
      };
      const existingTaskItem =
        input.existingSubagentTurnItemsBySubagentId?.get(task.id) ??
        input.existingItems.find((item) => item.type === "subagent" && item.subagentId === task.id);
      const turnItem: OrchestrationV2TurnItem = {
        id: existingTaskItem?.id ?? input.deriveTurnItemId(taskNativeItemId),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: task.id,
        providerThreadId: input.providerThreadId,
        providerTurnId: input.providerTurnId,
        nativeItemRef: task.nativeTaskRef,
        parentItemId: null,
        ordinal: existingTaskItem?.ordinal ?? 0,
        status,
        title: task.title,
        startedAt: task.startedAt,
        completedAt: subagentCompletedAt,
        updatedAt,
        type: "subagent",
        subagentId: task.id,
        origin: task.origin,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        childThreadId,
        prompt: task.prompt,
        result: task.result,
      };
      subagentTurnItems.push(turnItem);
      extraEvents.push(
        { type: "subagent.updated", payload: task },
        { type: "node.updated", payload: subagentNode },
        { type: "turn-item.updated", payload: turnItem },
      );
    }
  } else if (native.type === "userMessage" || native.type === "agentMessage") {
    const role = native.type === "userMessage" ? "user" : "assistant";
    const text = native.type === "userMessage" ? textFromUserItem(native) : native.text;
    const messageId = findOrDeriveMessageId({
      nativeItem: input.nativeItem,
      existingItemsByNativeId: input.existingItemsByNativeId,
      text,
      role,
      existingMessages: input.existingMessages,
      ...(input.existingMessagesByRoleAndText === undefined
        ? {}
        : { existingMessagesByRoleAndText: input.existingMessagesByRoleAndText }),
      usedMessageIds: input.usedMessageIds,
      ...(input.messageIdsByNativeItemId === undefined
        ? {}
        : { messageIdsByNativeItemId: input.messageIdsByNativeItemId }),
      deriveMessageId: input.deriveMessageId,
    });
    const existingTurnItem =
      input.existingMessageTurnItemsByMessageId?.get(messageId) ??
      input.existingItems.find((item) =>
        item.type === "user_message" || item.type === "assistant_message"
          ? item.messageId === messageId
          : false,
      );
    const messageNodeId = role === "assistant" ? nodeId : input.nodeId;
    const base = {
      ...common,
      id: existingTurnItem?.id ?? common.id,
      nodeId: messageNodeId,
    };
    const message: OrchestrationV2ConversationMessage = {
      createdBy: role === "user" && input.senderThreadId === undefined ? "user" : "agent",
      creationSource: "provider",
      id: messageId,
      threadId: input.threadId,
      runId: input.runId,
      nodeId: messageNodeId,
      role,
      ...(role === "user" && input.senderThreadId !== undefined
        ? { senderThreadId: input.senderThreadId }
        : {}),
      text,
      attachments: [],
      streaming: status === "running" && native.type === "agentMessage",
      createdAt: startedAt,
      updatedAt,
    };
    if (role === "assistant") {
      extraEvents.push({
        type: "node.updated",
        payload: {
          id: messageNodeId,
          threadId: input.threadId,
          runId: input.runId,
          parentNodeId: input.nodeId,
          rootNodeId: input.nodeId,
          kind: "assistant_message",
          status: nodeStatusFor(status),
          countsForRun: false,
          providerThreadId: input.providerThreadId,
          providerTurnId: input.providerTurnId,
          nativeItemRef: nativeRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt,
        },
      });
    }
    messageEvent = message;
    turnItem =
      role === "user"
        ? {
            ...base,
            createdBy: input.senderThreadId === undefined ? "user" : "agent",
            creationSource: "provider",
            type: "user_message",
            ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
            messageId,
            inputIntent: "turn_start",
            text,
            attachments: [],
          }
        : {
            ...base,
            type: "assistant_message",
            messageId,
            text,
            streaming: status === "running",
          };
  } else if (native.type === "contextCompaction") {
    turnItem = {
      ...common,
      type: "compaction",
      driver: CODEX,
      title:
        status === "running"
          ? "Compacting context"
          : status === "completed"
            ? "Context compacted"
            : status === "failed"
              ? "Context compaction failed"
              : "Context compaction stopped",
    };
  } else {
    const toolNodeId = nodeId;
    const toolNode: OrchestrationV2ExecutionNode = {
      id: toolNodeId,
      threadId: input.threadId,
      runId: input.runId,
      parentNodeId: input.nodeId,
      rootNodeId: input.nodeId,
      kind: native.type === "plan" ? "plan" : "tool_call",
      status: nodeStatusFor(status),
      countsForRun: false,
      providerThreadId: input.providerThreadId,
      providerTurnId: input.providerTurnId,
      nativeItemRef: nativeRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt,
      completedAt,
    };
    switch (native.type) {
      case "reasoning":
        turnItem = {
          ...common,
          type: "reasoning",
          text: native.content?.join("") || native.summary?.join("\n") || "",
          streaming: status === "running",
        };
        break;
      case "plan": {
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "proposed_plan",
          planId: input.planId,
          markdown: native.text,
          streaming: status === "running",
        };
        extraEvents.push({
          type: "plan.updated",
          payload: {
            id: input.planId,
            threadId: input.threadId,
            runId: input.runId,
            nodeId: toolNodeId,
            status: "active",
            kind: "proposed_plan",
            markdown: native.text,
            detailInTurnItem: true,
          },
        });
        break;
      }
      case "commandExecution":
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "command_execution",
          input: native.command,
          ...(native.aggregatedOutput == null ? {} : { output: native.aggregatedOutput }),
          ...(native.exitCode == null ? {} : { exitCode: native.exitCode }),
        };
        break;
      case "fileChange": {
        const first = native.changes[0];
        if (first === undefined) return null;
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "file_change",
          fileName: first.path,
          diffStr: first.diff,
          changes: native.changes.map((change) =>
            change.kind.type === "update" && change.kind.move_path
              ? { operation: change.kind.type, path: change.kind.move_path, oldPath: change.path }
              : { operation: change.kind.type, path: change.path },
          ),
        };
        break;
      }
      case "webSearch":
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "web_search",
          patterns: nativeWebSearchPatterns(native),
          ...(native.results == null
            ? {}
            : {
                results: native.results.map((result) => {
                  const value =
                    typeof result === "object" && result !== null
                      ? (result as unknown as Record<string, unknown>)
                      : {};
                  return {
                    ...(typeof value.title === "string" ? { title: value.title } : {}),
                    ...(typeof value.url === "string" ? { url: value.url } : {}),
                    ...(typeof value.snippet === "string" ? { snippet: value.snippet } : {}),
                  };
                }),
              }),
        };
        break;
      case "mcpToolCall": {
        extraEvents.push({ type: "node.updated", payload: toolNode });
        const result = native.result?.structuredContent ?? native.result?.content;
        const output =
          native.error == null
            ? result
            : result === undefined
              ? { error: native.error.message }
              : { error: native.error.message, result };
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "dynamic_tool",
          toolName: `${native.server}.${native.tool}`,
          input: native.arguments,
          ...(output === undefined ? {} : { output }),
        };
        break;
      }
      case "dynamicToolCall":
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "dynamic_tool",
          toolName: [native.namespace?.trim(), native.tool].filter(Boolean).join("."),
          input: native.arguments,
          ...(native.contentItems != null
            ? { output: native.contentItems }
            : native.success === false
              ? { output: { success: false } }
              : {}),
        };
        break;
      case "functionCallOutput":
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "dynamic_tool",
          toolName: native.name,
          input: { namespace: native.namespace ?? null },
          output: native.output,
        };
        break;
      case "imageView":
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "dynamic_tool",
          toolName: "view_image",
          input: { path: native.path },
        };
        break;
      case "imageGeneration":
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "dynamic_tool",
          toolName: "image_generation",
          input: {
            ...(native.revisedPrompt == null ? {} : { prompt: native.revisedPrompt }),
            ...(native.transparentBackground == null
              ? {}
              : { transparentBackground: native.transparentBackground }),
          },
          output: {
            status: native.status,
            ...(native.savedPath == null ? {} : { savedPath: native.savedPath }),
            ...(native.failure == null ? {} : { failure: native.failure }),
          },
        };
        break;
      case "sleep":
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "dynamic_tool",
          toolName: "sleep",
          input: { durationMs: native.durationMs },
        };
        break;
      case "enteredReviewMode":
      case "exitedReviewMode":
        extraEvents.push({ type: "node.updated", payload: toolNode });
        turnItem = {
          ...common,
          nodeId: toolNodeId,
          type: "dynamic_tool",
          toolName: native.type === "enteredReviewMode" ? "enter_review_mode" : "exit_review_mode",
          input: { review: native.review },
        };
        break;
      default:
        return null;
    }
  }
  const turnItems =
    subagentTurnItems.length > 0 ? subagentTurnItems : turnItem === null ? [] : [turnItem];
  if (turnItems.length === 0 && messageEvent === null && extraEvents.length === 0) return null;
  return {
    turnItems,
    events: [
      ...(messageEvent === null
        ? []
        : [{ type: "message.updated" as const, payload: messageEvent }]),
      ...extraEvents,
      ...(turnItem === null ? [] : [{ type: "turn-item.updated" as const, payload: turnItem }]),
    ],
  };
}

export const layer: Layer.Layer<
  CodexNativeThreadSyncService,
  never,
  | FileSystem.FileSystem
  | EventSink.EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ProjectStore.ProjectStoreV2
  | ProjectionStore.ProjectionStoreV2
  | ProviderInstanceRegistry.ProviderInstanceRegistry
  | ProviderSessionManager.ProviderSessionManagerV2
  | RuntimePolicy.RuntimePolicyV2
> = Layer.effect(CodexNativeThreadSyncService, make);
