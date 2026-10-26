import {
  MessageId,
  NodeId,
  OrchestrationV2AppThread,
  PlanId,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import {
  mapNativeItem,
  findOrDeriveMessageId,
  modelSelectionFor,
  appThreadIdFor,
  nativeConversationHeadRefFor,
  nativeThreadSettlementFor,
  nativeThreadSyncPriorityFor,
  shouldReusePreviousNativeRun,
  rootNativeTurnIdFor,
  nativeRootTurnIdsWithConflictingRuns,
  nativeRunMatchesRootTurn,
  nativeRunMappingForHistoryTurn,
  shouldMaterializeNativeTurn,
  shouldSyncNativeThreadHistory,
  nativeHistoryItemStatus,
  nativeHistoryTurnStatusForThread,
  hasStaleNativeRunningRun,
  providerStatusFor,
  nativeTurnIdsForStaleRunningRuns,
  nativeTurnIdsForDuplicateRuns,
  nativeHistoryRunningRunsMissing,
  nativeHistoryDuplicateRuns,
  nativeAttemptProviderTurnIdForHistoryTurn,
  nativeHistoryRunIdsRemoved,
  nativeThreadLineageFor,
  nativeTurnIdsToSkipForHistoryRead,
  shouldDeferNativeHistoryRemap,
  createNativeProviderTurnOrdinalAllocator,
  nativeActiveRunEventMatches,
  nativeActiveRunEvents,
  nativeThreadSyncRequestFor,
  shouldResumeNativeTurn,
  nativeResumeMessageFor,
  runCodexNativeThreadSyncWorkers,
  nativeTimelineItemOrderFor,
  synchronizedNativeThreadForHistory,
  uniqueAvailableProjectIdForMissingNativeCwd,
} from "./CodexNativeThreadSyncService.ts";

it("reuses the legacy T3 id for the default Codex instance", () => {
  assert.equal(
    appThreadIdFor(ProviderInstanceId.make("codex"), "native-thread"),
    ThreadId.make("codex:native-thread"),
  );
  assert.equal(
    appThreadIdFor(ProviderInstanceId.make("codex_work"), "native-thread"),
    ThreadId.make("import:codex_work:native-thread"),
  );
});

it("preserves the last native turn head when the catalog omits turns", () => {
  const existing = {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "turn-104",
    strength: "strong" as const,
  };
  assert.deepEqual(nativeConversationHeadRefFor(null, existing), existing);
  assert.deepEqual(nativeConversationHeadRefFor("turn-105", existing), {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "turn-105",
    strength: "strong",
  });
  assert.isNull(nativeConversationHeadRefFor(null, undefined));
});

it("clears a stale active override when Codex reports a settled latest turn", () => {
  const at = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");
  assert.deepEqual(
    nativeThreadSettlementFor(
      "failed",
      {
        settledOverride: "active",
        unsettledAt: DateTime.makeUnsafe("2026-10-04T00:00:00.000Z"),
      },
      at,
    ),
    { settledOverride: "settled", settledAt: at, unsettledAt: null },
  );
});

it("keeps an active Codex turn active while clearing its old settled timestamp", () => {
  const at = DateTime.makeUnsafe("2026-10-25T00:00:00.000Z");
  assert.deepEqual(
    nativeThreadSettlementFor(
      "inProgress",
      {
        settledOverride: "settled",
        unsettledAt: null,
      },
      at,
    ),
    { settledOverride: null, settledAt: null, unsettledAt: at },
  );
});

it("allocates new provider-turn ordinals after sparse existing native history", () => {
  const nextOrdinal = createNativeProviderTurnOrdinalAllocator([1, 2, 9, 11, 17, 31, 35, 47]);
  assert.equal(nextOrdinal(), 48);
  assert.equal(nextOrdinal(), 49);
});

it("prioritizes running Codex threads ahead of full history imports", () => {
  assert.equal(nativeThreadSyncPriorityFor(null), 3);
  assert.equal(nativeThreadSyncPriorityFor({ settledOverride: "settled" }), 2);
  assert.equal(nativeThreadSyncPriorityFor({ settledOverride: "active" }), 1);
  assert.equal(nativeThreadSyncPriorityFor({ settledOverride: "settled" }, true), 0);
  assert.equal(nativeThreadSyncPriorityFor({ settledOverride: "settled" }, true, true), 2);
  assert.equal(nativeThreadSyncPriorityFor({ settledOverride: "active" }, false, true), 2);
});

it("keeps the latest in-progress App Server turn active and interrupts stale turns", () => {
  const turn = {
    nativeTurnId: "turn-2",
    latestNativeTurnId: "turn-3",
    turnStatus: "inProgress",
  } as const;
  assert.equal(nativeHistoryTurnStatusForThread(turn), "interrupted");
  assert.equal(
    nativeHistoryTurnStatusForThread({
      ...turn,
      nativeTurnId: "turn-3",
    }),
    "inProgress",
  );
  assert.equal(
    nativeHistoryTurnStatusForThread({
      ...turn,
      nativeTurnId: "turn-3",
    }),
    "inProgress",
  );
  assert.equal(nativeHistoryTurnStatusForThread({ ...turn, turnStatus: "completed" }), "completed");
});

it("uses the latest in-progress App Server turn as the provider thread status", () => {
  assert.equal(
    providerStatusFor({
      archived: false,
      status: "idle",
      latestTurn: { status: "inProgress" },
    }),
    "active",
  );
  assert.equal(
    providerStatusFor({
      archived: false,
      status: "systemError",
      latestTurn: { status: "inProgress" },
    }),
    "error",
  );
});

it("requests history reconciliation for an active T3 run on an older Codex turn", () => {
  const providerThreadId = ProviderThreadId.make("native-provider-thread");
  const attemptId = RunAttemptId.make("stale-attempt");
  const providerTurnId = ProviderTurnId.make("stale-provider-turn");
  const nativeTurnRef = {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "old-native-turn",
    strength: "strong" as const,
  };
  const records = {
    providerThreadId,
    runs: [
      { providerThreadId, activeAttemptId: attemptId, status: "running" as const },
      { providerThreadId, activeAttemptId: attemptId, status: "completed" as const },
    ],
    attempts: [{ id: attemptId, providerTurnId }],
    providerTurns: [
      {
        id: providerTurnId,
        providerThreadId,
        runAttemptId: attemptId,
        nativeTurnRef,
      },
    ],
  };

  assert.isTrue(hasStaleNativeRunningRun({ ...records, latestNativeTurnId: "new-native-turn" }));
  assert.deepEqual(
    nativeTurnIdsForStaleRunningRuns({ ...records, latestNativeTurnId: "new-native-turn" }),
    ["old-native-turn"],
  );
  assert.isFalse(hasStaleNativeRunningRun({ ...records, latestNativeTurnId: "old-native-turn" }));
  assert.isFalse(hasStaleNativeRunningRun({ ...records, latestNativeTurnId: undefined }));
});

it("finds active runs that no longer exist in Codex history", () => {
  const providerThreadId = ProviderThreadId.make("native-provider-thread");
  const attemptId = RunAttemptId.make("stale-attempt");
  const providerTurnId = ProviderTurnId.make("stale-provider-turn");
  const nativeTurnRef = {
    driver: ProviderDriverKind.make("codex"),
    nativeId: "removed-native-turn",
    strength: "strong" as const,
  };
  const run = {
    id: RunId.make("stale-run"),
    providerThreadId,
    activeAttemptId: attemptId,
    status: "running" as const,
  };
  const providerTurn = {
    id: providerTurnId,
    providerThreadId,
    runAttemptId: attemptId,
    nativeTurnRef,
  };
  const attempt = { id: attemptId, providerTurnId };

  assert.deepEqual(
    nativeHistoryRunningRunsMissing({
      providerThreadId,
      retainedNativeTurnIds: new Set(["current-native-turn"]),
      runs: [run],
      attempts: [attempt],
      providerTurns: [providerTurn],
    }),
    [run],
  );
  assert.deepEqual(
    nativeHistoryRunningRunsMissing({
      providerThreadId,
      retainedNativeTurnIds: new Set(["removed-native-turn"]),
      runs: [run],
      attempts: [attempt],
      providerTurns: [providerTurn],
    }),
    [],
  );
});

it("keeps nested history attempts anchored to their root provider turn", () => {
  const rootProviderTurnId = ProviderTurnId.make("root-provider-turn");
  const childProviderTurnId = ProviderTurnId.make("child-provider-turn");

  assert.equal(
    nativeAttemptProviderTurnIdForHistoryTurn({
      nativeTurnId: "child-native-turn",
      rootNativeTurnId: "root-native-turn",
      providerTurnId: childProviderTurnId,
      rootProviderTurnId,
    }),
    rootProviderTurnId,
  );
  assert.equal(
    nativeAttemptProviderTurnIdForHistoryTurn({
      nativeTurnId: "child-native-turn",
      rootNativeTurnId: "root-native-turn",
      providerTurnId: childProviderTurnId,
    }),
    childProviderTurnId,
  );
});

it("reuses the newest run linked to a native turn when its provider-turn pointer is stale", () => {
  const providerThreadId = ProviderThreadId.make("native-provider-thread");
  const currentProviderTurnId = ProviderTurnId.make("current-provider-turn");
  const previousProviderTurnId = ProviderTurnId.make("previous-provider-turn");
  const staleAttemptId = RunAttemptId.make("stale-attempt");
  const firstDuplicateAttemptId = RunAttemptId.make("first-duplicate-attempt");
  const settledDuplicateAttemptId = RunAttemptId.make("settled-duplicate-attempt");
  const latestAttemptId = RunAttemptId.make("latest-attempt");
  const staleRunId = RunId.make("stale-run");
  const firstDuplicateRunId = RunId.make("first-duplicate-run");
  const settledDuplicateRunId = RunId.make("settled-duplicate-run");
  const latestRunId = RunId.make("latest-run");
  const at = DateTime.makeUnsafe("2026-10-26T04:43:52.000Z");
  const runs = [
    {
      id: staleRunId,
      ordinal: 103,
      providerThreadId,
      activeAttemptId: staleAttemptId,
      status: "completed" as const,
      startedAt: DateTime.makeUnsafe("2026-10-26T00:19:42.000Z"),
      requestedAt: DateTime.makeUnsafe("2026-10-26T00:19:42.000Z"),
    },
    {
      id: firstDuplicateRunId,
      ordinal: 116,
      providerThreadId,
      activeAttemptId: firstDuplicateAttemptId,
      status: "running" as const,
      startedAt: at,
      requestedAt: at,
    },
    {
      id: settledDuplicateRunId,
      ordinal: 130,
      providerThreadId,
      activeAttemptId: settledDuplicateAttemptId,
      status: "failed" as const,
      startedAt: at,
      requestedAt: at,
    },
    {
      id: latestRunId,
      ordinal: 143,
      providerThreadId,
      activeAttemptId: latestAttemptId,
      status: "running" as const,
      startedAt: at,
      requestedAt: at,
    },
  ];
  const attempts = [
    { id: staleAttemptId, runId: staleRunId, providerTurnId: previousProviderTurnId },
    {
      id: firstDuplicateAttemptId,
      runId: firstDuplicateRunId,
      providerTurnId: currentProviderTurnId,
    },
    {
      id: settledDuplicateAttemptId,
      runId: settledDuplicateRunId,
      providerTurnId: currentProviderTurnId,
    },
    { id: latestAttemptId, runId: latestRunId, providerTurnId: currentProviderTurnId },
  ];
  const providerTurns = [
    {
      id: currentProviderTurnId,
      providerThreadId,
      runAttemptId: staleAttemptId,
      nativeTurnRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "current-native-turn",
        strength: "strong" as const,
      },
    },
    {
      id: previousProviderTurnId,
      providerThreadId,
      runAttemptId: staleAttemptId,
      nativeTurnRef: {
        driver: ProviderDriverKind.make("codex"),
        nativeId: "previous-native-turn",
        strength: "strong" as const,
      },
    },
  ];

  const mapping = nativeRunMappingForHistoryTurn({
    providerThreadId,
    nativeTurnId: "current-native-turn",
    rootNativeTurnId: "current-native-turn",
    runs,
    attempts,
    providerTurns,
  });

  assert.equal(mapping?.run.id, latestRunId);
  assert.equal(mapping?.attempt.id, latestAttemptId);
  assert.isTrue(mapping?.hasExactProviderTurnAssociation);
  const duplicateRuns = nativeHistoryDuplicateRuns({
    providerThreadId,
    canonicalRunIdsByNativeTurnId: new Map([["current-native-turn", latestRunId]]),
    runs,
    attempts,
    providerTurns,
  });
  assert.deepEqual(
    duplicateRuns.map((run) => run.id),
    [firstDuplicateRunId, settledDuplicateRunId],
  );
  assert.deepEqual(
    nativeTurnIdsForDuplicateRuns({
      providerThreadId,
      runs,
      attempts,
      providerTurns,
    }),
    ["current-native-turn"],
  );
  assert.deepEqual(
    nativeTurnIdsForDuplicateRuns({
      providerThreadId,
      runs: runs.map((run) =>
        run.id === staleRunId || run.id === latestRunId
          ? run
          : { ...run, status: "cancelled" as const },
      ),
      attempts,
      providerTurns,
    }),
    [],
  );
});

it("reattaches active native turns after the server process loses its subscriptions", () => {
  const threadId = ThreadId.make("active-codex-thread-after-restart");
  const attachedNativeTurnKeys = new Set<string>();
  assert.isTrue(
    shouldResumeNativeTurn({
      threadId,
      nativeTurnId: "native-turn-1",
      active: true,
      attachedNativeTurnKeys,
    }),
  );

  attachedNativeTurnKeys.add(`${threadId}:native-turn-1`);
  assert.isFalse(
    shouldResumeNativeTurn({
      threadId,
      nativeTurnId: "native-turn-1",
      active: true,
      attachedNativeTurnKeys,
    }),
  );
  assert.isTrue(
    shouldResumeNativeTurn({
      threadId,
      nativeTurnId: "native-turn-2",
      active: true,
      attachedNativeTurnKeys,
    }),
  );
  attachedNativeTurnKeys.delete(`${threadId}:native-turn-1`);
  assert.isTrue(
    shouldResumeNativeTurn({
      threadId,
      nativeTurnId: "native-turn-1",
      active: true,
      attachedNativeTurnKeys,
    }),
  );
  assert.isFalse(
    shouldResumeNativeTurn({
      threadId,
      nativeTurnId: "native-turn-1",
      active: false,
      attachedNativeTurnKeys,
    }),
  );
});

it("can resume an imported active turn without a projected user message", () => {
  const messageId = MessageId.make("native-root-turn-prompt");
  assert.deepEqual(nativeResumeMessageFor({ runMessageId: messageId, messages: [] }), {
    messageId,
    text: "",
    attachments: [],
    createdBy: "user",
    creationSource: "provider",
  });
});

it.effect("keeps active thread sync moving while an old history remap is running", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const priorityQueue = yield* Queue.unbounded<ThreadId>();
      const backgroundQueue = yield* Queue.unbounded<ThreadId>();
      const backfillThread = ThreadId.make("large-history-remap");
      const activeThread = ThreadId.make("active-codex-thread");
      const backfillStarted = yield* Deferred.make<void>();
      const releaseBackfill = yield* Deferred.make<void>();
      const activeSyncStarted = yield* Deferred.make<void>();

      yield* Effect.forkScoped(
        runCodexNativeThreadSyncWorkers(priorityQueue, backgroundQueue, (threadId) =>
          threadId === backfillThread
            ? Deferred.succeed(backfillStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseBackfill)),
              )
            : Deferred.succeed(activeSyncStarted, undefined).pipe(Effect.asVoid),
        ),
      );
      yield* Queue.offer(backgroundQueue, backfillThread);
      yield* Deferred.await(backfillStarted);
      yield* Queue.offer(priorityQueue, activeThread);
      yield* Deferred.await(activeSyncStarted);
      yield* Deferred.succeed(releaseBackfill, undefined);
    }),
  ),
);

it("does not re-read history when catalog and thread-read timestamps have different meanings", () => {
  const alreadySynchronized = {
    becameActive: false,
    historyMappingVersion: 3,
    timelineOrderVersion: 1,
    historySyncUpdatedAt: "2026-10-05T18:51:04.000Z",
    historySyncCatalogUpdatedAt: "2026-10-24T11:08:42.000Z",
    catalogUpdatedAt: "2026-10-24T11:08:42.000Z",
    hasExistingThread: true,
    previousUpdatedAt: "2026-10-24T11:08:42.000Z",
    nativeUpdatedAt: "2026-10-24T11:08:42.000Z",
  } as const;
  const { timelineOrderVersion: _timelineOrderVersion, ...withoutTimelineOrderVersion } =
    alreadySynchronized;
  assert.isFalse(shouldSyncNativeThreadHistory(alreadySynchronized));
  assert.isTrue(
    shouldSyncNativeThreadHistory(withoutTimelineOrderVersion),
    "a thread without the timeline order migration must be repaired even when timestamps match",
  );
  assert.isFalse(
    shouldSyncNativeThreadHistory({
      becameActive: false,
      historyMappingVersion: 3,
      timelineOrderVersion: 1,
      historySyncUpdatedAt: "2026-10-05T18:51:04.000Z",
      historySyncCatalogUpdatedAt: "2026-10-24T11:08:42.000Z",
      catalogUpdatedAt: "2026-10-24T11:08:42.000Z",
      hasExistingThread: true,
      previousUpdatedAt: "2026-10-24T11:08:42.000Z",
      nativeUpdatedAt: "2026-10-24T11:08:42.000Z",
    }),
  );
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      becameActive: false,
      historyMappingVersion: 3,
      timelineOrderVersion: 1,
      historySyncUpdatedAt: "2026-10-05T18:51:04.000Z",
      historySyncCatalogUpdatedAt: "2026-10-24T11:08:42.000Z",
      catalogUpdatedAt: "2026-10-24T11:08:42.000Z",
      hasExistingThread: true,
      previousUpdatedAt: "2026-10-23T11:08:42.000Z",
      nativeUpdatedAt: "2026-10-24T11:08:42.000Z",
    }),
  );
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      becameActive: false,
      hasExistingThread: true,
      nativeUpdatedAt: "2026-10-24T11:08:42.000Z",
    }),
  );
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      becameActive: true,
      historyMappingVersion: 3,
      timelineOrderVersion: 1,
      historySyncUpdatedAt: "2026-10-05T18:51:04.000Z",
      hasExistingThread: true,
      previousUpdatedAt: "2026-10-24T11:08:42.000Z",
      nativeUpdatedAt: "2026-10-24T11:08:42.000Z",
    }),
  );
});

it("places a late imported Codex item back in its native turn", () => {
  const oldTurnId = "native-turn-84";
  const makeMappedItem = (id: string, startedAt: string) => {
    const mapped = mapItem({ id, type: "agentMessage", text: id });
    assert.isNotNull(mapped);
    const item = mapped.turnItems[0];
    assert.isDefined(item);
    const at = DateTime.makeUnsafe(startedAt);
    return { ...item, startedAt: at, updatedAt: at };
  };
  const oldPrompt = makeMappedItem("old-prompt", "2026-09-10T10:00:00.000Z");
  const lateItem = makeMappedItem("late-tool", "2026-09-10T10:00:30.000Z");
  const oldAnswer = makeMappedItem("old-answer", "2026-09-10T10:01:00.000Z");
  const existingItems = [
    {
      id: oldPrompt.id,
      ordinal: 3_670,
      startedAt: "2026-09-10T10:00:00.000Z",
      updatedAt: "2026-09-10T10:00:00.000Z",
      nativeTurnId: oldTurnId,
      nativeTurnOrdinal: 84,
    },
    {
      id: TurnItemId.make("turn-item:new-turn-answer"),
      ordinal: 4_100,
      startedAt: "2026-09-11T10:00:00.000Z",
      updatedAt: "2026-09-11T10:01:00.000Z",
      nativeTurnId: "native-turn-85",
      nativeTurnOrdinal: 85,
    },
    {
      id: oldAnswer.id,
      ordinal: 31_098,
      startedAt: "2026-09-10T10:01:00.000Z",
      updatedAt: "2026-09-10T10:01:00.000Z",
      nativeTurnId: oldTurnId,
      nativeTurnOrdinal: 84,
    },
  ];

  assert.deepEqual(
    nativeTimelineItemOrderFor({
      existingItems,
      mappedItems: [
        {
          item: oldPrompt,
          at: Date.parse("2026-09-10T10:00:00.000Z") / 1_000,
          order: [0, 0],
          nativeTurnId: oldTurnId,
          nativeTurnOrdinal: 84,
        },
        {
          item: lateItem,
          at: Date.parse("2026-09-10T10:00:30.000Z") / 1_000,
          order: [1, 0],
          nativeTurnId: oldTurnId,
          nativeTurnOrdinal: 84,
        },
        {
          item: oldAnswer,
          at: Date.parse("2026-09-10T10:01:00.000Z") / 1_000,
          order: [2, 0],
          nativeTurnId: oldTurnId,
          nativeTurnOrdinal: 84,
        },
      ],
    }),
    [oldPrompt.id, lateItem.id, oldAnswer.id, existingItems[1]!.id],
  );
});

it("defers full remapping of a large legacy history but keeps mapped histories incremental", () => {
  assert.isFalse(shouldDeferNativeHistoryRemap({ turnItemCount: 10_000 }));
  assert.isTrue(shouldDeferNativeHistoryRemap({ turnItemCount: 10_001 }));
  assert.isFalse(
    shouldDeferNativeHistoryRemap({ historyMappingVersion: 2, turnItemCount: 200_000 }),
  );
  assert.isFalse(
    shouldDeferNativeHistoryRemap({ historyMappingVersion: 3, turnItemCount: 50_000 }),
  );
  assert.isFalse(
    shouldDeferNativeHistoryRemap({ historyMappingDeferred: true, turnItemCount: 50_000 }),
  );
  assert.isFalse(
    shouldSyncNativeThreadHistory({
      becameActive: false,
      historyMappingDeferred: true,
      timelineOrderVersion: 1,
      historySyncUpdatedAt: "2026-10-25T14:20:18.000Z",
      historySyncCatalogUpdatedAt: "2026-10-24T11:09:08.000Z",
      catalogUpdatedAt: "2026-10-24T11:09:08.000Z",
      hasExistingThread: true,
      previousUpdatedAt: "2026-10-24T11:09:08.000Z",
      nativeUpdatedAt: "2026-10-24T11:09:08.000Z",
    }),
  );
});

it("selects only native roots mixed into an existing T3 run for remapping", () => {
  const turns = [
    { nativeId: "turn-99", rootNativeId: "turn-99" },
    { nativeId: "turn-100", rootNativeId: "turn-99" },
    { nativeId: "turn-101", rootNativeId: "turn-101" },
    { nativeId: "turn-102", rootNativeId: "turn-102" },
    { nativeId: "turn-103", rootNativeId: "turn-103" },
    { nativeId: "turn-104", rootNativeId: "turn-104" },
  ];
  assert.deepEqual(
    nativeRootTurnIdsWithConflictingRuns({
      turns,
      existingRunIdByNativeTurnId: new Map(turns.map((turn) => [turn.nativeId, "run-83"])),
    }),
    new Set(["turn-101", "turn-102", "turn-103", "turn-104"]),
  );
  assert.deepEqual(
    nativeRootTurnIdsWithConflictingRuns({
      turns,
      existingRunIdByNativeTurnId: new Map([
        ["turn-99", "run-83"],
        ["turn-100", "run-83"],
        ["turn-101", "run-84"],
        ["turn-102", "run-85"],
        ["turn-103", "run-86"],
        ["turn-104", "run-87"],
      ]),
    }),
    new Set(),
  );
});

it("reloads history once when the Codex catalog revision has not been synchronized", () => {
  const common = {
    becameActive: false,
    historyMappingVersion: 3,
    timelineOrderVersion: 1,
    historySyncUpdatedAt: "2026-10-05T18:51:04.000Z",
    hasExistingThread: true,
    previousUpdatedAt: "2026-10-24T11:08:42.000Z",
    nativeUpdatedAt: "2026-10-24T11:08:42.000Z",
    catalogUpdatedAt: "2026-10-24T11:08:42.000Z",
  } as const;
  assert.isTrue(shouldSyncNativeThreadHistory(common));
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      ...common,
      historySyncCatalogUpdatedAt: "2026-10-23T11:08:42.000Z",
    }),
  );
  assert.isFalse(
    shouldSyncNativeThreadHistory({
      ...common,
      historySyncCatalogUpdatedAt: "2026-10-24T11:08:42.000Z",
    }),
  );
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      ...common,
      historySyncCatalogUpdatedAt: "2026-10-24T11:08:42.000Z",
      projectNeedsRemap: true,
    }),
  );
});

it("reconciles the latest turn while a native thread is active", () => {
  const alreadySynchronized = {
    becameActive: false,
    historyMappingVersion: 3,
    timelineOrderVersion: 1,
    historySyncUpdatedAt: "2026-10-25T14:20:18.000Z",
    historySyncCatalogUpdatedAt: "2026-10-24T11:09:08.000Z",
    catalogUpdatedAt: "2026-10-24T11:09:08.000Z",
    nativeHeadChanged: false,
    hasExistingThread: true,
    previousUpdatedAt: "2026-10-24T11:09:08.000Z",
    nativeUpdatedAt: "2026-10-24T11:09:08.000Z",
  } as const;

  assert.isTrue(
    shouldSyncNativeThreadHistory({ ...alreadySynchronized, nativeThreadActive: true }),
  );
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      ...alreadySynchronized,
      nativeThreadActive: true,
      nativeHeadChanged: true,
    }),
  );
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      ...alreadySynchronized,
      nativeThreadActive: true,
      historyMappingVersion: 2,
    }),
  );
  assert.isTrue(
    shouldSyncNativeThreadHistory({ ...alreadySynchronized, nativeThreadBecameIdle: true }),
  );
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      ...alreadySynchronized,
      nativeThreadNeedsStatusReconciliation: true,
    }),
  );
  assert.isFalse(shouldSyncNativeThreadHistory(alreadySynchronized));
  assert.deepEqual(
    nativeThreadSyncRequestFor({
      becameActive: false,
      nativeThreadActive: true,
      nativeThreadBecameIdle: false,
      nativeThreadNeedsStatusReconciliation: false,
      needsHistoryRemap: false,
      projectNeedsRemap: false,
      needsResume: false,
    }),
    { force: true, priority: true, resume: false },
  );
  assert.deepEqual(
    nativeThreadSyncRequestFor({
      becameActive: false,
      nativeThreadActive: true,
      nativeThreadBecameIdle: false,
      nativeThreadNeedsStatusReconciliation: false,
      needsHistoryRemap: false,
      projectNeedsRemap: false,
      needsResume: true,
    }),
    { force: true, priority: true, resume: true },
  );
  assert.deepEqual(
    nativeThreadSyncRequestFor({
      becameActive: true,
      nativeThreadActive: true,
      nativeThreadBecameIdle: false,
      nativeThreadNeedsStatusReconciliation: false,
      needsHistoryRemap: false,
      projectNeedsRemap: false,
      needsResume: false,
    }),
    { force: true, priority: true, resume: true },
  );
  assert.deepEqual(
    nativeThreadSyncRequestFor({
      becameActive: false,
      nativeThreadActive: false,
      nativeThreadBecameIdle: false,
      nativeThreadNeedsStatusReconciliation: false,
      needsHistoryRemap: false,
      projectNeedsRemap: false,
      needsResume: false,
    }),
    { force: false, priority: false, resume: false },
  );
  assert.deepEqual(
    nativeThreadSyncRequestFor({
      becameActive: false,
      nativeThreadActive: false,
      nativeThreadBecameIdle: false,
      nativeThreadNeedsStatusReconciliation: true,
      needsHistoryRemap: false,
      projectNeedsRemap: false,
      needsResume: false,
    }),
    { force: true, priority: true, resume: false },
  );
});

it("routes only notifications belonging to an attached native Codex run", () => {
  const threadId = ThreadId.make("thread");
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const providerTurnId = ProviderTurnId.make("provider-turn");
  const runId = RunId.make("run");
  const terminal = {
    type: "turn.terminal",
    driver: ProviderDriverKind.make("codex"),
    providerThreadId,
    providerTurnId,
    runOrdinal: 1,
    status: "completed",
    failure: null,
    threadDisposition: "reusable",
  } as const;
  const output = {
    type: "command_output.delta",
    driver: ProviderDriverKind.make("codex"),
    threadId,
    itemId: TurnItemId.make("item"),
    chunk: "live output",
  } as const;

  assert.isTrue(
    nativeActiveRunEventMatches({
      event: terminal,
      runId,
      providerThreadId,
      providerTurnId,
    }),
  );
  assert.isFalse(
    nativeActiveRunEventMatches({
      event: { ...terminal, providerTurnId: ProviderTurnId.make("other-turn") },
      runId,
      providerThreadId,
      providerTurnId,
    }),
  );
  assert.isFalse(
    nativeActiveRunEventMatches({
      event: output,
      runId,
      providerThreadId,
      providerTurnId,
    }),
  );
});

it.effect("streams matching native run events through the matching terminal", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread");
    const providerThreadId = ProviderThreadId.make("provider-thread");
    const providerTurnId = ProviderTurnId.make("provider-turn");
    const runId = RunId.make("run");
    const matches = (event: ProviderAdapter.ProviderAdapterV2Event) =>
      nativeActiveRunEventMatches({
        event,
        runId,
        providerThreadId,
        providerTurnId,
      });
    const item = {
      type: "turn_item.updated",
      driver: ProviderDriverKind.make("codex"),
      turnItem: {
        id: TurnItemId.make("item"),
        threadId,
        runId,
        nodeId: null,
        providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: DateTime.makeUnsafe("2026-10-25T00:00:00.000Z"),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-10-25T00:00:00.000Z"),
        type: "reasoning",
        text: "working",
        streaming: true,
      },
    } as const;
    const terminal = {
      type: "turn.terminal",
      driver: ProviderDriverKind.make("codex"),
      providerThreadId,
      providerTurnId,
      runOrdinal: 1,
      status: "completed",
      failure: null,
      threadDisposition: "reusable",
    } as const;
    const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];

    yield* Stream.runForEach(
      nativeActiveRunEvents(
        Stream.fromIterable([
          { ...item, turnItem: { ...item.turnItem, runId: RunId.make("other-run") } },
          item,
          terminal,
          { ...item, turnItem: { ...item.turnItem, text: "after terminal" } },
        ]),
        matches,
      ),
      (event) => Effect.sync(() => events.push(event)),
    );

    assert.deepEqual(events, [item, terminal]);
  }),
);

it("keeps the persisted project as the comparison baseline when remapping Codex history", () => {
  const instanceId = ProviderInstanceId.make("codex");
  const threadId = ThreadId.make("codex:native-thread");
  const oldProjectId = ProjectId.make("old-project");
  const current: OrchestrationV2AppThread = {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: oldProjectId,
    title: "cpp-fabricmc 7th",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: ProviderThreadId.make("native-provider-thread"),
    historyOrigin: "native",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: DateTime.makeUnsafe("2026-10-01T00:00:00.000Z"),
    updatedAt: DateTime.makeUnsafe("2026-10-05T18:51:04.000Z"),
    archivedAt: null,
    settledOverride: "settled",
    settledAt: DateTime.makeUnsafe("2026-10-05T18:51:04.000Z"),
    lastVisitedAt: null,
    deletedAt: null,
  };
  const newProjectId = ProjectId.make("current-project");
  const historyUpdatedAt = DateTime.makeUnsafe("2026-10-05T18:51:04.000Z");
  const synchronized = synchronizedNativeThreadForHistory({
    existing: current,
    native: {
      nativeId: "native-thread",
      cwd: "/run/media/nico/d/学校/app/cpp-fabricmc",
      title: null,
      preview: "cpp-fabricmc 7th",
      createdAt: Date.parse("2026-10-01T00:00:00.000Z") / 1_000,
      updatedAt: Date.parse("2026-10-05T18:51:04.000Z") / 1_000,
      model: "gpt-5.4",
      reasoningEffort: null,
      archived: false,
      status: "idle",
      latestTurn: null,
      parentNativeId: null,
    },
    instanceId,
    providerThreadId: ProviderThreadId.make("native-provider-thread"),
    projectId: newProjectId,
    latestTurnStatus: "failed",
    historyUpdatedAt,
  });

  assert.equal(current.projectId, oldProjectId);
  assert.equal(synchronized.projectId, newProjectId);
  assert.notDeepEqual(synchronized, current);
});

it("forces a full history remap when the Codex run grouping version is missing", () => {
  assert.isTrue(
    shouldSyncNativeThreadHistory({
      becameActive: false,
      historySyncUpdatedAt: "2026-10-05T18:51:04.000Z",
      hasExistingThread: true,
      previousUpdatedAt: "2026-10-24T11:08:42.000Z",
      nativeUpdatedAt: "2026-10-24T11:08:42.000Z",
    }),
  );
});

it("reads every native turn when the stored history mapping needs a remap", () => {
  assert.deepEqual(
    nativeTurnIdsToSkipForHistoryRead({
      existingNativeTurnIds: ["turn:1", "turn:2", "turn:3"],
      latestNativeTurnId: "turn:3",
    }),
    [],
  );
  assert.deepEqual(
    nativeTurnIdsToSkipForHistoryRead({
      historyMappingVersion: 3,
      existingNativeTurnIds: ["turn:1", "turn:2", "turn:3"],
      latestNativeTurnId: "turn:3",
    }),
    ["turn:1", "turn:2"],
  );
  assert.deepEqual(
    nativeTurnIdsToSkipForHistoryRead({
      historyMappingVersion: 3,
      existingNativeTurnIds: ["turn:1", "turn:2", "turn:3"],
      latestNativeTurnId: "turn:3",
      nativeTurnIdsToReconcile: ["turn:2"],
    }),
    ["turn:1"],
  );
});

it("associates assistant-only Codex turns only with the preceding turn in the same root", () => {
  assert.isTrue(
    shouldReusePreviousNativeRun({
      hasUserMessage: false,
      hasExistingRun: false,
      hasPreviousRun: true,
      sameRootTurn: true,
    }),
  );
  assert.isFalse(
    shouldReusePreviousNativeRun({
      hasUserMessage: true,
      hasExistingRun: false,
      hasPreviousRun: true,
      sameRootTurn: true,
    }),
  );
  assert.isFalse(
    shouldReusePreviousNativeRun({
      hasUserMessage: false,
      hasExistingRun: true,
      hasPreviousRun: true,
      sameRootTurn: true,
    }),
  );
  assert.isFalse(
    shouldReusePreviousNativeRun({
      hasUserMessage: false,
      hasExistingRun: false,
      hasPreviousRun: true,
      sameRootTurn: false,
    }),
  );
  assert.equal(
    rootNativeTurnIdFor({ nativeId: "retry-turn", rootNativeId: "root-turn" }),
    "root-turn",
  );
  assert.equal(rootNativeTurnIdFor({ nativeId: "standalone-turn" }), "standalone-turn");
  assert.isTrue(
    shouldMaterializeNativeTurn({
      hasUserMessage: false,
      hasExistingRun: false,
      hasPreviousRun: false,
      startsRootTurn: true,
    }),
  );
  assert.isFalse(
    shouldMaterializeNativeTurn({
      hasUserMessage: false,
      hasExistingRun: false,
      hasPreviousRun: false,
      startsRootTurn: false,
    }),
  );
  assert.isTrue(
    nativeRunMatchesRootTurn({
      runStartedAt: "2026-10-26T00:19:42.000Z",
      rootTurnStartedAt: "2026-10-26T00:19:42.000Z",
    }),
  );
  assert.isFalse(
    nativeRunMatchesRootTurn({
      runStartedAt: "2026-10-25T13:02:26.000Z",
      rootTurnStartedAt: "2026-10-26T00:19:42.000Z",
    }),
  );
});

it("resolves a missing Codex cwd only to one available T3 project with the same root name", () => {
  const cwd = "/old/location/cpp-fabricmc";
  const projectId = ProjectId.make("current-project");
  const otherProjectId = ProjectId.make("other-project");
  const candidate = { projectId, workspaceRoot: "/home/nico/dev/cpp-fabricmc" };
  assert.equal(
    uniqueAvailableProjectIdForMissingNativeCwd({
      cwd,
      candidates: [candidate],
      availableWorkspaceRoots: new Set([candidate.workspaceRoot]),
    }),
    projectId,
  );
  assert.isUndefined(
    uniqueAvailableProjectIdForMissingNativeCwd({
      cwd,
      candidates: [candidate, { projectId: otherProjectId, workspaceRoot: "/work/cpp-fabricmc" }],
      availableWorkspaceRoots: new Set([candidate.workspaceRoot, "/work/cpp-fabricmc"]),
    }),
  );
  assert.isUndefined(
    uniqueAvailableProjectIdForMissingNativeCwd({
      cwd,
      candidates: [candidate],
      availableWorkspaceRoots: new Set(),
    }),
  );
});

const assistantMessage: CodexSchema.V2ThreadItemsListResponse__ThreadItem = {
  id: "assistant-message",
  type: "agentMessage",
  text: "answer",
};

function mapItem(
  item: CodexSchema.V2ThreadItemsListResponse__ThreadItem,
  input: {
    readonly turnStatus?: string;
    readonly latest?: boolean;
    readonly senderThreadId?: ThreadId;
    readonly existingItems?: Parameters<typeof mapNativeItem>[0]["existingItems"];
  } = {},
) {
  return mapNativeItem({
    nativeItem: {
      nativeId: item.id,
      type: item.type,
      startedAt: 2,
      completedAt: input.latest === true ? null : 3,
      payload: item,
    } satisfies ProviderAdapter.ProviderAdapterV2NativeItem,
    threadId: ThreadId.make("codex-history-thread"),
    ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
    instanceId: ProviderInstanceId.make("codex-history-instance"),
    providerThreadId: ProviderThreadId.make("codex-history-provider-thread"),
    providerTurnId: ProviderTurnId.make("codex-history-provider-turn"),
    runId: RunId.make("codex-history-run"),
    nodeId: NodeId.make("codex-history-root-node"),
    planId: PlanId.make("codex-history-plan"),
    turnStatus: input.turnStatus ?? "completed",
    turnCompletedAt: 3,
    isLatestItem: input.latest ?? false,
    fallbackAt: 1,
    existingItems: input.existingItems ?? [],
    existingItemsByNativeId: new Map(
      (input.existingItems ?? []).flatMap((existing) =>
        existing.nativeItemRef?.driver !== "codex" || existing.nativeItemRef.nativeId === null
          ? []
          : [[existing.nativeItemRef.nativeId, existing] as const],
      ),
    ),
    existingMessages: [],
    existingSubagents: [],
    usedMessageIds: new Set(),
    deriveMessageId: (nativeId) => MessageId.make(`message:${nativeId}`),
    deriveTurnItemId: (nativeId) => TurnItemId.make(`turn-item:${nativeId}`),
    deriveNodeId: (nativeId) => NodeId.make(`node:${nativeId}`),
    deriveProviderThreadId: (nativeId) => ProviderThreadId.make(`provider-thread:${nativeId}`),
  });
}

it("treats legacy items in a finished turn as completed without item timestamps", () => {
  assert.equal(nativeHistoryItemStatus(assistantMessage, "completed", null, false), "completed");
});

it("only treats the newest timestamp-free item as running in a live turn", () => {
  assert.equal(nativeHistoryItemStatus(assistantMessage, "inProgress", null, false), "completed");
  assert.equal(nativeHistoryItemStatus(assistantMessage, "inProgress", null, true), "running");
});

it("preserves failed and declined statuses from native tool history", () => {
  const failedCommand: CodexSchema.V2ThreadItemsListResponse__ThreadItem = {
    id: "failed-command",
    type: "commandExecution",
    command: "false",
    commandActions: [],
    cwd: "/repo",
    status: "failed",
  };
  const declinedCommand: CodexSchema.V2ThreadItemsListResponse__ThreadItem = {
    ...failedCommand,
    id: "declined-command",
    status: "declined",
  };

  assert.equal(nativeHistoryItemStatus(failedCommand, "completed", null, false), "failed");
  assert.equal(nativeHistoryItemStatus(declinedCommand, "completed", null, false), "cancelled");
});

it("keeps Codex reasoning effort and T3-only model options in the model selection", () => {
  const instanceId = ProviderInstanceId.make("codex-history-instance");
  const selection = modelSelectionFor(
    {
      nativeId: "native-thread",
      cwd: "/repo",
      title: null,
      preview: "thread",
      createdAt: 1,
      updatedAt: 2,
      model: "gpt-6-codex",
      reasoningEffort: "high",
      archived: false,
      status: "idle",
      latestTurn: null,
      parentNativeId: null,
    },
    instanceId,
    {
      instanceId,
      model: "old-model",
      options: [
        { id: "serviceTier", value: "priority" },
        { id: "reasoningEffort", value: "low" },
      ],
    },
  );

  assert.equal(selection.model, "gpt-6-codex");
  assert.deepEqual(selection.options, [
    { id: "serviceTier", value: "priority" },
    { id: "reasoningEffort", value: "high" },
  ]);
});

it("imports native Codex forks into T3 thread relationships without inventing a source run", () => {
  const instanceId = ProviderInstanceId.make("codex-history-instance");
  const sourceThreadId = ThreadId.make(`import:${instanceId}:native-source`);
  const targetThreadId = ThreadId.make(`import:${instanceId}:native-fork`);
  const sourceProviderThreadId = ProviderThreadId.make("codex-native-source-provider-thread");
  const native: ProviderAdapter.ProviderAdapterV2NativeThread = {
    nativeId: "native-fork",
    cwd: "/repo",
    title: null,
    preview: "fork",
    createdAt: 2,
    updatedAt: 3,
    model: null,
    reasoningEffort: null,
    archived: false,
    status: "idle",
    latestTurn: null,
    parentNativeId: null,
    forkedFromNativeId: "native-source",
  };

  const relationship = nativeThreadLineageFor({
    native,
    instanceId,
    threadId: targetThreadId,
    sourceProviderThreadId,
  });
  assert.deepEqual(relationship, {
    lineage: {
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork",
      rootThreadId: sourceThreadId,
    },
    forkedFrom: { type: "provider_thread", providerThreadId: sourceProviderThreadId },
  });

  const preciseExistingFork = {
    lineage: {
      parentThreadId: sourceThreadId,
      relationshipToParent: "fork" as const,
      rootThreadId: sourceThreadId,
    },
    forkedFrom: { type: "run" as const, threadId: sourceThreadId, runId: RunId.make("source-run") },
  };
  assert.deepEqual(
    nativeThreadLineageFor({
      native,
      instanceId,
      threadId: targetThreadId,
      sourceProviderThreadId,
      existing: preciseExistingFork,
    }),
    preciseExistingFork,
  );
});

it("keeps Codex native child threads classified as subagents when the parent loads later", () => {
  const instanceId = ProviderInstanceId.make("codex-history-instance");
  const parentThreadId = ThreadId.make(`import:${instanceId}:native-parent`);
  const threadId = ThreadId.make(`import:${instanceId}:native-child`);
  const relationship = nativeThreadLineageFor({
    native: {
      nativeId: "native-child",
      cwd: "/repo",
      title: null,
      preview: "child",
      createdAt: 2,
      updatedAt: 3,
      model: null,
      reasoningEffort: null,
      archived: false,
      status: "idle",
      latestTurn: null,
      parentNativeId: "native-parent",
    },
    instanceId,
    threadId,
  });

  assert.deepEqual(relationship, {
    lineage: {
      parentThreadId,
      relationshipToParent: "subagent",
      rootThreadId: parentThreadId,
    },
    forkedFrom: null,
  });
});

it("retires runs removed from the Codex branch and ambiguous runs after its retained head", () => {
  const removed = nativeHistoryRunIdsRemoved({
    runs: [
      { id: "retained-first", ordinal: 1, nativeTurnId: "turn-1" },
      { id: "removed-middle", ordinal: 2, nativeTurnId: "turn-2" },
      { id: "retained-latest", ordinal: 3, nativeTurnId: "turn-3" },
      { id: "removed-tail-without-ref", ordinal: 4, nativeTurnId: null },
      { id: "older-run-without-ref", ordinal: 0, nativeTurnId: null },
    ],
    retainedTurnIds: new Set(["turn-1", "turn-3"]),
  });

  assert.deepEqual(removed, ["removed-middle", "removed-tail-without-ref"]);
});

it("keeps Codex user text and attachment markers in the imported message", () => {
  const mapped = mapItem({
    id: "user-with-image",
    type: "userMessage",
    content: [
      { type: "text", text: "Review this" },
      { type: "localImage", path: "/repo/screenshot.png" },
    ],
  });

  assert.isNotNull(mapped);
  assert.equal(mapped?.turnItems[0]?.type, "user_message");
  if (mapped?.turnItems[0]?.type === "user_message") {
    assert.equal(mapped.turnItems[0].text, "Review this[Image attachment: /repo/screenshot.png]");
  }
});

it("keeps one native message id when history links it to a run and imports its timeline item", () => {
  const expectedId = MessageId.make("existing-user-message");
  const input = {
    nativeItem: { nativeId: "native-user-item", startedAt: null } as never,
    existingItemsByNativeId: new Map(),
    text: "same prompt",
    role: "user" as const,
    existingMessages: [
      {
        id: expectedId,
        role: "user",
        text: "same prompt",
        createdAt: DateTime.makeUnsafe("2026-10-26T00:00:00.000Z"),
      },
    ] as never,
    usedMessageIds: new Set<MessageId>(),
    messageIdsByNativeItemId: new Map(),
    deriveMessageId: () => MessageId.make("derived-user-message"),
  };

  const runMessageId = findOrDeriveMessageId(input);
  const timelineMessageId = findOrDeriveMessageId(input);

  assert.equal(runMessageId, expectedId);
  assert.equal(timelineMessageId, expectedId);
});

it("retains Codex image and utility tool history in the T3 timeline", () => {
  const imageView = mapItem({
    id: "image-view",
    type: "imageView",
    path: "/repo/output.png",
  });
  const imageGeneration = mapItem({
    id: "image-generation",
    type: "imageGeneration",
    status: "completed",
    result: "large-image-payload",
    revisedPrompt: "A small blue icon",
    savedPath: "/repo/generated.png",
  });
  const sleep = mapItem({ id: "sleep", type: "sleep", durationMs: 250 });

  assert.equal(imageView?.turnItems[0]?.type, "dynamic_tool");
  if (imageView?.turnItems[0]?.type === "dynamic_tool") {
    assert.equal(imageView.turnItems[0].toolName, "view_image");
    assert.deepEqual(imageView.turnItems[0].input, { path: "/repo/output.png" });
  }
  assert.equal(imageGeneration?.turnItems[0]?.type, "dynamic_tool");
  if (imageGeneration?.turnItems[0]?.type === "dynamic_tool") {
    assert.equal(imageGeneration.turnItems[0].toolName, "image_generation");
    assert.deepEqual(imageGeneration.turnItems[0].output, {
      status: "completed",
      savedPath: "/repo/generated.png",
    });
  }
  assert.equal(sleep?.turnItems[0]?.type, "dynamic_tool");
  if (sleep?.turnItems[0]?.type === "dynamic_tool") {
    assert.equal(sleep.turnItems[0].toolName, "sleep");
    assert.deepEqual(sleep.turnItems[0].input, { durationMs: 250 });
  }
});

it("attributes provider-native subagent prompts to their parent thread", () => {
  const senderThreadId = ThreadId.make("codex-history-parent-thread");
  const mapped = mapItem(
    { id: "subagent-prompt", type: "userMessage", content: [{ type: "text", text: "Inspect" }] },
    { senderThreadId },
  );

  const message = mapped?.events.find((event) => event.type === "message.updated");
  assert.isDefined(message);
  if (message?.type === "message.updated") {
    assert.equal(message.payload.createdBy, "agent");
    assert.equal(message.payload.senderThreadId, senderThreadId);
  }
  const item = mapped?.turnItems[0];
  assert.equal(item?.type, "user_message");
  if (item?.type === "user_message") {
    assert.equal(item.createdBy, "agent");
    assert.equal(item.senderThreadId, senderThreadId);
  }
});

it("keeps assistant history linked to its native execution node", () => {
  const mapped = mapItem({ id: "assistant-native-item", type: "agentMessage", text: "Done" });
  const message = mapped?.events.find((event) => event.type === "message.updated");
  const node = mapped?.events.find((event) => event.type === "node.updated");

  assert.isDefined(message);
  assert.isDefined(node);
  if (message?.type === "message.updated" && node?.type === "node.updated") {
    assert.equal(message.payload.nodeId, node.payload.id);
    assert.equal(node.payload.kind, "assistant_message");
    assert.equal(node.payload.parentNodeId, NodeId.make("codex-history-root-node"));
  }
});

it("reuses the indexed native turn item when importing the same history item again", () => {
  const original = mapItem({
    id: "indexed-native-item",
    type: "reasoning",
    content: ["before"],
  })?.turnItems[0];
  assert.isDefined(original);

  const updated = mapItem(
    { id: "indexed-native-item", type: "reasoning", content: ["after"] },
    { existingItems: [original] },
  );

  assert.equal(updated?.turnItems[0]?.id, original.id);
  if (updated?.turnItems[0]?.type === "reasoning") {
    assert.equal(updated.turnItems[0].text, "after");
  }
});

it("imports reasoning and compaction as their native T3 item kinds without fake tool nodes", () => {
  const reasoning = mapItem({
    id: "reasoning",
    type: "reasoning",
    content: ["step one", "step two"],
    summary: ["short summary"],
  });
  const compaction = mapItem({ id: "compaction", type: "contextCompaction" });

  assert.isNotNull(reasoning);
  assert.equal(reasoning?.turnItems[0]?.type, "reasoning");
  assert.deepEqual(
    reasoning?.events.map((event) => event.type),
    ["turn-item.updated"],
  );
  if (reasoning?.turnItems[0]?.type === "reasoning") {
    assert.equal(reasoning.turnItems[0].text, "step onestep two");
  }

  assert.isNotNull(compaction);
  assert.equal(compaction?.turnItems[0]?.type, "compaction");
  assert.deepEqual(
    compaction?.events.map((event) => event.type),
    ["turn-item.updated"],
  );

  const activeCompaction = mapItem(
    { id: "active-compaction", type: "contextCompaction" },
    { turnStatus: "inProgress", latest: true },
  );
  assert.equal(activeCompaction?.turnItems[0]?.status, "running");
});

it("keeps plan artifacts and execution nodes attached to the native plan item", () => {
  const mapped = mapItem({ id: "plan-native-item", type: "plan", text: "1. Inspect\n2. Fix" });

  assert.isNotNull(mapped);
  assert.equal(mapped?.turnItems[0]?.type, "proposed_plan");
  const node = mapped?.events.find((event) => event.type === "node.updated");
  const plan = mapped?.events.find((event) => event.type === "plan.updated");
  assert.isDefined(node);
  assert.isDefined(plan);
  if (node?.type === "node.updated" && plan?.type === "plan.updated") {
    assert.equal(node.payload.kind, "plan");
    assert.equal(node.payload.id, NodeId.make("node:plan-native-item"));
    assert.equal(plan.payload.nodeId, node.payload.id);
    assert.equal(plan.payload.status, "active");
  }
});

it("retains command output and all changed paths from native execution items", () => {
  const command = mapItem({
    id: "command-native-item",
    type: "commandExecution",
    command: "bun run check",
    commandActions: [],
    cwd: "/repo",
    aggregatedOutput: "check passed",
    exitCode: 0,
    status: "completed",
  });
  const fileChange = mapItem({
    id: "file-native-item",
    type: "fileChange",
    status: "completed",
    changes: [
      { path: "src/a.ts", diff: "-old\n+new", kind: { type: "update" } },
      { path: "src/b.ts", diff: "+added", kind: { type: "add" } },
    ],
  });

  assert.equal(command?.turnItems[0]?.type, "command_execution");
  if (command?.turnItems[0]?.type === "command_execution") {
    assert.equal(command.turnItems[0].output, "check passed");
    assert.equal(command.turnItems[0].exitCode, 0);
  }
  assert.equal(fileChange?.turnItems[0]?.type, "file_change");
  if (fileChange?.turnItems[0]?.type === "file_change") {
    assert.equal(fileChange.turnItems[0].diffStr, "-old\n+new");
    assert.deepEqual(fileChange.turnItems[0].changes, [
      { operation: "update", path: "src/a.ts" },
      { operation: "add", path: "src/b.ts" },
    ]);
  }
});

it("keeps native web-search and MCP tool inputs and outputs", () => {
  const search = mapItem({
    id: "search-native-item",
    type: "webSearch",
    query: "Codex app server",
    action: { type: "search", queries: ["Codex app server", "Codex daemon"] },
    results: [{ title: "App Server", url: "https://example.test", snippet: "Protocol" }],
  });
  const mcp = mapItem({
    id: "mcp-native-item",
    type: "mcpToolCall",
    status: "completed",
    server: "filesystem",
    tool: "read_file",
    arguments: { path: "README.md" },
    result: { content: [], structuredContent: { text: "read" } },
  });
  const dynamic = mapItem({
    id: "dynamic-native-item",
    type: "dynamicToolCall",
    status: "completed",
    namespace: "browser",
    tool: "open",
    arguments: { url: "https://example.test" },
    contentItems: [{ type: "inputText", text: "opened" }],
  });

  assert.equal(search?.turnItems[0]?.type, "web_search");
  if (search?.turnItems[0]?.type === "web_search") {
    assert.deepEqual(search.turnItems[0].patterns, ["Codex app server", "Codex daemon"]);
    assert.equal(search.turnItems[0].results?.[0]?.title, "App Server");
  }
  assert.equal(mcp?.turnItems[0]?.type, "dynamic_tool");
  if (mcp?.turnItems[0]?.type === "dynamic_tool") {
    assert.equal(mcp.turnItems[0].toolName, "filesystem.read_file");
    assert.deepEqual(mcp.turnItems[0].output, { text: "read" });
  }
  assert.equal(dynamic?.turnItems[0]?.type, "dynamic_tool");
  if (dynamic?.turnItems[0]?.type === "dynamic_tool") {
    assert.equal(dynamic.turnItems[0].toolName, "browser.open");
    assert.deepEqual(dynamic.turnItems[0].output, [{ type: "inputText", text: "opened" }]);
  }
});

it("projects native subagent activity into the parent run", () => {
  const mapped = mapItem({
    id: "subagent-activity",
    type: "subAgentActivity",
    agentPath: "reviewer",
    agentThreadId: "child-codex-thread",
    kind: "started",
  });
  const task = mapped?.events.find((event) => event.type === "subagent.updated");

  assert.isDefined(task);
  if (task?.type === "subagent.updated") {
    assert.equal(task.payload.status, "running");
    assert.equal(
      task.payload.childThreadId,
      ThreadId.make("import:codex-history-instance:child-codex-thread"),
    );
  }
  assert.equal(mapped?.turnItems[0]?.type, "subagent");
});

it("does not render unsupported Codex bookkeeping items as tools", () => {
  const mapped = mapItem({ id: "hook-prompt", type: "hookPrompt", fragments: [] });
  assert.isNull(mapped);
});
