import { describe, expect, it } from "vite-plus/test";
import { MessageId, TurnId } from "@t3tools/contracts";
import type {
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import {
  projectActivityEvent,
  projectActivityPayload,
  projectThreadDetailSnapshot,
} from "./ActivityPayloadProjection.ts";

function activity(payload: Record<string, unknown>): OrchestrationThreadActivity {
  return {
    id: "activity-1",
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    payload,
    turnId: null,
    createdAt: "2026-08-01T10:00:00.000Z",
  } as unknown as OrchestrationThreadActivity;
}

function collabActivity(
  kind: OrchestrationThreadActivity["kind"],
  id: string,
  item: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id,
    tone: "tool",
    kind,
    summary: "Collaboration tool",
    payload: {
      itemType: "collab_agent_tool_call",
      data: { item },
    },
    turnId: null,
    sequence: Number(id.replace(/\D/gu, "")) || undefined,
    createdAt: `2026-08-01T10:00:0${id.replace(/\D/gu, "") || "0"}.000Z`,
  } as unknown as OrchestrationThreadActivity;
}

function message(
  overrides: Omit<Partial<OrchestrationMessage>, "id" | "turnId"> & {
    id?: string;
    turnId?: string | null;
  },
): OrchestrationMessage {
  const { id = "message-default", turnId = null, ...rest } = overrides;
  return {
    id: MessageId.make(id),
    role: "user",
    text: "message",
    turnId: turnId === null ? null : TurnId.make(turnId),
    streaming: false,
    createdAt: "2026-08-01T10:00:00.000Z",
    updatedAt: "2026-08-01T10:00:00.000Z",
    ...rest,
  };
}

/**
 * Wire-survival regression: the slimming pass rewrites payload.data but must
 * never strip the top-level per-agent fields the subagent fold depends on.
 * If slimming ever moves to an allowlist over the whole payload, these
 * assertions are the tripwire.
 */
describe("projectActivityPayload", () => {
  it("preserves tool attribution (agentId/parentToolUseId) through data slimming", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        agentId: "task-123",
        parentToolUseId: "toolu_abc",
        data: {
          toolName: "Bash",
          input: { command: "ls" },
          command: "ls",
          rawOutput: { content: "x".repeat(10) },
          somethingClientNeverReads: { big: "blob" },
        },
      }),
    );
    const payload = projected.payload as Record<string, unknown>;
    expect(payload.agentId).toBe("task-123");
    expect(payload.parentToolUseId).toBe("toolu_abc");
    // Slimming itself still applies to data.
    const data = payload.data as Record<string, unknown>;
    expect(data.somethingClientNeverReads).toBeUndefined();
  });

  it("keeps a bounded Codex command output summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          item: {
            command: "/bin/zsh -lc 'printf hello'",
            aggregatedOutput: `hello from codex\n${"x".repeat(5000)}`,
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.item).toEqual({
      command: "/bin/zsh -lc 'printf hello'",
      aggregatedOutput: "hello from codex",
    });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("keeps preview normalization and fence-only fallback while scanning lines", () => {
    const preview = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: `\`\`\`\n  actual\tresult  \n${"x".repeat(5000)}` },
      }),
    );
    const fences = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: { rawOutput: "```\r\n \t \n```\n" },
      }),
    );

    expect((preview.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "actual result",
    });
    expect((fences.payload as { data: { rawOutput: unknown } }).data.rawOutput).toEqual({
      content: "2 lines",
    });
  });

  it("keeps bounded Claude and ACP command output summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          rawOutput: { stdout: `hello from claude\n${"y".repeat(5000)}` },
        },
      }),
    );
    const acp = projectActivityPayload(
      activity({
        itemType: "command_execution",
        data: {
          command: "printf hello",
          content: [
            {
              type: "content",
              content: { type: "text", text: `hello from acp\n${"z".repeat(5000)}` },
            },
          ],
        },
      }),
    );

    const claudeData = (claude.payload as Record<string, unknown>).data as Record<string, unknown>;
    const acpData = (acp.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(claudeData.rawOutput).toEqual({ content: "hello from claude" });
    expect(acpData.rawOutput).toEqual({ content: "hello from acp" });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(500);
    expect(JSON.stringify(acp.payload).length).toBeLessThan(500);
  });

  it("keeps bounded Claude command input and result summaries", () => {
    const claude = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "claude-call-1",
        data: {
          toolName: "Bash",
          input: { command: "vp test run" },
          result: {
            type: "tool_result",
            content: [
              { type: "text", text: "tests passed" },
              { type: "text", text: "x".repeat(5_000) },
            ],
          },
        },
      }),
    );
    const openCode = projectActivityPayload(
      activity({
        itemType: "command_execution",
        toolCallId: "opencode-call-1",
        data: {
          tool: "bash",
          state: {
            status: "running",
            input: { command: "vp lint" },
            output: "x".repeat(5_000),
          },
        },
      }),
    );

    expect(claude.payload).toMatchObject({
      toolCallId: "claude-call-1",
      data: {
        toolName: "Bash",
        command: "vp test run",
        rawOutput: { content: "tests passed" },
      },
    });
    expect(openCode.payload).toMatchObject({
      toolCallId: "opencode-call-1",
      data: { command: "vp lint" },
    });
    expect(JSON.stringify(claude.payload).length).toBeLessThan(250);
    expect(JSON.stringify(openCode.payload).length).toBeLessThan(200);
  });

  it("keeps full Claude Read image paths through repeated projection", () => {
    const imagePath = `/workspace/${"nested folder/".repeat(16)}reference image.webp`;
    const projected = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        detail: 'Read: {"file_path":"truncated..."}',
        data: {
          toolName: "Read",
          input: { file_path: imagePath },
          result: { content: "Image Size: 1280x720." },
        },
      }),
    );
    const projectedAgain = projectActivityPayload(projected);

    expect(projected.payload).toMatchObject({ data: { imagePath } });
    expect(projectedAgain.payload).toMatchObject({ data: { imagePath } });

    const textRead = projectActivityPayload(
      activity({
        itemType: "dynamic_tool_call",
        data: { toolName: "Read", input: { file_path: "/workspace/src/index.ts" } },
      }),
    );
    expect(textRead.payload).not.toMatchObject({ data: { imagePath: expect.anything() } });
  });

  it("slims Codex-shaped mcp_tool_call items to rendered fields plus a result summary", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          item: {
            type: "mcpToolCall",
            id: "item-1",
            tool: "fetch_pr",
            server: "github",
            status: "completed",
            arguments: { pr: 42 },
            durationMs: 1200,
            result: {
              content: [{ type: "text", text: `PR body line one\n${"x".repeat(5000)}` }],
              structuredContent: { huge: "y".repeat(5000) },
            },
            _meta: { internal: true },
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    const item = data.item as Record<string, unknown>;
    expect(item.tool).toBe("fetch_pr");
    expect(item.server).toBe("github");
    expect(item.arguments).toEqual({ pr: 42 });
    expect(item._meta).toBeUndefined();
    expect(item.result).toEqual({ content: "PR body line one" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("slims Claude-shaped mcp_tool_call data (toolName/input/result block)", () => {
    const projected = projectActivityPayload(
      activity({
        itemType: "mcp_tool_call",
        data: {
          toolName: "mcp__github__fetch_pr",
          input: { pr: 42 },
          result: {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: `first line of output\n${"z".repeat(5000)}` }],
          },
        },
      }),
    );
    const data = (projected.payload as Record<string, unknown>).data as Record<string, unknown>;
    expect(data.toolName).toBe("mcp__github__fetch_pr");
    expect(data.input).toEqual({ pr: 42 });
    expect(data.result).toEqual({ content: "first line of output" });
    expect(JSON.stringify(projected.payload).length).toBeLessThan(500);
  });

  it("passes task lifecycle payloads (no data field) through untouched", () => {
    const source = activity({
      taskId: "task-9",
      title: "Audit auth",
      role: "explorer",
      model: "opus",
      effort: "high",
      workflowName: "audit-flow",
      phases: [{ index: 0, title: "Audit" }],
      typedUsage: { totalTokens: 1200 },
      runHandles: { runId: "run-1", scriptPath: "/tmp/wf.js" },
      timelineBypass: true,
    });
    const projected = projectActivityPayload(source);
    expect(projected.payload).toEqual(source.payload);
  });

  it("projects legacy Codex collaboration history to the existing task contract", () => {
    const snapshot = {
      thread: {
        activities: [
          collabActivity("tool.started", "activity-1", {
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            receiverThreadIds: ["native-child"],
            prompt: "Review the provider history",
          }),
          collabActivity("tool.completed", "activity-2", {
            type: "collabAgentToolCall",
            tool: "wait",
            receiverThreadIds: ["native-child"],
            agentsStates: {
              "native-child": { status: "completed", message: "Review complete" },
            },
          }),
        ],
      },
    } as unknown as OrchestrationThreadDetailSnapshot;

    const projected = projectThreadDetailSnapshot(snapshot);
    const tasks = projected.thread.activities.filter((entry) => entry.kind.startsWith("task."));

    expect(tasks.map((entry) => entry.kind)).toEqual(["task.started", "task.completed"]);
    expect(tasks[0]?.payload).toMatchObject({
      taskId: "native-child",
      taskType: "subagent",
      agentKind: "agent",
      title: "Review the provider history",
      timelineBypass: true,
    });
    expect(tasks[1]?.payload).toMatchObject({
      taskId: "native-child",
      status: "completed",
      summary: "Review complete",
    });
  });

  it("does not synthesize a second task when the live adapter already projected it", () => {
    const existingTask = {
      ...activity({
        taskId: "native-child",
        taskType: "subagent",
        agentKind: "agent",
        title: "Canonical child",
      }),
      kind: "task.started",
    } as unknown as OrchestrationThreadActivity;
    const snapshot = {
      thread: {
        activities: [
          existingTask,
          collabActivity("tool.completed", "activity-3", {
            type: "collabAgentToolCall",
            tool: "wait",
            receiverThreadIds: ["native-child"],
            agentsStates: { "native-child": { status: "completed" } },
          }),
        ],
      },
    } as unknown as OrchestrationThreadDetailSnapshot;

    const projected = projectThreadDetailSnapshot(snapshot);
    expect(projected.thread.activities.filter((entry) => entry.kind.startsWith("task."))).toEqual([
      existingTask,
    ]);
  });

  it("collapses duplicate completed tool rows by provider call id", () => {
    const duplicate = (id: string, detail?: string): OrchestrationThreadActivity =>
      ({
        id,
        tone: "tool",
        kind: "tool.completed",
        summary: "Ran command",
        payload: {
          itemType: "command_execution",
          toolCallId: "exec-duplicate",
          ...(detail ? { detail } : {}),
        },
        turnId: null,
        createdAt: "2026-08-01T10:00:00.000Z",
      }) as unknown as OrchestrationThreadActivity;
    const snapshot = {
      thread: {
        activities: [duplicate("duplicate-1"), duplicate("duplicate-2", "richer detail")],
      },
    } as unknown as OrchestrationThreadDetailSnapshot;

    const projected = projectThreadDetailSnapshot(snapshot);
    expect(projected.thread.activities).toHaveLength(1);
    expect(projected.thread.activities[0]?.id).toBe("duplicate-2");
  });

  it("does not send live and Codex history copies in a thread snapshot", () => {
    const live = message({
      id: "user-live",
      text: "same prompt",
      turnId: "turn-1",
    });
    const imported = message({
      id: "import:codex:native:turn-1:item-1",
      text: "same prompt",
      turnId: "turn-1",
    });
    const snapshot = {
      snapshotSequence: 42,
      thread: {
        messages: [live, imported, imported],
        activities: [],
      },
    } as unknown as OrchestrationThreadDetailSnapshot;

    const projected = projectThreadDetailSnapshot(snapshot);

    expect(projected.thread.messages).toEqual([live]);
  });

  it("uses the Codex history text when an old live bridge doubled the same item", () => {
    const live = message({
      id: "assistant:item-1",
      role: "assistant",
      text: "first answerfirst answer",
      turnId: "turn-1",
      streaming: true,
      createdAt: "2026-08-01T10:00:02.000Z",
      updatedAt: "2026-08-01T10:00:03.000Z",
    });
    const imported = message({
      id: "import:codex:native:turn-1:item-1",
      role: "assistant",
      text: "first answer",
      turnId: "turn-1",
      streaming: false,
      createdAt: "2026-08-01T10:00:01.000Z",
      updatedAt: "2026-08-01T10:00:01.000Z",
    });
    const duplicateSegment = message({
      id: "assistant:item-1:segment:1",
      role: "assistant",
      text: "first answer",
      turnId: "turn-1",
      createdAt: "2026-08-01T10:00:02.000Z",
    });
    const snapshot = {
      snapshotSequence: 42,
      thread: {
        messages: [live, imported, duplicateSegment],
        activities: [],
      },
    } as unknown as OrchestrationThreadDetailSnapshot;

    const projected = projectThreadDetailSnapshot(snapshot);

    expect(projected.thread.messages).toHaveLength(1);
    expect(projected.thread.messages[0]).toMatchObject({
      id: live.id,
      role: "assistant",
      text: imported.text,
      createdAt: imported.createdAt,
      turnId: imported.turnId,
      streaming: false,
    });
  });

  it("keeps identical prompts from separate Codex turns", () => {
    const first = message({
      id: "import:codex:native:turn-1:item-1",
      text: "repeat",
      turnId: "turn-1",
    });
    const second = message({
      id: "import:codex:native:turn-2:item-1",
      text: "repeat",
      turnId: "turn-2",
    });
    const snapshot = {
      snapshotSequence: 42,
      thread: { messages: [first, second], activities: [] },
    } as unknown as OrchestrationThreadDetailSnapshot;

    const projected = projectThreadDetailSnapshot(snapshot);

    expect(projected.thread.messages).toEqual([first, second]);
  });
});

describe("projectActivityEvent", () => {
  it("maps Codex history assistant events onto the existing live item id", () => {
    const event = {
      type: "thread.message-sent",
      metadata: { historyImport: true },
      payload: {
        threadId: "codex:thread-1",
        messageId: "import:codex:thread-1:turn-1:item-1",
        role: "assistant",
        text: "completed answer",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
    } as unknown as OrchestrationEvent;

    const projected = projectActivityEvent(event);

    expect(projected).toMatchObject({
      type: "thread.message-sent",
      payload: { messageId: "assistant:item-1", text: "completed answer" },
    });
  });

  it("does not rewrite user history ids because they have no native live id", () => {
    const event = {
      type: "thread.message-sent",
      metadata: { historyImport: true },
      payload: {
        threadId: "codex:thread-1",
        messageId: "import:codex:thread-1:turn-1:user-1",
        role: "user",
        text: "prompt",
        turnId: "turn-1",
        streaming: false,
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-08-01T10:00:00.000Z",
      },
    } as unknown as OrchestrationEvent;

    expect(projectActivityEvent(event)).toBe(event);
  });
});
