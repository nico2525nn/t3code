import {
  ApprovalRequestId,
  classifyTaskAgentKind,
  EventId,
  isToolLifecycleItemType,
  type OrchestrationThreadActivity,
  type ProviderRuntimeEvent,
  type ThreadTokenUsageSnapshot,
  TurnId,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";

import { projectActivityPayload } from "./ActivityPayloadProjection.ts";

export function toTurnId(value: TurnId | string | undefined): TurnId | undefined {
  return value === undefined ? undefined : TurnId.make(String(value));
}

function toApprovalRequestId(value: string | undefined): ApprovalRequestId | undefined {
  return value === undefined ? undefined : ApprovalRequestId.make(value);
}

export function truncateDetail(value: string, limit = 180): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

export function hasRenderableAssistantText(text: string | undefined): boolean {
  return (text?.trim().length ?? 0) > 0;
}

type ToolLifecycleEvent = Extract<
  ProviderRuntimeEvent,
  { readonly type: "item.started" | "item.updated" | "item.completed" }
>;

function toolLifecyclePayload(event: ToolLifecycleEvent): Record<string, unknown> {
  const payload = event.payload;
  return {
    itemType: payload.itemType,
    ...(event.itemId !== undefined ? { toolCallId: event.itemId } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.title ? { title: payload.title } : {}),
    ...(payload.detail ? { detail: truncateDetail(payload.detail) } : {}),
    ...(payload.toolSurface ? { toolSurface: payload.toolSurface } : {}),
    ...(payload.toolIcon ? { toolIcon: payload.toolIcon } : {}),
    ...(payload.toolSource ? { toolSource: payload.toolSource } : {}),
    ...(payload.data !== undefined ? { data: payload.data } : {}),
    ...(payload.agentId ? { agentId: payload.agentId } : {}),
    ...(payload.parentToolUseId ? { parentToolUseId: payload.parentToolUseId } : {}),
  };
}

function toolLifecycleActivity(event: ToolLifecycleEvent): OrchestrationThreadActivity {
  const kind =
    event.type === "item.started"
      ? "tool.started"
      : event.type === "item.updated"
        ? "tool.updated"
        : "tool.completed";
  const title = event.payload.title ?? (kind === "tool.started" ? "Tool" : "Tool updated");
  const sequence = (event as ProviderRuntimeEvent & { readonly sessionSequence?: number })
    .sessionSequence;
  return {
    id: event.eventId,
    createdAt: event.createdAt,
    tone: "tool",
    kind,
    summary: kind === "tool.started" ? `${title} started` : title,
    payload: toolLifecyclePayload(event),
    turnId: toTurnId(event.turnId) ?? null,
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function reasoningLifecycleActivity(
  event: ToolLifecycleEvent,
): OrchestrationThreadActivity | undefined {
  const detail = event.payload.detail?.trim();
  if (!detail) return undefined;
  const sequence = (event as ProviderRuntimeEvent & { readonly sessionSequence?: number })
    .sessionSequence;
  return {
    id: event.eventId,
    createdAt: event.createdAt,
    tone: "info",
    kind: "task.progress",
    summary: event.payload.title ?? "Reasoning",
    payload: {
      itemType: "reasoning",
      summary: detail,
      detail,
      ...(event.payload.data !== undefined ? { data: event.payload.data } : {}),
    },
    turnId: toTurnId(event.turnId) ?? null,
    ...(sequence === undefined ? {} : { sequence }),
  };
}

function requestKindFromCanonicalRequestType(
  requestType: string | undefined,
): "command" | "file-read" | "file-change" | "mcp-elicitation" | undefined {
  switch (requestType) {
    case "command_execution_approval":
    case "exec_command_approval":
      return "command";
    case "file_read_approval":
      return "file-read";
    case "file_change_approval":
    case "apply_patch_approval":
      return "file-change";
    case "mcp_elicitation_approval":
      return "mcp-elicitation";
    default:
      return undefined;
  }
}

/**
 * Copies the optional TaskAgentLinkage bundle from a task.* runtime payload
 * into the persisted activity payload. Identity fields ride on every row so
 * client folds survive activity retention; absent fields stay absent.
 */
function taskLinkageActivityFields(payload: Record<string, unknown>): Record<string, unknown> {
  const fields: Record<string, unknown> = {
    // Server-stamped classification: persisted rows are self-describing, so
    // clients trust the stamp instead of re-deriving agent-vs-background
    // from taskType denylists and marker heuristics (legacy rows without a
    // stamp keep the client fallback).
    agentKind: classifyTaskAgentKind({
      taskType: typeof payload.taskType === "string" ? payload.taskType : undefined,
      agentId: typeof payload.agentId === "string" ? payload.agentId : undefined,
    }),
  };
  for (const key of [
    "taskType",
    "agentId",
    "title",
    "role",
    "model",
    "effort",
    "toolUseId",
    "parentAgentId",
    "workflowName",
    "agentIndex",
    "phaseIndex",
    "phaseTitle",
    "phases",
    "attempt",
    "runHandles",
    "outputFile",
    "agentPath",
    "timelineBypass",
    "typedUsage",
    "status",
    "error",
  ] as const) {
    if (payload[key] !== undefined) {
      fields[key] = payload[key];
    }
  }
  return fields;
}

export function runtimeEventToActivities(
  event: ProviderRuntimeEvent,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  const maybeSequence = (() => {
    const eventWithSequence = event as ProviderRuntimeEvent & { sessionSequence?: number };
    return eventWithSequence.sessionSequence !== undefined
      ? { sequence: eventWithSequence.sessionSequence }
      : {};
  })();
  switch (event.type) {
    case "request.opened": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.requested",
          summary:
            requestKind === "command"
              ? "Command approval requested"
              : requestKind === "file-read"
                ? "File-read approval requested"
                : requestKind === "file-change"
                  ? "File-change approval requested"
                  : requestKind === "mcp-elicitation"
                    ? "App access approval requested"
                    : "Approval requested",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.detail ? { detail: event.payload.detail } : {}),
            ...(event.payload.appName ? { appName: event.payload.appName } : {}),
            ...(event.payload.options ? { options: event.payload.options } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "request.resolved": {
      if (event.payload.requestType === "tool_user_input") {
        return [];
      }
      const requestKind = requestKindFromCanonicalRequestType(event.payload.requestType);
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "approval",
          kind: "approval.resolved",
          summary: "Approval resolved",
          payload: {
            requestId: toApprovalRequestId(event.requestId),
            ...(requestKind ? { requestKind } : {}),
            requestType: event.payload.requestType,
            ...(event.payload.decision ? { decision: event.payload.decision } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.error": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "runtime.error",
          summary: "Runtime error",
          payload: {
            message: truncateDetail(event.payload.message),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.denied": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "error",
          kind: "tool.denied",
          summary: `Tool denied: ${event.payload.toolName}`,
          payload: {
            toolName: event.payload.toolName,
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.reason ? { detail: truncateDetail(event.payload.reason) } : {}),
            ...(event.payload.agentId ? { agentId: event.payload.agentId } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "runtime.warning": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "runtime.warning",
          // Use the adapter-supplied message as the row label so the work log
          // shows what the warning was about, not a generic "Runtime warning".
          summary: truncateDetail(event.payload.message, 120),
          payload: {
            message: truncateDetail(event.payload.message),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "turn.plan.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "turn.plan.updated",
          summary: "Plan updated",
          payload: {
            plan: event.payload.plan,
            ...(event.payload.explanation !== undefined
              ? { explanation: event.payload.explanation }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.requested": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.requested",
          summary: "User input requested",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            questions: event.payload.questions,
            ...(event.payload.responseMode ? { responseMode: event.payload.responseMode } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "user-input.resolved": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "user-input.resolved",
          summary: "User input submitted",
          payload: {
            ...(event.requestId ? { requestId: event.requestId } : {}),
            answers: event.payload.answers,
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.started": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "task.started",
          summary:
            event.payload.taskType === "plan"
              ? "Plan task started"
              : event.payload.taskType
                ? `${event.payload.taskType} task started`
                : "Task started",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.taskType ? { taskType: event.payload.taskType } : {}),
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.progress": {
      const linkage = taskLinkageActivityFields(event.payload as Record<string, unknown>);
      // Usage and activity are independent latest-state streams. Keeping them
      // under separate stable ids prevents a command/reasoning update from
      // replacing the last known token count (and prevents a usage-only tick
      // from blanking the last meaningful activity).
      const identityLinkage = { ...linkage };
      delete identityLinkage.typedUsage;
      delete identityLinkage.status;
      delete identityLinkage.error;
      const title =
        event.payload.description.trim().length > 0
          ? { title: truncateDetail(event.payload.description, 120) }
          : {};
      const hasProgressState =
        event.payload.typedUsage === undefined ||
        event.payload.summary !== undefined ||
        event.payload.lastToolName !== undefined ||
        event.payload.status !== undefined ||
        event.payload.error !== undefined;
      return [
        ...(hasProgressState
          ? [
              {
                // Stable per-task id: activity is "latest state", not
                // history, so each meaningful tick replaces the last. This
                // bounds a large fleet to one activity row per task.
                id: EventId.make(`task-progress:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary:
                  event.payload.description.trim().length > 0
                    ? truncateDetail(event.payload.description, 120)
                    : "Reasoning update",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  detail: truncateDetail(event.payload.summary ?? event.payload.description),
                  ...(event.payload.summary
                    ? { summary: truncateDetail(event.payload.summary) }
                    : {}),
                  ...(event.payload.lastToolName
                    ? { lastToolName: event.payload.lastToolName }
                    : {}),
                  ...(event.payload.status ? { status: event.payload.status } : {}),
                  ...(event.payload.error ? { error: event.payload.error } : {}),
                  ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
                  ...identityLinkage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
        ...(event.payload.typedUsage !== undefined
          ? [
              {
                id: EventId.make(`task-usage:${event.threadId}:${event.payload.taskId}`),
                createdAt: event.createdAt,
                tone: "info" as const,
                kind: "task.progress" as const,
                summary: "Task usage updated",
                payload: {
                  taskId: event.payload.taskId,
                  ...title,
                  ...identityLinkage,
                  usageSnapshot: true,
                  typedUsage: event.payload.typedUsage,
                },
                turnId: toTurnId(event.turnId) ?? null,
                ...maybeSequence,
              },
            ]
          : []),
      ];
    }

    case "task.updated": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.updated",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status
                ? `Task ${event.payload.status}`
                : "Task updated",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.description
              ? { detail: truncateDetail(event.payload.description) }
              : {}),
            ...(event.payload.endedAt ? { endedAt: event.payload.endedAt } : {}),
            ...(event.payload.isBackgrounded !== undefined
              ? { isBackgrounded: event.payload.isBackgrounded }
              : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "tool.progress": {
      // Only agent-owned heartbeats are persisted: they feed the owning
      // agent's activity line. Parent-conversation tool progress stays
      // ephemeral (item lifecycle already covers it).
      if (event.payload.taskId === undefined) {
        return [];
      }
      return [
        {
          // Same stable-id treatment as task.progress: a heartbeat is
          // "what is this agent doing right now", so one row per task
          // (thread-scoped for the same global-PK collision reason).
          id: EventId.make(`tool-progress:${event.threadId}:${event.payload.taskId}`),
          createdAt: event.createdAt,
          tone: "info",
          kind: "tool.progress",
          summary: event.payload.toolName ?? "Tool progress",
          payload: {
            taskId: event.payload.taskId,
            ...(event.payload.toolName ? { toolName: event.payload.toolName } : {}),
            ...(event.payload.toolUseId ? { toolUseId: event.payload.toolUseId } : {}),
            ...(event.payload.elapsedSeconds !== undefined
              ? { elapsedSeconds: event.payload.elapsedSeconds }
              : {}),
            ...(event.payload.parentToolUseId
              ? { parentToolUseId: event.payload.parentToolUseId }
              : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "task.completed": {
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: event.payload.status === "failed" ? "error" : "info",
          kind: "task.completed",
          summary:
            event.payload.status === "failed"
              ? "Task failed"
              : event.payload.status === "stopped"
                ? "Task stopped"
                : "Task completed",
          payload: {
            taskId: event.payload.taskId,
            status: event.payload.status,
            ...(taskTitle ? { title: truncateDetail(taskTitle, 120) } : {}),
            // summary + detail mirror task.progress: clients label the row from
            // summary and keep detail for the preview/expanded body.
            ...(event.payload.summary
              ? {
                  summary: truncateDetail(event.payload.summary),
                  detail: truncateDetail(event.payload.summary),
                }
              : {}),
            ...(event.payload.usage !== undefined ? { usage: event.payload.usage } : {}),
            ...taskLinkageActivityFields(event.payload as Record<string, unknown>),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.state.changed": {
      if (event.payload.state !== "compacted") {
        return [];
      }

      const beforeTokens = event.payload.beforeTokens;
      const afterTokens = event.payload.afterTokens;
      const summary =
        beforeTokens !== undefined && afterTokens !== undefined
          ? `Compacted context ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`
          : "Context compacted";
      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-compaction",
          summary,
          payload: {
            state: event.payload.state,
            ...(beforeTokens !== undefined ? { beforeTokens } : {}),
            ...(afterTokens !== undefined ? { afterTokens } : {}),
            ...(event.requestId !== undefined ? { requestId: event.requestId } : {}),
            ...(event.payload.detail !== undefined ? { detail: event.payload.detail } : {}),
          },
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "thread.token-usage.updated": {
      const payload = buildContextWindowActivityPayload(event);
      if (!payload) {
        return [];
      }

      return [
        {
          id: event.eventId,
          createdAt: event.createdAt,
          tone: "info",
          kind: "context-window.updated",
          summary: "Context window updated",
          payload,
          turnId: toTurnId(event.turnId) ?? null,
          ...maybeSequence,
        },
      ];
    }

    case "item.updated":
    case "item.completed":
    case "item.started": {
      if (event.payload.itemType === "reasoning") {
        const activity = reasoningLifecycleActivity(event);
        return activity === undefined ? [] : [activity];
      }
      if (!isToolLifecycleItemType(event.payload.itemType)) return [];
      const activity = toolLifecycleActivity(event);
      return [event.type === "item.updated" ? projectActivityPayload(activity) : activity];
    }

    default:
      break;
  }

  return [];
}

/** Keep every event source on the same runtime-event → activity path. */
export function runtimeEventsToActivities(
  events: ReadonlyArray<ProviderRuntimeEvent>,
  taskTitle?: string,
): ReadonlyArray<OrchestrationThreadActivity> {
  return events.flatMap((event) => runtimeEventToActivities(event, taskTitle));
}

function buildContextWindowActivityPayload(
  event: ProviderRuntimeEvent,
): ThreadTokenUsageSnapshot | undefined {
  if (event.type !== "thread.token-usage.updated" || event.payload.usage.usedTokens < 0) {
    return undefined;
  }
  return event.payload.usage;
}
