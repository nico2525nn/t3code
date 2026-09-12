// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { readCodexRolloutTurns } from "./CodexRolloutHistory.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => NodeFSP.rm(directory, { recursive: true, force: true })),
  );
});

function event(timestamp: string, payload: Record<string, unknown>): string {
  return `${JSON.stringify({ type: "event_msg", timestamp, payload })}\n`;
}

describe("readCodexRolloutTurns", () => {
  it("normalizes rollout item fields to the App Server thread-item shape", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-codex-rollout-"));
    temporaryDirectories.push(directory);
    const path = NodePath.join(directory, "rollout.jsonl");
    const turnId = "turn-1";
    await NodeFSP.writeFile(
      path,
      [
        event("2026-09-10T00:00:00.000Z", {
          type: "task_started",
          turn_id: turnId,
          started_at: 1_789_000_000,
        }),
        event("2026-09-10T00:00:01.000Z", {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "Reasoning",
            id: "reasoning-1",
            summary_text: ["Checking the repository"],
            raw_content: [],
          },
        }),
        event("2026-09-10T00:00:02.000Z", {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "CommandExecution",
            id: "command-1",
            command: ["git", "status", "--short"],
            cwd: "file:///tmp/project",
            parsed_cmd: [{ type: "unknown", cmd: "git status --short" }],
            source: "unified_exec_startup",
            status: "completed",
            exit_code: 0,
            duration: { secs: 1, nanos: 2 },
          },
        }),
        event("2026-09-10T00:00:03.000Z", {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "CollabAgentToolCall",
            id: "agent-call-1",
            tool: "spawn_agent",
            status: "completed",
            sender_thread_id: "parent",
            receiver_thread_ids: ["child"],
            receiver_agents: [{ thread_id: "child", agent_nickname: "Hume" }],
            agents_states: { child: "pending_init" },
          },
        }),
        event("2026-09-10T00:00:04.000Z", {
          type: "item_completed",
          turn_id: turnId,
          item: {
            type: "Extension",
            kind: "web.search",
            id: "search-1",
            query: "",
            action: { type: "other" },
            results: [{ title: "result" }],
          },
        }),
        event("2026-09-10T00:00:05.000Z", {
          type: "task_complete",
          turn_id: turnId,
          completed_at: 1_789_000_005,
          duration_ms: 5_000,
        }),
      ].join(""),
    );

    const turns = await readCodexRolloutTurns(path);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.items).toMatchObject([
      {
        type: "reasoning",
        id: "reasoning-1",
        summary: ["Checking the repository"],
      },
      {
        type: "commandExecution",
        id: "command-1",
        cwd: "/tmp/project",
        source: "unifiedExecStartup",
        exitCode: 0,
        durationMs: 1_000,
      },
      {
        type: "collabAgentToolCall",
        id: "agent-call-1",
        agentsStates: { child: { status: "pendingInit" } },
        receiverAgents: [{ threadId: "child", agentNickname: "Hume" }],
      },
      {
        type: "webSearch",
        id: "search-1",
        query: "",
      },
    ]);
    expect(turns[0]?.status).toBe("completed");
  });
});
