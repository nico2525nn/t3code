import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ThreadId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const asCommandId = (value: string): CommandId => CommandId.make(value);
const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);

const now = "2026-01-01T00:00:00.000Z";

const seedReadModel = Effect.gen(function* () {
  const initial = createEmptyReadModel(now);
  const withProject = yield* projectEvent(initial, {
    sequence: 1,
    eventId: asEventId("evt-project-create"),
    aggregateKind: "project",
    aggregateId: asProjectId("project-workflow"),
    type: "project.created",
    occurredAt: now,
    commandId: asCommandId("cmd-project-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-project-create"),
    metadata: {},
    payload: {
      projectId: asProjectId("project-workflow"),
      title: "Project Workflow",
      workspaceRoot: "/tmp/project-workflow",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });

  return yield* projectEvent(withProject, {
    sequence: 2,
    eventId: asEventId("evt-thread-create"),
    aggregateKind: "thread",
    aggregateId: asThreadId("thread-workflow"),
    type: "thread.created",
    occurredAt: now,
    commandId: asCommandId("cmd-thread-create"),
    causationEventId: null,
    correlationId: asCommandId("cmd-thread-create"),
    metadata: {},
    payload: {
      threadId: asThreadId("thread-workflow"),
      projectId: asProjectId("project-workflow"),
      title: "Thread Workflow",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
    },
  });
});

it.layer(NodeServices.layer)("decider thread.task.stop", (it) => {
  it.effect("emits a thread.task-stop-requested event carrying the task id", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.task.stop",
          commandId: asCommandId("cmd-task-stop"),
          threadId: asThreadId("thread-workflow"),
          taskId: "task-9",
          createdAt: now,
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.type).toBe("thread.task-stop-requested");
      expect(event.payload).toMatchObject({
        threadId: asThreadId("thread-workflow"),
        taskId: "task-9",
        createdAt: now,
      });
    }),
  );

  it.effect("rejects a task stop for a thread that does not exist", () =>
    Effect.gen(function* () {
      const readModel = yield* seedReadModel;
      const error = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "thread.task.stop",
            commandId: asCommandId("cmd-task-stop-missing"),
            threadId: asThreadId("thread-missing"),
            taskId: "task-9",
            createdAt: now,
          },
          readModel,
        }),
      );
      expect(error.message).toContain("thread-missing");
      expect(error.message).toContain("does not exist");
    }),
  );
});
