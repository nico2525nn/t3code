// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads the canonical, append-only Codex rollout when the App Server's
 * paginated history projection is behind it.
 *
 * The rollout contains two representations of a turn. `response_item` is the
 * model request envelope and includes hidden context messages; the durable
 * `event_msg.item_completed` records are the user-visible Codex items exposed
 * by `thread/read`. Only the latter are recovered here. This keeps the
 * compatibility projection aligned with Codex instead of importing prompts,
 * environment blocks, or tool internals that the native App Server omits.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import * as CodexSchema from "effect-codex-app-server/schema";

type RecordValue = Record<string, unknown>;
type ThreadItem = CodexSchema.V2ThreadReadResponse__ThreadItem;
type Turn = CodexSchema.V2ThreadReadResponse__Turn;

interface MutableTurn {
  readonly id: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  status: "completed" | "interrupted" | "failed" | "inProgress";
  error?: { readonly message: string };
  readonly items: Map<string, ThreadItem>;
}

function asRecord(value: unknown): RecordValue | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function unixSeconds(value: unknown): number | undefined {
  const timestamp = asString(value);
  if (timestamp === undefined) {
    return undefined;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : undefined;
}

function isoTimestamp(value: unknown): string | undefined {
  const timestamp = asString(value);
  if (timestamp === undefined || !Number.isFinite(Date.parse(timestamp))) {
    return undefined;
  }
  return timestamp;
}

function stringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.flatMap((entry) => (typeof entry === "string" ? [entry] : []))
    : [];
}

function stripFileUri(value: unknown): string | undefined {
  const text = asString(value);
  if (text === undefined) {
    return undefined;
  }
  if (text.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(text).pathname);
    } catch {
      return text.slice("file://".length);
    }
  }
  return text;
}

function durationMilliseconds(value: unknown): number | undefined {
  const duration = asRecord(value);
  if (duration === undefined) {
    return undefined;
  }
  const seconds = asNumber(duration.secs) ?? asNumber(duration.seconds);
  const nanos = asNumber(duration.nanos) ?? asNumber(duration.nanoseconds) ?? 0;
  if (seconds === undefined || seconds < 0 || nanos < 0) {
    return undefined;
  }
  const milliseconds = Math.round(seconds * 1000 + nanos / 1_000_000);
  return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

function commandText(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value.flatMap((entry) => (typeof entry === "string" ? [entry] : []));
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function commandPath(value: unknown, cwd: string): string | undefined {
  const path = stripFileUri(value);
  if (path === undefined) {
    return undefined;
  }
  return path.startsWith("/") ? path : NodePath.resolve(cwd, path);
}

function mapCommandAction(value: unknown, cwd: string): RecordValue {
  const action = asRecord(value) ?? {};
  const type = asString(action.type);
  const command = commandText(action.command) ?? commandText(action.cmd) ?? "";
  switch (type) {
    case "read":
      return {
        type: "read",
        command,
        name: asString(action.name) ?? "",
        path: commandPath(action.path, cwd) ?? cwd,
      };
    case "list_files":
    case "listFiles":
      return {
        type: "listFiles",
        command,
        ...(commandPath(action.path, cwd) ? { path: commandPath(action.path, cwd) } : {}),
      };
    case "search":
      return {
        type: "search",
        command,
        ...(asString(action.query) ? { query: action.query } : {}),
        ...(commandPath(action.path, cwd) ? { path: commandPath(action.path, cwd) } : {}),
      };
    default:
      return { type: "unknown", command };
  }
}

function commandStatus(value: unknown): "inProgress" | "completed" | "failed" | "declined" {
  switch (asString(value)) {
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return "completed";
  }
}

function commandSource(
  value: unknown,
): "agent" | "userShell" | "unifiedExecStartup" | "unifiedExecInteraction" | undefined {
  switch (asString(value)) {
    case "agent":
      return "agent";
    case "userShell":
    case "user_shell":
      return "userShell";
    case "unifiedExecStartup":
    case "unified_exec_startup":
      return "unifiedExecStartup";
    case "unifiedExecInteraction":
    case "unified_exec_interaction":
      return "unifiedExecInteraction";
    default:
      return undefined;
  }
}

function dynamicStatus(value: unknown): "inProgress" | "completed" | "failed" {
  switch (asString(value)) {
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

function withRolloutTimestamp(item: ThreadItem, timestamp: unknown): ThreadItem {
  const createdAt = isoTimestamp(timestamp);
  return createdAt === undefined
    ? item
    : ({ ...item, __codexRolloutCompletedAt: createdAt } as unknown as ThreadItem);
}

function itemTurnId(payload: RecordValue): string | undefined {
  return asString(payload.turn_id) ?? asString(payload.turnId);
}

function itemId(item: RecordValue): string | undefined {
  return asString(item.id);
}

function textContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }
  return value
    .map((entry) => asRecord(entry))
    .flatMap((entry) => (entry === undefined ? [] : [asString(entry.text) ?? ""]))
    .filter((text) => text.length > 0)
    .join("\n")
    .trim();
}

function userContent(value: unknown): ReadonlyArray<RecordValue> {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((entry) => {
    const block = asRecord(entry);
    if (block === undefined) {
      return [];
    }
    const type = asString(block.type);
    if (type === "text") {
      return [
        {
          type: "text",
          text: asString(block.text) ?? "",
          ...(Array.isArray(block.text_elements) ? { text_elements: block.text_elements } : {}),
        },
      ];
    }
    if (
      type === "image" ||
      type === "localImage" ||
      type === "audio" ||
      type === "localAudio" ||
      type === "skill" ||
      type === "mention"
    ) {
      return [block];
    }
    return [];
  });
}

function patchChangeKind(value: unknown): RecordValue {
  const change = asRecord(value);
  const type = asString(change?.type);
  if (type === "add" || type === "delete") {
    return { type };
  }
  const movePath = asString(change?.move_path);
  return { type: "update", ...(movePath ? { move_path: movePath } : {}) };
}

function patchStatus(value: unknown): "inProgress" | "completed" | "failed" | "declined" {
  switch (asString(value)) {
    case "inProgress":
      return "inProgress";
    case "failed":
      return "failed";
    case "declined":
      return "declined";
    default:
      return "completed";
  }
}

function mapFileChange(item: RecordValue): ThreadItem | undefined {
  const id = itemId(item);
  const changes = asRecord(item.changes);
  if (id === undefined || changes === undefined) {
    return undefined;
  }

  return {
    type: "fileChange",
    id,
    status: patchStatus(item.status),
    changes: Object.entries(changes).flatMap(([path, rawChange]) => {
      const change = asRecord(rawChange);
      const diff = asString(change?.unified_diff) ?? asString(change?.diff) ?? "";
      return [
        {
          path,
          diff,
          kind: patchChangeKind(rawChange),
        },
      ];
    }),
  } as unknown as ThreadItem;
}

function collabTool(
  value: unknown,
):
  | "spawnAgent"
  | "sendInput"
  | "resumeAgent"
  | "wait"
  | "closeAgent"
  | "sendMessage"
  | "followupTask"
  | "interruptAgent"
  | "listAgents" {
  switch (asString(value)) {
    case "spawn_agent":
      return "spawnAgent";
    case "send_input":
      return "sendInput";
    case "resume_agent":
      return "resumeAgent";
    case "close_agent":
      return "closeAgent";
    case "send_message":
      return "sendMessage";
    case "followup_task":
      return "followupTask";
    case "interrupt_agent":
      return "interruptAgent";
    case "list_agents":
      return "listAgents";
    case "wait":
      return "wait";
    default:
      return "wait";
  }
}

function collabStatus(value: unknown): "inProgress" | "completed" | "failed" | "interrupted" {
  switch (asString(value)) {
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "failed":
    case "errored":
      return "failed";
    case "interrupted":
      return "interrupted";
    default:
      return "completed";
  }
}

function collabAgentStatus(
  value: unknown,
): "pendingInit" | "running" | "interrupted" | "completed" | "errored" | "shutdown" | "notFound" {
  switch (asString(value)) {
    case "pendingInit":
    case "pending_init":
    case "pending":
      return "pendingInit";
    case "running":
    case "inProgress":
    case "in_progress":
      return "running";
    case "interrupted":
      return "interrupted";
    case "errored":
    case "failed":
      return "errored";
    case "shutdown":
      return "shutdown";
    case "notFound":
    case "not_found":
      return "notFound";
    default:
      return "completed";
  }
}

function collabAgentStates(value: unknown): Record<string, RecordValue> {
  const states = asRecord(value);
  if (states === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(states).flatMap(([agentId, rawState]) => {
      const state = asRecord(rawState);
      if (state === undefined) {
        return [[agentId, { status: collabAgentStatus(rawState) }]];
      }
      return [
        [
          agentId,
          {
            status: collabAgentStatus(state.status ?? state.state),
            ...(asString(state.message) ? { message: state.message } : {}),
          },
        ],
      ];
    }),
  );
}

function mapCollabAgentToolCall(item: RecordValue): ThreadItem | undefined {
  const id = itemId(item);
  const senderThreadId = asString(item.sender_thread_id);
  const receiverThreadIds = Array.isArray(item.receiver_thread_ids)
    ? item.receiver_thread_ids.flatMap((value) => {
        const id = asString(value);
        return id === undefined ? [] : [id];
      })
    : [];
  if (id === undefined || senderThreadId === undefined) {
    return undefined;
  }

  const receiverAgents = Array.isArray(item.receiver_agents)
    ? item.receiver_agents.flatMap((value) => {
        const agent = asRecord(value);
        const threadId = asString(agent?.thread_id ?? agent?.threadId);
        if (threadId === undefined) {
          return [];
        }
        return [
          {
            threadId,
            ...(asString(agent?.agent_nickname ?? agent?.agentNickname)
              ? { agentNickname: asString(agent?.agent_nickname ?? agent?.agentNickname) }
              : {}),
          },
        ];
      })
    : [];

  return {
    type: "collabAgentToolCall",
    id,
    tool: collabTool(item.tool),
    status: collabStatus(item.status),
    senderThreadId,
    receiverThreadIds,
    agentsStates: collabAgentStates(item.agents_states),
    ...(receiverAgents.length > 0 ? { receiverAgents } : {}),
    ...(asString(item.prompt) ? { prompt: item.prompt } : {}),
    ...(asString(item.model) ? { model: item.model } : {}),
    ...(asString(item.reasoning_effort) ? { reasoningEffort: item.reasoning_effort } : {}),
  } as unknown as ThreadItem;
}

function mcpStatus(value: unknown): "inProgress" | "completed" | "failed" {
  switch (asString(value)) {
    case "inProgress":
    case "in_progress":
      return "inProgress";
    case "failed":
      return "failed";
    default:
      return "completed";
  }
}

function mapMcpToolCall(item: RecordValue): ThreadItem | undefined {
  const id = itemId(item);
  const server = asString(item.server);
  const tool = asString(item.tool);
  if (id === undefined || server === undefined || tool === undefined) {
    return undefined;
  }
  const appContext = asRecord(item.app_context ?? item.appContext);
  const normalizedAppContext =
    appContext !== undefined && asString(appContext.connector_id ?? appContext.connectorId)
      ? {
          connectorId: asString(appContext.connector_id ?? appContext.connectorId)!,
          ...(asString(appContext.action_name ?? appContext.actionName)
            ? { actionName: asString(appContext.action_name ?? appContext.actionName) }
            : {}),
          ...(asString(appContext.app_name ?? appContext.appName)
            ? { appName: asString(appContext.app_name ?? appContext.appName) }
            : {}),
          ...(asString(appContext.link_id ?? appContext.linkId)
            ? { linkId: asString(appContext.link_id ?? appContext.linkId) }
            : {}),
          ...(asString(appContext.resource_uri ?? appContext.resourceUri)
            ? { resourceUri: asString(appContext.resource_uri ?? appContext.resourceUri) }
            : {}),
        }
      : undefined;
  return {
    type: "mcpToolCall",
    id,
    server,
    tool,
    arguments: item.arguments ?? {},
    status: mcpStatus(item.status),
    ...(durationMilliseconds(item.duration) === undefined
      ? {}
      : { durationMs: durationMilliseconds(item.duration) }),
    ...(item.result !== undefined ? { result: item.result } : {}),
    ...(item.error !== undefined ? { error: item.error } : {}),
    ...(normalizedAppContext !== undefined ? { appContext: normalizedAppContext } : {}),
    ...(asString(item.plugin_id ?? item.pluginId)
      ? { pluginId: asString(item.plugin_id ?? item.pluginId) }
      : {}),
    ...(asString(item.mcp_app_resource_uri ?? item.mcpAppResourceUri)
      ? { mcpAppResourceUri: asString(item.mcp_app_resource_uri ?? item.mcpAppResourceUri) }
      : {}),
  } as unknown as ThreadItem;
}

function mapHookPrompt(item: RecordValue): ThreadItem | undefined {
  const id = itemId(item);
  if (id === undefined || !Array.isArray(item.fragments)) {
    return undefined;
  }
  const fragments = item.fragments.flatMap((value) => {
    const fragment = asRecord(value);
    const hookRunId = asString(fragment?.hook_run_id ?? fragment?.hookRunId);
    const text = typeof fragment?.text === "string" ? fragment.text : undefined;
    return hookRunId !== undefined && text !== undefined ? [{ hookRunId, text }] : [];
  });
  return { type: "hookPrompt", id, fragments } as unknown as ThreadItem;
}

function mapCommandExecution(item: RecordValue): ThreadItem | undefined {
  const id = itemId(item);
  const cwd = stripFileUri(item.cwd) ?? "/";
  const command = commandText(item.command);
  if (id === undefined || command === undefined) {
    return undefined;
  }
  const aggregatedOutput =
    asString(item.aggregated_output) ??
    ([asString(item.stdout), asString(item.stderr)].filter(Boolean).join("\n") || undefined);
  const processId = asString(item.process_id);
  const source = commandSource(item.source);
  const exitCode = asNumber(item.exit_code);
  const durationMs = durationMilliseconds(item.duration);
  return {
    type: "commandExecution",
    id,
    command,
    cwd,
    commandActions: Array.isArray(item.parsed_cmd)
      ? item.parsed_cmd.map((action) => mapCommandAction(action, cwd))
      : [],
    status: commandStatus(item.status),
    ...(processId ? { processId } : {}),
    ...(source ? { source } : {}),
    ...(aggregatedOutput ? { aggregatedOutput } : {}),
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(durationMs === undefined ? {} : { durationMs }),
  } as unknown as ThreadItem;
}

function mapDynamicToolCall(item: RecordValue): ThreadItem | undefined {
  const id = itemId(item);
  const tool = asString(item.tool);
  if (id === undefined || tool === undefined) {
    return undefined;
  }
  return {
    type: "dynamicToolCall",
    id,
    tool,
    arguments: item.arguments ?? {},
    status: dynamicStatus(item.status),
    ...(asString(item.namespace) ? { namespace: item.namespace } : {}),
    ...(Array.isArray(item.content_items) ? { contentItems: item.content_items } : {}),
    ...(typeof item.success === "boolean" ? { success: item.success } : {}),
    ...(durationMilliseconds(item.duration) === undefined
      ? {}
      : { durationMs: durationMilliseconds(item.duration) }),
  } as ThreadItem;
}

function mapWebSearch(item: RecordValue): ThreadItem | undefined {
  const id = itemId(item);
  const action = asRecord(item.action);
  const query =
    (typeof item.query === "string" ? item.query : undefined) ??
    (typeof action?.query === "string" ? action.query : undefined) ??
    (stringArray(action?.queries).length > 0 ? stringArray(action?.queries).join("\n") : "");
  if (id === undefined) {
    return undefined;
  }
  return {
    type: "webSearch",
    id,
    query,
    ...(item.action === undefined ? {} : { action: item.action }),
    ...(Array.isArray(item.results) ? { results: item.results } : {}),
  } as ThreadItem;
}

function mapExtension(item: RecordValue): ThreadItem | undefined {
  return asString(item.kind) === "web.search" ? mapWebSearch(item) : undefined;
}

function mapCanonicalItem(value: unknown, timestamp?: unknown): ThreadItem | undefined {
  const item = asRecord(value);
  const type = asString(item?.type);
  if (item === undefined || type === undefined) {
    return undefined;
  }

  const id = itemId(item);
  if (id === undefined) {
    return undefined;
  }

  const mapped = (() => {
    switch (type) {
      case "HookPrompt":
        return mapHookPrompt(item);
      case "UserMessage": {
        const content = userContent(item.content);
        return content.length > 0
          ? ({
              type: "userMessage",
              id,
              content,
              ...(asString(item.client_id ?? item.clientId)
                ? { clientId: asString(item.client_id ?? item.clientId) }
                : {}),
            } as unknown as ThreadItem)
          : undefined;
      }
      case "AgentMessage": {
        const text = textContent(item.content);
        return text.length > 0
          ? ({
              type: "agentMessage",
              id,
              text,
              ...(asString(item.phase) === "commentary" || asString(item.phase) === "final_answer"
                ? { phase: item.phase }
                : {}),
              ...(asString(item.delivery) === "async" ? { delivery: "async" } : {}),
              ...(Array.isArray(item.questions) ? { questions: item.questions } : {}),
              ...(item.memory_citation !== undefined || item.memoryCitation !== undefined
                ? {
                    memoryCitation: item.memory_citation ?? item.memoryCitation,
                  }
                : {}),
            } as unknown as ThreadItem)
          : undefined;
      }
      case "Reasoning": {
        const summary = stringArray(item.summary_text);
        const content = stringArray(item.raw_content);
        return {
          type: "reasoning",
          id,
          ...(summary.length > 0 ? { summary } : {}),
          ...(content.length > 0 ? { content } : {}),
        } as ThreadItem;
      }
      case "FileChange":
        return mapFileChange(item);
      case "CollabAgentToolCall":
        return mapCollabAgentToolCall(item);
      case "McpToolCall":
        return mapMcpToolCall(item);
      case "CommandExecution":
        return mapCommandExecution(item);
      case "DynamicToolCall":
        return mapDynamicToolCall(item);
      case "WebSearch":
        return mapWebSearch(item);
      case "Extension":
        return mapExtension(item);
      case "Plan": {
        const text = asString(item.text);
        return text === undefined
          ? undefined
          : ({ type: "plan", id, text } as unknown as ThreadItem);
      }
      case "SubAgentActivity": {
        const agentPath = asString(item.agent_path);
        const agentThreadId = asString(item.agent_thread_id);
        const kind = asString(item.kind);
        return agentPath &&
          agentThreadId &&
          (kind === "started" ||
            kind === "interacted" ||
            kind === "interrupted" ||
            kind === "completed")
          ? ({
              type: "subAgentActivity",
              id,
              agentPath,
              agentThreadId,
              kind,
            } as unknown as ThreadItem)
          : undefined;
      }
      case "ImageView": {
        const path = asString(item.path);
        return path === undefined
          ? undefined
          : ({ type: "imageView", id, path } as unknown as ThreadItem);
      }
      case "Sleep": {
        const durationMs = asNumber(item.duration_ms);
        return durationMs === undefined
          ? undefined
          : ({ type: "sleep", id, durationMs } as unknown as ThreadItem);
      }
      case "ImageGeneration": {
        const result = asString(item.result);
        const status = asString(item.status);
        return result === undefined || status === undefined
          ? undefined
          : ({
              type: "imageGeneration",
              id,
              result,
              status,
              ...(asString(item.revised_prompt) ? { revisedPrompt: item.revised_prompt } : {}),
              ...(asString(item.saved_path) ? { savedPath: item.saved_path } : {}),
            } as unknown as ThreadItem);
      }
      case "EnteredReviewMode":
        return asString(item.review)
          ? ({ type: "enteredReviewMode", id, review: item.review } as unknown as ThreadItem)
          : undefined;
      case "ExitedReviewMode":
        return asString(item.review)
          ? ({ type: "exitedReviewMode", id, review: item.review } as unknown as ThreadItem)
          : undefined;
      case "ContextCompaction":
        return { type: "contextCompaction", id } as unknown as ThreadItem;
      default:
        return undefined;
    }
  })();
  return mapped === undefined
    ? undefined
    : withRolloutTimestamp(mapped as unknown as ThreadItem, timestamp);
}

function getOrCreateTurn(
  turns: Map<string, MutableTurn>,
  turnId: string,
  timestamp: unknown,
): MutableTurn {
  const existing = turns.get(turnId);
  if (existing !== undefined) {
    return existing;
  }
  const created: MutableTurn = {
    id: turnId,
    status: "inProgress",
    items: new Map(),
  };
  const startedAt = unixSeconds(timestamp);
  if (startedAt !== undefined) {
    created.startedAt = startedAt;
  }
  turns.set(turnId, created);
  return created;
}

function finishTurn(turn: MutableTurn, payload: RecordValue, status: MutableTurn["status"]): void {
  turn.status = status;
  const completedAt = asNumber(payload.completed_at) ?? asNumber(payload.completedAt);
  if (completedAt !== undefined) {
    turn.completedAt = completedAt;
  }
  const durationMs = asNumber(payload.duration_ms) ?? asNumber(payload.durationMs);
  if (durationMs !== undefined) {
    turn.durationMs = durationMs;
  }
  const error = asRecord(payload.error);
  const message = asString(error?.message);
  if (message !== undefined) {
    turn.error = { message };
  }
}

function toTurn(turn: MutableTurn): Turn {
  return {
    id: turn.id,
    items: [...turn.items.values()],
    itemsView: "full",
    status: turn.status,
    ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    ...(turn.completedAt === undefined ? {} : { completedAt: turn.completedAt }),
    ...(turn.durationMs === undefined ? {} : { durationMs: turn.durationMs }),
    ...(turn.error === undefined ? {} : { error: turn.error }),
  };
}

/** Read Codex's visible item-completion history from one rollout JSONL file. */
export async function readCodexRolloutTurns(path: string): Promise<ReadonlyArray<Turn>> {
  const turns = new Map<string, MutableTurn>();
  const input = NodeFS.createReadStream(path, { encoding: "utf8" });
  const lines = NodeReadline.createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const line of lines) {
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const rawRecord = asRecord(record);
      if (rawRecord?.type !== "event_msg") {
        continue;
      }
      const payload = asRecord(rawRecord.payload);
      const payloadType = asString(payload?.type);
      if (payload === undefined || payloadType === undefined) {
        continue;
      }
      const turnId = itemTurnId(payload);
      if (turnId === undefined) {
        continue;
      }
      const turn = getOrCreateTurn(turns, turnId, rawRecord.timestamp);

      if (payloadType === "task_started") {
        const startedAt = asNumber(payload.started_at);
        if (startedAt !== undefined) {
          turn.startedAt = startedAt;
        }
        turn.status = "inProgress";
        continue;
      }
      if (payloadType === "task_complete") {
        finishTurn(
          turn,
          payload,
          payload.error === undefined || payload.error === null ? "completed" : "failed",
        );
        continue;
      }
      if (payloadType === "turn_aborted") {
        finishTurn(turn, payload, "interrupted");
        continue;
      }
      if (payloadType !== "item_completed") {
        continue;
      }

      const item = mapCanonicalItem(payload.item, rawRecord.timestamp);
      const id = item === undefined ? undefined : asString((item as RecordValue).id);
      if (item !== undefined && id !== undefined) {
        turn.items.set(id, item);
      }
    }
  } finally {
    lines.close();
    input.destroy();
  }

  return [...turns.values()]
    .map(toTurn)
    .toSorted(
      (left, right) =>
        (left.startedAt ?? Number.MAX_SAFE_INTEGER) -
          (right.startedAt ?? Number.MAX_SAFE_INTEGER) || left.id.localeCompare(right.id),
    );
}
