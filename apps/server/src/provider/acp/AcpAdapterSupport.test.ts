import { RuntimeRequestId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  acpPermissionOutcome,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpToolCallEvent,
} from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("maps ACP approval decisions to permission outcomes", () => {
    expect(acpPermissionOutcome("accept")).toBe("allow-once");
    expect(acpPermissionOutcome("acceptForSession")).toBe("allow-always");
    expect(acpPermissionOutcome("decline")).toBe("reject-once");
  });

  it("builds shared ACP-backed runtime events", () => {
    const stamp = { eventId: "event-1" as never, createdAt: "2026-03-27T00:00:00.000Z" };
    const turnId = TurnId.makeUnsafe("turn-1");

    expect(
      makeAcpRequestOpenedEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        requestId: RuntimeRequestId.makeUnsafe("request-1"),
        requestType: "exec_command_approval",
        detail: "cat package.json",
        args: { command: ["cat", "package.json"] },
        source: "acp.jsonrpc",
        method: "session/request_permission",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "request.opened",
      provider: "cursor",
      turnId,
      payload: {
        requestType: "exec_command_approval",
        detail: "cat package.json",
      },
    });

    expect(
      makeAcpPlanUpdatedEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        payload: {
          plan: [{ step: "Inspect state", status: "inProgress" }],
        },
        source: "acp.cursor.extension",
        method: "cursor/update_todos",
        rawPayload: { todos: [] },
      }),
    ).toMatchObject({
      type: "turn.plan.updated",
      raw: {
        method: "cursor/update_todos",
      },
    });

    expect(
      makeAcpToolCallEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        toolCall: {
          toolCallId: "tool-1",
          itemType: "command_execution",
          status: "completed",
          title: "Terminal",
          detail: "bun run test",
          data: { command: "bun run test" },
        },
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "item.completed",
      payload: {
        itemType: "command_execution",
        status: "completed",
      },
    });

    expect(
      makeAcpContentDeltaEvent({
        stamp,
        provider: "cursor",
        threadId: "thread-1" as never,
        turnId,
        text: "hello",
        rawPayload: { sessionId: "session-1" },
      }),
    ).toMatchObject({
      type: "content.delta",
      payload: {
        delta: "hello",
      },
    });
  });
});
