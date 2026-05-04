import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asMessageId = (value: string): MessageId => MessageId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

async function projectEvents(
  readModel: OrchestrationReadModel,
  events: ReadonlyArray<Omit<OrchestrationEvent, "sequence">>,
): Promise<OrchestrationReadModel> {
  let next = readModel;
  let sequence = readModel.snapshotSequence;
  for (const event of events) {
    sequence += 1;
    const sequencedEvent = {
      ...event,
      sequence,
    } as OrchestrationEvent;
    next = await Effect.runPromise(projectEvent(next, sequencedEvent));
  }
  return next;
}

async function seedReadModel(): Promise<OrchestrationReadModel> {
  const createdAt = "2026-01-01T00:00:00.000Z";
  return projectEvents(createEmptyReadModel(createdAt), [
    {
      eventId: asEventId("evt-project-create"),
      aggregateKind: "project",
      aggregateId: asProjectId("project-branch"),
      type: "project.created",
      occurredAt: createdAt,
      commandId: asCommandId("cmd-project-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-project-create"),
      metadata: {},
      payload: {
        projectId: asProjectId("project-branch"),
        title: "Project Branch",
        workspaceRoot: "/tmp/project-branch",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      eventId: asEventId("evt-thread-create"),
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-source"),
      type: "thread.created",
      occurredAt: createdAt,
      commandId: asCommandId("cmd-thread-create"),
      causationEventId: null,
      correlationId: asCommandId("cmd-thread-create"),
      metadata: {},
      payload: {
        threadId: asThreadId("thread-source"),
        projectId: asProjectId("project-branch"),
        title: "Source Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "feature/source",
        worktreePath: "/tmp/project-branch-worktree",
        createdAt,
        updatedAt: createdAt,
      },
    },
    {
      eventId: asEventId("evt-message-user"),
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-source"),
      type: "thread.message-sent",
      occurredAt: "2026-01-01T00:01:00.000Z",
      commandId: asCommandId("cmd-message-user"),
      causationEventId: null,
      correlationId: asCommandId("cmd-message-user"),
      metadata: {},
      payload: {
        threadId: asThreadId("thread-source"),
        messageId: asMessageId("message-user"),
        role: "user",
        text: "hello",
        attachments: [
          {
            type: "image",
            id: "thread-source-00000000-0000-4000-8000-000000000001",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 123,
          },
        ],
        turnId: null,
        streaming: false,
        createdAt: "2026-01-01T00:01:00.000Z",
        updatedAt: "2026-01-01T00:01:00.000Z",
      },
    },
    {
      eventId: asEventId("evt-message-assistant"),
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-source"),
      type: "thread.message-sent",
      occurredAt: "2026-01-01T00:02:00.000Z",
      commandId: asCommandId("cmd-message-assistant"),
      causationEventId: null,
      correlationId: asCommandId("cmd-message-assistant"),
      metadata: {},
      payload: {
        threadId: asThreadId("thread-source"),
        messageId: asMessageId("message-assistant"),
        role: "assistant",
        text: "partial response",
        turnId: asTurnId("turn-source"),
        streaming: true,
        createdAt: "2026-01-01T00:02:00.000Z",
        updatedAt: "2026-01-01T00:02:00.000Z",
      },
    },
    {
      eventId: asEventId("evt-activity-tool"),
      aggregateKind: "thread",
      aggregateId: asThreadId("thread-source"),
      type: "thread.activity-appended",
      occurredAt: "2026-01-01T00:03:00.000Z",
      commandId: asCommandId("cmd-activity-tool"),
      causationEventId: null,
      correlationId: asCommandId("cmd-activity-tool"),
      metadata: {},
      payload: {
        threadId: asThreadId("thread-source"),
        activity: {
          id: asEventId("activity-tool-source"),
          tone: "tool",
          kind: "tool.completed",
          summary: "Read file",
          payload: {
            toolCallId: "tool-call-source",
            detail: "read README.md",
            requestId: "source-request-id",
          },
          turnId: asTurnId("turn-source"),
          sequence: 10,
          createdAt: "2026-01-01T00:03:00.000Z",
        },
      },
    },
  ]);
}

describe("decideOrchestrationCommand thread.branch", () => {
  it("creates a branched thread and copies transcript messages and activities", async () => {
    const readModel = await seedReadModel();
    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.branch",
          commandId: asCommandId("cmd-thread-branch"),
          sourceThreadId: asThreadId("thread-source"),
          threadId: asThreadId("thread-branch"),
          createdAt: "2026-01-01T01:00:00.000Z",
        },
      }),
    );

    const events = Array.isArray(decided) ? decided : [decided];
    expect(events.map((event) => event.type)).toEqual([
      "thread.created",
      "thread.message-sent",
      "thread.message-sent",
      "thread.activity-appended",
    ]);

    const created = events[0];
    expect(created?.type).toBe("thread.created");
    if (created?.type !== "thread.created") {
      throw new Error("Expected first event to create a thread.");
    }
    expect(created.payload).toMatchObject({
      threadId: asThreadId("thread-branch"),
      projectId: asProjectId("project-branch"),
      title: "Source Thread (Branched)",
      runtimeMode: "approval-required",
      branch: "feature/source",
      worktreePath: "/tmp/project-branch-worktree",
    });

    const copiedMessages = events.filter((event) => event.type === "thread.message-sent");
    expect(copiedMessages.every((event) => event.type === "thread.message-sent")).toBe(true);
    for (const event of copiedMessages) {
      if (event.type !== "thread.message-sent") {
        throw new Error("Expected copied event to be a message.");
      }
      expect(event.payload.threadId).toBe(asThreadId("thread-branch"));
      expect(event.payload.turnId).toBeNull();
      expect(event.payload.streaming).toBe(false);
      expect(event.payload.messageId).not.toBe(asMessageId("message-user"));
      expect(event.payload.messageId).not.toBe(asMessageId("message-assistant"));
      expect(event.payload.attachments).toBeUndefined();
      expect(event.causationEventId).toBe(created.eventId);
    }

    const copiedActivity = events.find((event) => event.type === "thread.activity-appended");
    expect(copiedActivity?.type).toBe("thread.activity-appended");
    if (copiedActivity?.type !== "thread.activity-appended") {
      throw new Error("Expected copied tool activity.");
    }
    expect(copiedActivity.payload.threadId).toBe(asThreadId("thread-branch"));
    expect(copiedActivity.payload.activity.id).not.toBe(asEventId("activity-tool-source"));
    expect(copiedActivity.payload.activity.turnId).toBeNull();
    expect(copiedActivity.payload.activity).toMatchObject({
      tone: "tool",
      kind: "tool.completed",
      summary: "Read file",
      payload: {
        toolCallId: "tool-call-source",
        detail: "read README.md",
      },
    });
    expect(copiedActivity.payload.activity.payload).not.toMatchObject({
      requestId: "source-request-id",
    });
    expect(copiedActivity.causationEventId).toBe(created.eventId);

    const branchedReadModel = await projectEvents(readModel, events);
    const branchedThread = branchedReadModel.threads.find(
      (thread) => thread.id === asThreadId("thread-branch"),
    );
    expect(branchedThread?.messages.map((message) => message.text)).toEqual([
      "hello",
      "partial response",
    ]);
    expect(branchedThread?.messages.every((message) => message.turnId === null)).toBe(true);
    expect(branchedThread?.messages.every((message) => !message.streaming)).toBe(true);
    expect(branchedThread?.activities.map((activity) => activity.summary)).toEqual(["Read file"]);
    expect(branchedThread?.activities.every((activity) => activity.turnId === null)).toBe(true);
  });

  it("branches through a selected completed assistant message", async () => {
    const readModel = await projectEvents(await seedReadModel(), [
      {
        eventId: asEventId("evt-message-assistant-complete"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-source"),
        type: "thread.message-sent",
        occurredAt: "2026-01-01T00:02:30.000Z",
        commandId: asCommandId("cmd-message-assistant-complete"),
        causationEventId: null,
        correlationId: asCommandId("cmd-message-assistant-complete"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-source"),
          messageId: asMessageId("message-assistant"),
          role: "assistant",
          text: "",
          turnId: asTurnId("turn-source"),
          streaming: false,
          createdAt: "2026-01-01T00:02:30.000Z",
          updatedAt: "2026-01-01T00:02:30.000Z",
        },
      },
      {
        eventId: asEventId("evt-later-message-user"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-source"),
        type: "thread.message-sent",
        occurredAt: "2026-01-01T00:04:00.000Z",
        commandId: asCommandId("cmd-later-message-user"),
        causationEventId: null,
        correlationId: asCommandId("cmd-later-message-user"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-source"),
          messageId: asMessageId("message-later-user"),
          role: "user",
          text: "later prompt",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:04:00.000Z",
          updatedAt: "2026-01-01T00:04:00.000Z",
        },
      },
      {
        eventId: asEventId("evt-later-activity-tool"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-source"),
        type: "thread.activity-appended",
        occurredAt: "2026-01-01T00:05:00.000Z",
        commandId: asCommandId("cmd-later-activity-tool"),
        causationEventId: null,
        correlationId: asCommandId("cmd-later-activity-tool"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-source"),
          activity: {
            id: asEventId("activity-later-tool"),
            tone: "tool",
            kind: "tool.completed",
            summary: "Edited file",
            payload: {
              toolCallId: "tool-call-later",
              detail: "edit src/index.ts",
            },
            turnId: asTurnId("turn-later"),
            sequence: 20,
            createdAt: "2026-01-01T00:05:00.000Z",
          },
        },
      },
      {
        eventId: asEventId("evt-later-message-assistant"),
        aggregateKind: "thread",
        aggregateId: asThreadId("thread-source"),
        type: "thread.message-sent",
        occurredAt: "2026-01-01T00:06:00.000Z",
        commandId: asCommandId("cmd-later-message-assistant"),
        causationEventId: null,
        correlationId: asCommandId("cmd-later-message-assistant"),
        metadata: {},
        payload: {
          threadId: asThreadId("thread-source"),
          messageId: asMessageId("message-later-assistant"),
          role: "assistant",
          text: "later response",
          turnId: asTurnId("turn-later"),
          streaming: false,
          createdAt: "2026-01-01T00:06:00.000Z",
          updatedAt: "2026-01-01T00:06:00.000Z",
        },
      },
    ]);

    const decided = await Effect.runPromise(
      decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.branch",
          commandId: asCommandId("cmd-thread-branch-message"),
          sourceThreadId: asThreadId("thread-source"),
          sourceMessageId: asMessageId("message-assistant"),
          threadId: asThreadId("thread-branch-message"),
          createdAt: "2026-01-01T01:00:00.000Z",
        },
      }),
    );

    const events = Array.isArray(decided) ? decided : [decided];
    const branchedReadModel = await projectEvents(readModel, events);
    const branchedThread = branchedReadModel.threads.find(
      (thread) => thread.id === asThreadId("thread-branch-message"),
    );

    expect(branchedThread?.messages.map((message) => message.text)).toEqual([
      "hello",
      "partial response",
    ]);
    expect(branchedThread?.activities.map((activity) => activity.summary)).toEqual(["Read file"]);
    expect(branchedThread?.messages.every((message) => message.turnId === null)).toBe(true);
    expect(branchedThread?.activities.every((activity) => activity.turnId === null)).toBe(true);
  });
});
