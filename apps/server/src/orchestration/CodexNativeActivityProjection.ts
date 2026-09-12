import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

type RecordValue = Record<string, unknown>;

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function itemForActivity(activity: OrchestrationThreadActivity): RecordValue | undefined {
  const payload = asRecord(activity.payload);
  if (payload?.itemType !== "collab_agent_tool_call") {
    return undefined;
  }
  const data = asRecord(payload.data);
  const item = asRecord(data?.item);
  if (item?.type === "collabAgentToolCall" || item?.type === "subAgentActivity") {
    return item;
  }
  if (data?.type === "collabAgentToolCall" || data?.type === "subAgentActivity") {
    return data;
  }
  return undefined;
}

function agentIds(item: RecordValue): ReadonlyArray<string> {
  const ids = new Set<string>();
  const directId = asString(item.agentThreadId);
  if (directId) ids.add(directId);

  if (Array.isArray(item.receiverThreadIds)) {
    for (const value of item.receiverThreadIds) {
      const id = asString(value);
      if (id) ids.add(id);
    }
  }

  if (Array.isArray(item.receiverAgents)) {
    for (const value of item.receiverAgents) {
      const receiver = asRecord(value);
      const id = asString(receiver?.threadId ?? receiver?.agentThreadId);
      if (id) ids.add(id);
    }
  }

  const states = asRecord(item.agentsStates);
  if (states) {
    for (const id of Object.keys(states)) {
      if (id.trim().length > 0) ids.add(id);
    }
  }
  return [...ids];
}

function receiverAgentFor(item: RecordValue, agentId: string): RecordValue | undefined {
  if (!Array.isArray(item.receiverAgents)) {
    return undefined;
  }
  return item.receiverAgents
    .map(asRecord)
    .find((receiver) => asString(receiver?.threadId ?? receiver?.agentThreadId) === agentId);
}

function pathLeaf(value: unknown): string | undefined {
  const path = asString(value);
  return path?.split("/").findLast((part) => part.length > 0);
}

interface AgentMetadata {
  title?: string;
  role?: string;
  model?: string;
  effort?: string;
  agentPath?: string;
  parentAgentId?: string;
}

function mergeMetadata(
  current: AgentMetadata | undefined,
  item: RecordValue,
  state: RecordValue | undefined,
  agentId: string,
): AgentMetadata {
  const receiver = receiverAgentFor(item, agentId);
  const agentPath = asString(item.agentPath) ?? asString(state?.agentPath);
  const title =
    asString(item.agentNickname) ??
    asString(item.nickname) ??
    asString(state?.nickname) ??
    asString(receiver?.agentNickname) ??
    asString(receiver?.nickname);
  const role = asString(item.agentRole) ?? asString(item.role) ?? asString(state?.role);
  const model = asString(item.model) ?? asString(state?.model);
  const effort = asString(item.reasoningEffort) ?? asString(item.effort) ?? asString(state?.effort);
  const parentAgentId = asString(item.parentThreadId) ?? asString(state?.parentThreadId);
  const next: AgentMetadata = {};
  if (current?.title !== undefined) next.title = current.title;
  if (current?.role !== undefined) next.role = current.role;
  if (current?.model !== undefined) next.model = current.model;
  if (current?.effort !== undefined) next.effort = current.effort;
  if (current?.agentPath !== undefined) next.agentPath = current.agentPath;
  if (current?.parentAgentId !== undefined) next.parentAgentId = current.parentAgentId;
  if (title !== undefined) next.title = title;
  if (role !== undefined) next.role = role;
  if (model !== undefined) next.model = model;
  if (effort !== undefined) next.effort = effort;
  if (agentPath !== undefined) {
    next.agentPath = agentPath;
    const roleForPath = role ?? next.role ?? pathLeaf(agentPath);
    if (roleForPath !== undefined) next.role = roleForPath;
  }
  if (parentAgentId !== undefined) next.parentAgentId = parentAgentId;
  return next;
}

function stateForAgent(item: RecordValue, agentId: string): RecordValue | undefined {
  const states = asRecord(item.agentsStates);
  return asRecord(states?.[agentId]);
}

function titleForAgent(
  metadata: AgentMetadata | undefined,
  item: RecordValue,
  state: RecordValue | undefined,
  agentId: string,
): string {
  return (
    metadata?.title ??
    asString(item.agentNickname) ??
    asString(item.nickname) ??
    asString(state?.nickname) ??
    pathLeaf(item.agentPath) ??
    asString(item.prompt)?.split(/\r?\n/u)[0] ??
    agentId
  );
}

function normalizedStatus(
  value: unknown,
):
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | undefined {
  switch (asString(value)?.toLowerCase()) {
    case "pending":
    case "pendinginit":
    case "queued":
      return "pending";
    case "active":
    case "inprogress":
    case "running":
      return "running";
    case "waiting":
      return "waiting";
    case "idle":
      return "idle";
    case "completed":
    case "complete":
    case "done":
    case "succeeded":
      return "completed";
    case "failed":
    case "errored":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "stopped":
    case "interrupted":
    case "notfound":
      return "interrupted";
    default:
      return undefined;
  }
}

function taskPayload(
  agentId: string,
  metadata: AgentMetadata | undefined,
  item: RecordValue,
  state: RecordValue | undefined,
): RecordValue {
  const title = titleForAgent(metadata, item, state, agentId);
  return {
    taskId: agentId,
    taskType: "subagent",
    agentKind: "agent",
    title,
    description: title,
    ...((metadata?.role ?? pathLeaf(item.agentPath))
      ? { role: metadata?.role ?? pathLeaf(item.agentPath) }
      : {}),
    ...(metadata?.model ? { model: metadata.model } : {}),
    ...(metadata?.effort ? { effort: metadata.effort } : {}),
    ...(metadata?.agentPath ? { agentPath: metadata.agentPath } : {}),
    ...(metadata?.parentAgentId ? { parentAgentId: metadata.parentAgentId } : {}),
    timelineBypass: true,
  };
}

function makeActivity(
  source: OrchestrationThreadActivity,
  suffix: string,
  kind: "task.started" | "task.progress" | "task.updated" | "task.completed",
  payload: RecordValue,
  summary: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`codex-native:${String(source.id)}:${suffix}`),
    tone: kind === "task.completed" && payload.status === "failed" ? "error" : "info",
    kind,
    summary,
    payload,
    turnId: source.turnId,
    ...(source.sequence === undefined ? {} : { sequence: source.sequence }),
    createdAt: source.createdAt,
  };
}

function stateMessage(state: RecordValue | undefined): string | undefined {
  return asString(state?.message) ?? asString(state?.result) ?? asString(state?.error);
}

/**
 * Reconstruct the provider-neutral task lifecycle for old Codex histories.
 *
 * This is a read-time compatibility projection. It uses Codex's native child
 * thread IDs as task IDs and never creates, resumes, or owns a provider
 * session. Live task rows already produced by CodexAdapter win; only native
 * identities absent from those rows are synthesized.
 */
export function projectCodexNativeActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  const existingTaskIds = new Set<string>();
  for (const activity of activities) {
    const payload = asRecord(activity.payload);
    const taskId = asString(payload?.taskId);
    if (
      taskId &&
      (activity.kind === "task.started" ||
        activity.kind === "task.progress" ||
        activity.kind === "task.updated" ||
        activity.kind === "task.completed")
    ) {
      existingTaskIds.add(taskId);
    }
  }

  const metadataByAgent = new Map<string, AgentMetadata>();
  const seenNativeAgents = new Set<string>();
  const projected: OrchestrationThreadActivity[] = [];

  for (const activity of activities) {
    const item = itemForActivity(activity);
    if (!item) continue;
    const ids = agentIds(item);
    if (ids.length === 0) continue;
    const operation = asString(item.tool)?.toLowerCase();
    const activityKind = activity.kind;
    const nativeType = asString(item.type)?.toLowerCase();
    const nativeKind = asString(item.kind)?.toLowerCase();

    for (const agentId of ids) {
      if (existingTaskIds.has(agentId)) continue;

      const state = stateForAgent(item, agentId);
      const metadata = mergeMetadata(metadataByAgent.get(agentId), item, state, agentId);
      metadataByAgent.set(agentId, metadata);
      const basePayload = taskPayload(agentId, metadata, item, state);
      const known = seenNativeAgents.has(agentId);
      const status = normalizedStatus(state?.status ?? state?.state ?? item.status);
      const message = stateMessage(state);

      if (nativeType === "subagentactivity") {
        if (nativeKind === "started") {
          projected.push(
            makeActivity(
              activity,
              `started:${agentId}`,
              "task.started",
              basePayload,
              "Subagent started",
            ),
          );
          seenNativeAgents.add(agentId);
        } else if (status === "interrupted" || nativeKind === "interrupted") {
          projected.push(
            makeActivity(
              activity,
              `interrupted:${agentId}`,
              "task.updated",
              { ...basePayload, status: "interrupted" },
              "Task interrupted",
            ),
          );
        }
        continue;
      }

      if (!known && activityKind === "tool.started") {
        projected.push(
          makeActivity(
            activity,
            `started:${agentId}`,
            "task.started",
            basePayload,
            "Subagent started",
          ),
        );
        seenNativeAgents.add(agentId);
        continue;
      }

      if (operation === "closeagent") {
        projected.push(
          makeActivity(
            activity,
            `closed:${agentId}`,
            "task.updated",
            { ...basePayload, status: "interrupted" },
            "Task interrupted",
          ),
        );
        seenNativeAgents.add(agentId);
        continue;
      }

      if (status === "completed" || status === "failed" || status === "interrupted") {
        const completedStatus =
          status === "failed" ? "failed" : status === "interrupted" ? "stopped" : "completed";
        projected.push(
          makeActivity(
            activity,
            `completed:${agentId}`,
            "task.completed",
            {
              ...basePayload,
              status: completedStatus,
              ...(message ? { summary: message } : {}),
            },
            status === "failed" ? "Task failed" : "Task completed",
          ),
        );
        seenNativeAgents.add(agentId);
        continue;
      }

      if (status !== undefined || operation === "sendinput") {
        projected.push(
          makeActivity(
            activity,
            `updated:${agentId}`,
            "task.updated",
            {
              ...basePayload,
              ...(status ? { status } : { status: "running" }),
            },
            status ? `Task ${status}` : "Task updated",
          ),
        );
        seenNativeAgents.add(agentId);
        continue;
      }

      if (!known) {
        // A paged history may start at wait/sendInput rather than the spawn
        // item. Materialize the native identity so the official client still
        // shows the child instead of silently dropping it.
        projected.push(
          makeActivity(
            activity,
            `started:${agentId}`,
            "task.started",
            basePayload,
            "Subagent started",
          ),
        );
        seenNativeAgents.add(agentId);
      }

      if (message) {
        projected.push(
          makeActivity(
            activity,
            `progress:${agentId}`,
            "task.progress",
            { ...basePayload, summary: message },
            message,
          ),
        );
      }
    }
  }

  return projected;
}
