import { EventId, TurnId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { projectCodexNativeActivities } from "./CodexNativeActivityProjection.ts";

it("keeps Codex receiver-agent names when reconstructing the Agents panel", () => {
  const activities = projectCodexNativeActivities([
    {
      id: EventId.make("native-collab-1"),
      tone: "tool",
      kind: "tool.completed",
      summary: "spawnAgent",
      payload: {
        itemType: "collab_agent_tool_call",
        data: {
          item: {
            type: "collabAgentToolCall",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: "parent",
            receiverThreadIds: ["child"],
            receiverAgents: [{ threadId: "child", agentNickname: "Hume" }],
            agentsStates: { child: { status: "pendingInit" } },
          },
        },
      },
      turnId: TurnId.make("turn-1"),
      createdAt: "2026-09-10T00:00:00.000Z",
    },
  ]);

  expect(activities).toHaveLength(1);
  expect(activities[0]).toMatchObject({
    kind: "task.updated",
    payload: {
      taskId: "child",
      title: "Hume",
      status: "pending",
      timelineBypass: true,
    },
  });
});
