import {
  RuntimeItemId,
  type EventId,
  type ProviderApprovalDecision,
  type ProviderKind,
  type ProviderRuntimeEvent,
  type ThreadId,
  type TurnId,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { Schema } from "effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

export type AcpAdapterRawSource = "acp.jsonrpc" | `acp.${string}.extension`;

export interface AcpEventStamp {
  readonly eventId: EventId;
  readonly createdAt: string;
}

function runtimeItemStatusFromToolCallStatus(
  status: "pending" | "inProgress" | "completed" | "failed" | undefined,
): "inProgress" | "completed" | "failed" | undefined {
  switch (status) {
    case "pending":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

export function mapAcpToAdapterError(
  provider: ProviderKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (Schema.is(EffectAcpErrors.AcpProcessExitedError)(error)) {
    return new ProviderAdapterSessionClosedError({
      provider,
      threadId,
      cause: error,
    });
  }
  if (Schema.is(EffectAcpErrors.AcpRequestError)(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    case "cancel":
    default:
      return "reject-once";
  }
}

export function makeAcpRequestOpenedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly requestType:
    | "exec_command_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "unknown";
  readonly detail: string;
  readonly args: unknown;
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "request.opened",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: input.requestType,
      detail: input.detail,
      args: input.args,
    },
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpRequestResolvedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly requestId: RuntimeRequestId;
  readonly requestType:
    | "exec_command_approval"
    | "file_read_approval"
    | "file_change_approval"
    | "unknown";
  readonly decision: ProviderApprovalDecision;
}): ProviderRuntimeEvent {
  return {
    type: "request.resolved",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    requestId: input.requestId,
    payload: {
      requestType: input.requestType,
      decision: input.decision,
    },
  };
}

export function makeAcpPlanUpdatedEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly payload: {
    readonly explanation?: string | null;
    readonly plan: ReadonlyArray<{
      readonly step: string;
      readonly status: "pending" | "inProgress" | "completed";
    }>;
  };
  readonly source: AcpAdapterRawSource;
  readonly method: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "turn.plan.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: input.payload,
    raw: {
      source: input.source,
      method: input.method,
      payload: input.rawPayload,
    },
  };
}

export function makeAcpToolCallEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly toolCall: AcpToolCallState;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  const runtimeStatus = runtimeItemStatusFromToolCallStatus(input.toolCall.status);
  return {
    type:
      input.toolCall.status === "completed" || input.toolCall.status === "failed"
        ? "item.completed"
        : "item.updated",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    itemId: RuntimeItemId.makeUnsafe(input.toolCall.toolCallId),
    payload: {
      itemType: input.toolCall.itemType,
      ...(runtimeStatus ? { status: runtimeStatus } : {}),
      ...(input.toolCall.title ? { title: input.toolCall.title } : {}),
      ...(input.toolCall.detail ? { detail: input.toolCall.detail } : {}),
      ...(Object.keys(input.toolCall.data).length > 0 ? { data: input.toolCall.data } : {}),
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}

export function makeAcpContentDeltaEvent(input: {
  readonly stamp: AcpEventStamp;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly turnId: TurnId | undefined;
  readonly text: string;
  readonly rawPayload: unknown;
}): ProviderRuntimeEvent {
  return {
    type: "content.delta",
    ...input.stamp,
    provider: input.provider,
    threadId: input.threadId,
    turnId: input.turnId,
    payload: {
      streamKind: "assistant_text",
      delta: input.text,
    },
    raw: {
      source: "acp.jsonrpc",
      method: "session/update",
      payload: input.rawPayload,
    },
  };
}
