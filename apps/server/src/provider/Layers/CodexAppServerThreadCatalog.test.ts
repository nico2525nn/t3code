import { expect, it } from "@effect/vitest";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  codexAppServerThreadMessages,
  codexAppServerThreadToStoredThread,
} from "./CodexAdapter.ts";

const makeThread = (
  overrides: Partial<EffectCodexSchema.V2ThreadReadResponse__Thread> = {},
): EffectCodexSchema.V2ThreadReadResponse__Thread =>
  ({
    cliVersion: "test-codex",
    createdAt: 1_700_000_000,
    cwd: "/tmp/codex-project",
    ephemeral: false,
    id: "native-thread-1",
    modelProvider: "openai",
    preview: "Fix the import",
    sessionId: "session-1",
    source: "appServer",
    status: { type: "idle" },
    turns: [],
    updatedAt: 1_700_000_120,
    ...overrides,
  }) as EffectCodexSchema.V2ThreadReadResponse__Thread;

it("normalizes Codex catalog metadata without losing native identity", () => {
  const stored = codexAppServerThreadToStoredThread(
    makeThread({
      name: "  Import   the existing thread  ",
      source: { subAgent: "review" },
      status: { type: "active", activeFlags: [] },
      turns: [
        {
          id: "active-turn",
          status: "inProgress",
          items: [],
        },
      ],
    }),
    true,
  );

  expect(stored).toMatchObject({
    nativeThreadId: "native-thread-1",
    cwd: "/tmp/codex-project",
    title: "Import the existing thread",
    preview: "Fix the import",
    createdAt: "2023-11-14T22:13:20.000Z",
    updatedAt: "2023-11-14T22:15:20.000Z",
    archived: true,
    ephemeral: false,
    subAgent: true,
    active: true,
    activeTurnId: "active-turn",
  });
});

it("imports only durable user and assistant text with deterministic ids", () => {
  const thread = makeThread({
    turns: [
      {
        id: "turn-1",
        startedAt: 1_700_000_001,
        status: "completed",
        items: [
          {
            id: "user-1",
            type: "userMessage",
            content: [{ type: "text", text: "Fix the import" }],
          },
          { id: "plan-1", type: "plan", text: "Inspect" },
          {
            id: "assistant-1",
            type: "agentMessage",
            text: "I fixed the import.",
          },
          {
            id: "image-only",
            type: "userMessage",
            content: [{ type: "localImage", path: "/tmp/screenshot.png" }],
          },
        ],
      },
    ],
  });

  expect(codexAppServerThreadMessages(thread)).toEqual([
    {
      messageId: "import:codex:native-thread-1:turn-1:user-1",
      role: "user",
      text: "Fix the import",
      turnId: "turn-1",
      createdAt: "2023-11-14T22:13:21.000Z",
    },
    {
      messageId: "import:codex:native-thread-1:turn-1:assistant-1",
      role: "assistant",
      text: "I fixed the import.",
      turnId: "turn-1",
      createdAt: "2023-11-14T22:13:21.000Z",
    },
    {
      messageId: "import:codex:native-thread-1:turn-1:image-only",
      role: "user",
      text: "[1 Codex attachment]",
      turnId: "turn-1",
      createdAt: "2023-11-14T22:13:21.000Z",
    },
  ]);
});

it("uses rollout item timestamps when ordering messages around tools", () => {
  const thread = makeThread({
    turns: [
      {
        id: "turn-1",
        startedAt: 1_700_000_001,
        status: "completed",
        items: [
          {
            id: "user-1",
            type: "userMessage",
            content: [{ type: "text", text: "Run the tests" }],
            __codexRolloutCompletedAt: "2026-09-10T00:00:01.000Z",
          } as unknown as EffectCodexSchema.V2ThreadReadResponse__ThreadItem,
          {
            id: "assistant-1",
            type: "agentMessage",
            text: "The tests pass.",
            __codexRolloutCompletedAt: "2026-09-10T00:00:03.000Z",
          } as unknown as EffectCodexSchema.V2ThreadReadResponse__ThreadItem,
        ],
      },
    ],
  });

  expect(codexAppServerThreadMessages(thread).map((message) => message.createdAt)).toEqual([
    "2026-09-10T00:00:01.000Z",
    "2026-09-10T00:00:03.000Z",
  ]);
});
