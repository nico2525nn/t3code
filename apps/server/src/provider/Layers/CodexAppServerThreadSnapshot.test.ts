import { expect, it } from "@effect/vitest";
import {
  DEFAULT_MODEL,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { ProviderStoredThreadHistory } from "../Services/ProviderAdapter.ts";
import type { ProviderInstanceRegistryShape } from "../Services/ProviderInstanceRegistry.ts";
import {
  codexStoredDiffRange,
  isCodexAppServerThread,
  projectCodexStoredThreadHistory,
  readCodexThreadThrough,
} from "./CodexAppServerThreadSnapshot.ts";

const instanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("codex:native-thread");
const projectId = ProjectId.make("project-codex");
const baseTime = "2026-09-14T00:00:00.000Z";

function activity(id: string, turnId: string): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: id,
    payload: { toolCallId: id },
    turnId: TurnId.make(turnId),
    createdAt: `2026-09-14T00:00:0${turnId.slice(-1)}.000Z`,
  };
}

function runtimeEvent(id: string, turnId: string): ProviderRuntimeEvent {
  return {
    eventId: EventId.make(id),
    provider: ProviderDriverKind.make("codex"),
    threadId,
    turnId: TurnId.make(turnId),
    createdAt: `2026-09-14T00:00:0${turnId.slice(-1)}.400Z`,
    type: "item.completed",
    payload: {
      itemType: "command_execution",
      status: "completed",
      title: id,
    },
  };
}

function storedHistory(): ProviderStoredThreadHistory {
  const turns = [1, 2, 3, 4].map((value) => ({
    turnId: TurnId.make(`turn-${value}`),
    anchorAt: `2026-09-14T00:00:0${value}.000Z`,
    status: "completed" as const,
    startedAt: `2026-09-14T00:00:0${value}.000Z`,
    completedAt: `2026-09-14T00:00:0${value}.500Z`,
    hasUserMessage: true,
  }));
  return {
    nativeThreadId: "native-thread",
    cwd: "/tmp/codex-project",
    title: "Native thread",
    preview: "Native preview",
    createdAt: baseTime,
    updatedAt: "2026-09-14T00:00:04.500Z",
    archived: false,
    ephemeral: false,
    subAgent: false,
    active: false,
    latestTurnId: TurnId.make("turn-4"),
    turns,
    messages: turns.flatMap(({ turnId }, index) => [
      {
        messageId: `user-${index + 1}`,
        role: "user" as const,
        text: `Prompt ${index + 1}`,
        turnId,
        createdAt: `2026-09-14T00:00:0${index + 1}.000Z`,
      },
      {
        messageId: `assistant-${index + 1}`,
        role: "assistant" as const,
        text: `Answer ${index + 1}`,
        turnId,
        createdAt: `2026-09-14T00:00:0${index + 1}.400Z`,
      },
    ]),
    turnDiffs: [
      {
        turnId: TurnId.make("turn-2"),
        completedAt: "2026-09-14T00:00:02.500Z",
        diff: "diff --git a/old.ts b/old.ts\n-old\n+new",
        files: [{ path: "old.ts", kind: "modified", additions: 1, deletions: 1 }],
        status: "ready" as const,
      },
      {
        turnId: TurnId.make("turn-4"),
        completedAt: "2026-09-14T00:00:04.500Z",
        diff: "diff --git a/new.ts b/new.ts\n-before\n+after",
        files: [{ path: "new.ts", kind: "modified", additions: 1, deletions: 1 }],
        status: "ready" as const,
      },
    ],
    runtimeEvents: turns.map(({ turnId }, index) =>
      runtimeEvent(`activity-${index + 1}`, String(turnId)),
    ),
  };
}

function snapshot(overrides: Partial<OrchestrationThread> = {}): OrchestrationThreadDetailSnapshot {
  const thread = {
    id: threadId,
    projectId,
    title: "T3 shell title",
    modelSelection: { instanceId, model: DEFAULT_MODEL },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: null,
    latestTurn: null,
    createdAt: baseTime,
    updatedAt: baseTime,
    archivedAt: null,
    settledOverride: "settled" as const,
    settledAt: baseTime,
    deletedAt: null,
    messages: [
      {
        id: MessageId.make("legacy-t3-message"),
        role: "assistant" as const,
        text: "This must be replaced",
        turnId: null,
        streaming: false,
        createdAt: baseTime,
        updatedAt: baseTime,
      },
    ],
    proposedPlans: [],
    activities: [activity("legacy-t3-activity", "turn-1")],
    checkpoints: [],
    session: null,
    ...overrides,
  } as unknown as OrchestrationThread;
  return { snapshotSequence: 42, thread };
}

it("projects one canonical native transcript and replaces stale T3 rows", () => {
  const result = projectCodexStoredThreadHistory(snapshot(), storedHistory());

  expect(result.thread.messages.map((message) => String(message.id))).toEqual([
    "user-1",
    "assistant-1",
    "user-2",
    "assistant-2",
    "user-3",
    "assistant-3",
    "user-4",
    "assistant-4",
  ]);
  expect(result.thread.messages.some((message) => message.text === "This must be replaced")).toBe(
    false,
  );
  expect(result.thread.activities.map((entry) => String(entry.id))).toEqual([
    "activity-1",
    "activity-2",
    "activity-3",
    "activity-4",
  ]);
  expect(result.thread.checkpoints.map((checkpoint) => String(checkpoint.checkpointRef))).toEqual([
    `provider-diff:${threadId}:turn-2`,
    `provider-diff:${threadId}:turn-4`,
  ]);
  expect(result.thread.latestTurn).toMatchObject({
    turnId: TurnId.make("turn-4"),
    state: "completed",
    assistantMessageId: MessageId.make("assistant-4"),
  });
});

it("overlays only the current live turn while native history catches up", () => {
  const history = storedHistory();
  const current = snapshot({
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-4"),
      lastError: null,
      updatedAt: "2026-09-14T00:00:04.600Z",
    },
    messages: [
      {
        id: MessageId.make("user-4"),
        role: "user" as const,
        text: "Prompt 4 live",
        turnId: TurnId.make("turn-4"),
        streaming: false,
        createdAt: "2026-09-14T00:00:04.000Z",
        updatedAt: "2026-09-14T00:00:04.600Z",
      },
      {
        id: MessageId.make("assistant-live-4"),
        role: "assistant" as const,
        text: "Still streaming",
        turnId: TurnId.make("turn-4"),
        streaming: true,
        createdAt: "2026-09-14T00:00:04.400Z",
        updatedAt: "2026-09-14T00:00:04.600Z",
      },
      {
        id: MessageId.make("pending-user"),
        role: "user" as const,
        text: "Pending prompt",
        turnId: null,
        streaming: false,
        createdAt: "2026-09-14T00:00:04.500Z",
        updatedAt: "2026-09-14T00:00:04.500Z",
      },
      {
        id: MessageId.make("old-live-row"),
        role: "assistant" as const,
        text: "Old projected copy",
        turnId: TurnId.make("turn-1"),
        streaming: false,
        createdAt: "2026-09-14T00:00:01.400Z",
        updatedAt: "2026-09-14T00:00:01.400Z",
      },
    ],
    activities: [
      activity("live-activity-4", "turn-4"),
      activity("old-activity-1", "turn-1"),
      {
        ...activity("codex-history:old-activity", "turn-4"),
        id: EventId.make("codex-history:old-activity"),
      },
    ],
  });

  const result = projectCodexStoredThreadHistory(current, {
    ...history,
    active: true,
    activeTurnId: TurnId.make("turn-4"),
  });

  expect(result.thread.messages.map((message) => String(message.id))).toContain("pending-user");
  expect(result.thread.messages.map((message) => String(message.id))).toContain("assistant-live-4");
  expect(result.thread.messages.map((message) => String(message.id))).not.toContain("old-live-row");
  expect(result.thread.messages.find((message) => String(message.id) === "user-4")?.text).toBe(
    "Prompt 4 live",
  );
  expect(result.thread.activities.map((entry) => String(entry.id))).toContain("live-activity-4");
  expect(result.thread.activities.map((entry) => String(entry.id))).not.toContain("old-activity-1");
  expect(result.thread.activities.map((entry) => String(entry.id))).not.toContain(
    "codex-history:old-activity",
  );
});

it("does not duplicate an optimistic user row when native history has no client id", () => {
  const current = snapshot({
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-4"),
      lastError: null,
      updatedAt: "2026-09-14T00:00:04.600Z",
    },
    messages: [
      {
        id: MessageId.make("optimistic-user"),
        role: "user" as const,
        text: "Prompt 4",
        turnId: null,
        streaming: false,
        createdAt: "2026-09-14T00:00:04.000Z",
        updatedAt: "2026-09-14T00:00:04.600Z",
      },
    ],
  });
  const history = storedHistory();
  const nativeHistory = {
    ...history,
    messages: history.messages.map((message) =>
      message.messageId === "user-4"
        ? {
            ...message,
            messageId: "codex:native-thread:user:turn-4:native-user-4",
          }
        : message,
    ),
  };

  const result = projectCodexStoredThreadHistory(current, nativeHistory);
  const turnMessages = result.thread.messages.filter(
    (message) => String(message.turnId) === "turn-4",
  );

  expect(turnMessages.map((message) => String(message.id))).toEqual([
    "codex:native-thread:user:turn-4:native-user-4",
    "assistant-4",
  ]);
  expect(turnMessages.some((message) => String(message.id) === "optimistic-user")).toBe(false);
});

it("keeps a newer same-text pending message when native history is stale", () => {
  const current = snapshot({
    latestTurn: {
      turnId: TurnId.make("turn-5"),
      state: "running",
      requestedAt: "2026-09-14T00:00:05.000Z",
      startedAt: "2026-09-14T00:00:05.000Z",
      completedAt: null,
      assistantMessageId: null,
    },
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-5"),
      lastError: null,
      updatedAt: "2026-09-14T00:00:05.000Z",
    },
    messages: [
      {
        id: MessageId.make("new-pending-user"),
        role: "user" as const,
        text: "Prompt 4",
        turnId: null,
        streaming: false,
        createdAt: "2026-09-14T00:00:05.000Z",
        updatedAt: "2026-09-14T00:00:05.000Z",
      },
    ],
  });
  const history = storedHistory();

  const result = projectCodexStoredThreadHistory(current, {
    ...history,
    active: true,
    activeTurnId: TurnId.make("turn-4"),
  });

  expect(result.thread.messages.some((message) => String(message.id) === "new-pending-user")).toBe(
    true,
  );
});

it("keeps the latest live turn visible when the native read is one step behind", () => {
  const current = snapshot({
    updatedAt: "2026-09-14T00:00:05.000Z",
    latestTurn: {
      turnId: TurnId.make("turn-4"),
      state: "completed",
      requestedAt: "2026-09-14T00:00:04.000Z",
      startedAt: "2026-09-14T00:00:04.000Z",
      completedAt: "2026-09-14T00:00:04.500Z",
      assistantMessageId: MessageId.make("assistant-4"),
    },
    session: {
      threadId,
      status: "idle",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-09-14T00:00:05.000Z",
    },
    messages: [
      {
        id: MessageId.make("assistant-4"),
        role: "assistant" as const,
        text: "Newer live answer",
        turnId: TurnId.make("turn-4"),
        streaming: false,
        createdAt: "2026-09-14T00:00:04.400Z",
        updatedAt: "2026-09-14T00:00:05.000Z",
      },
    ],
  });

  const result = projectCodexStoredThreadHistory(snapshot(current.thread), {
    ...storedHistory(),
    updatedAt: "2026-09-14T00:00:04.000Z",
  });

  expect(result.thread.messages.find((message) => String(message.id) === "assistant-4")?.text).toBe(
    "Newer live answer",
  );
});

it("returns disjoint recent and older pages without changing the client contract", () => {
  const history = storedHistory();
  const first = projectCodexStoredThreadHistory(snapshot(), history, {
    turnLimit: 2,
  });

  expect(first.thread.messages.map((message) => String(message.turnId))).toEqual([
    "turn-3",
    "turn-3",
    "turn-4",
    "turn-4",
  ]);
  expect(first.page?.hasMore).toBe(true);
  expect(first.page?.beforeCursor).toEqual(expect.any(String));

  const older = projectCodexStoredThreadHistory(snapshot(), history, {
    turnLimit: 2,
    ...(first.page?.beforeCursor === null || first.page?.beforeCursor === undefined
      ? {}
      : { beforeCursor: first.page.beforeCursor }),
  });
  expect(older.thread.messages.map((message) => String(message.turnId))).toEqual([
    "turn-1",
    "turn-1",
    "turn-2",
    "turn-2",
  ]);
  expect(older.page?.hasMore).toBe(false);
  expect(
    new Set(older.thread.messages.map((message) => String(message.id))).intersection(
      new Set(first.thread.messages.map((message) => String(message.id))),
    ).size,
  ).toBe(0);
});

it("reads native diff ranges with the same bounds as T3 checkpoints", () => {
  const history = storedHistory();

  expect(codexStoredDiffRange(history, 0, 1)).toContain("old.ts");
  expect(codexStoredDiffRange(history, 1, 2)).toContain("new.ts");
  expect(codexStoredDiffRange(history, 2, 2)).toBe("");
  expect(codexStoredDiffRange(history, -1, 1)).toBeUndefined();
  expect(codexStoredDiffRange(history, 0, 3)).toBeUndefined();
});

it("keeps current latest turn and session when an older page is requested", () => {
  const current = snapshot({
    latestTurn: {
      turnId: TurnId.make("turn-4"),
      state: "completed",
      requestedAt: "2026-09-14T00:00:04.000Z",
      startedAt: "2026-09-14T00:00:04.000Z",
      completedAt: "2026-09-14T00:00:04.500Z",
      assistantMessageId: MessageId.make("assistant:assistant-4"),
    },
    session: {
      threadId,
      status: "running",
      providerName: "codex",
      providerInstanceId: instanceId,
      runtimeMode: "full-access",
      activeTurnId: TurnId.make("turn-4"),
      lastError: null,
      updatedAt: "2026-09-14T00:00:04.000Z",
    },
  });
  const first = projectCodexStoredThreadHistory(current, storedHistory(), {
    turnLimit: 2,
  });
  const older = projectCodexStoredThreadHistory(current, storedHistory(), {
    turnLimit: 2,
    ...(first.page?.beforeCursor === null || first.page?.beforeCursor === undefined
      ? {}
      : { beforeCursor: first.page.beforeCursor }),
  });

  expect(older.thread.latestTurn).toMatchObject({
    turnId: TurnId.make("turn-4"),
  });
  expect(older.thread.session).toMatchObject({
    status: "running",
    activeTurnId: TurnId.make("turn-4"),
  });
});

it("recognizes only canonical Codex projection thread ids", () => {
  expect(isCodexAppServerThread("codex:native-thread")).toBe(true);
  expect(isCodexAppServerThread("claude:native-thread")).toBe(false);
  expect(isCodexAppServerThread("codex:")).toBe(false);
});

it.effect("does not fall back to the T3 transcript for a canonical thread", () =>
  Effect.gen(function* () {
    const registry = {
      getInstance: () => Effect.succeed(undefined),
    } as unknown as ProviderInstanceRegistryShape;

    const error = yield* readCodexThreadThrough(snapshot(), registry).pipe(Effect.flip);

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toContain("Codex App Server history is unavailable");
  }),
);
