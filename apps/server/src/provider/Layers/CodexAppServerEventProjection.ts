/**
 * Pure Codex App Server projection boundary.
 *
 * Both live notifications and durable thread history are translated through
 * this module before they reach T3's existing runtime/read-model contracts.
 * The adapter owns transport and lifecycle; this module owns the protocol
 * vocabulary conversion. Keeping the conversion here prevents native history
 * and live delivery from growing separate compatibility rules.
 */
import {
  EventId,
  ProviderApprovalDecision,
  ProviderDriverKind,
  ProviderItemId,
  type CanonicalItemType,
  type CanonicalRequestType,
  type ProviderEvent,
  type ProviderRequestKind,
  type ProviderRuntimeEvent,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeItemStatus,
  type RuntimeTaskUsage,
  type ThreadTokenUsageSnapshot,
  ThreadId,
  TurnId,
  type ToolActivityIcon,
  type ToolActivityNativeAppReference,
  type ToolActivitySource,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { runtimeEventsToActivities } from "../../orchestration/ProviderRuntimeActivityProjection.ts";
import type { ProviderStoredThreadHistory } from "../Services/ProviderAdapter.ts";
import { describeMcpElicitation } from "./CodexSessionRuntime.ts";
import { codexRateLimitsToUpdate } from "./codexUsageLimits.ts";
import {
  codexAppServerThreadDiffs,
  codexAppServerThreadMessages,
  codexAppServerThreadSummary,
  codexAppServerThreadTurns,
  nativeHistoryItemRecord,
  nativeHistoryItemTimestamp,
  type CodexHistoryThread,
} from "./CodexAppServerHistoryProjection.ts";

const PROVIDER = ProviderDriverKind.make("codex");

type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

function codexNativeActivityId(
  turnId: string | undefined,
  itemId: string,
  lifecycle: string,
): string {
  return `codex:item:${turnId ?? "unknown"}:${itemId}:${lifecycle}`;
}

const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

export function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  const isPayload = Schema.is(schema);
  return isPayload(payload) ? payload : undefined;
}

function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

/** Read-side projection used only after the catalog has requested full history. */
export function codexAppServerThreadToStoredHistory(
  thread: EffectCodexSchema.V2ThreadReadResponse__Thread,
  archived: boolean,
): ProviderStoredThreadHistory {
  return {
    ...codexAppServerThreadSummary(thread, archived),
    turns: codexAppServerThreadTurns(thread),
    messages: codexAppServerThreadMessages(thread),
    turnDiffs: codexAppServerThreadDiffs(thread),
    runtimeEvents: codexAppServerThreadRuntimeEvents(thread),
  };
}
/**
 * The app-server schema has used both plain strings and typed text blocks for
 * reasoning summaries over time. Keep the conversion tolerant at this
 * history boundary: losing the typed `{ type: "summary_text", text }` blocks
 * makes an otherwise complete native history look as if it contained no
 * reasoning at all.
 */
function nativeReasoningText(value: unknown, depth = 0): ReadonlyArray<string> {
  if (depth > 4 || value === null || value === undefined) {
    return [];
  }
  if (typeof value === "string") {
    const text = value.trim();
    return text.length > 0 ? [text] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => nativeReasoningText(entry, depth + 1));
  }
  if (typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") {
    const text = record.text.trim();
    return text.length > 0 ? [text] : [];
  }

  // Be conservative about nested fields: reasoning content may contain
  // annotations/metadata that should not become user-visible work-log text.
  return ["text", "summary", "content"].flatMap((key) =>
    key in record ? nativeReasoningText(record[key], depth + 1) : [],
  );
}

type CodexNativeAgentMetadata = Readonly<{
  readonly nickname?: string;
  readonly role?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly agentPath?: string;
  readonly parentThreadId?: string;
}>;

type CodexNativeAgentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "interrupted";

const nativeAgentString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const firstNativeString = (...values: ReadonlyArray<unknown>): string | undefined =>
  values.map(nativeAgentString).find((value): value is string => value !== undefined);

function nativeAgentIds(item: Record<string, unknown>): ReadonlyArray<string> {
  const ids = new Set<string>();
  const add = (value: unknown) => {
    const id = nativeAgentString(value);
    if (id) ids.add(id);
  };
  add(item.agentThreadId);
  if (Array.isArray(item.receiverThreadIds)) item.receiverThreadIds.forEach(add);
  if (Array.isArray(item.receiverAgents)) {
    for (const receiver of item.receiverAgents) {
      const record = asUnknownRecord(receiver);
      add(record?.threadId ?? record?.agentThreadId);
    }
  }
  const states = asUnknownRecord(item.agentsStates);
  if (states) Object.keys(states).forEach(add);
  return [...ids];
}

function nativeAgentState(item: Record<string, unknown>, agentId: string): Record<string, unknown> {
  return asUnknownRecord(asUnknownRecord(item.agentsStates)?.[agentId]) ?? {};
}

function nativeAgentMetadata(
  previous: CodexNativeAgentMetadata | undefined,
  item: Record<string, unknown>,
  state: Record<string, unknown>,
  agentId: string,
): CodexNativeAgentMetadata {
  const receiver = (Array.isArray(item.receiverAgents) ? item.receiverAgents : [])
    .map(asUnknownRecord)
    .find((entry) => nativeAgentString(entry?.threadId ?? entry?.agentThreadId) === agentId);
  const prompt = nativeAgentString(item.prompt)?.split(/\r?\n/u)[0];
  const values = {
    nickname: firstNativeString(
      item.agentNickname,
      item.nickname,
      state.nickname,
      receiver?.agentNickname,
      receiver?.nickname,
      prompt,
    ),
    role: firstNativeString(item.agentRole, item.role, state.role),
    model: firstNativeString(item.model, state.model),
    effort: firstNativeString(item.reasoningEffort, item.effort, state.effort),
    agentPath: firstNativeString(item.agentPath, state.agentPath),
    parentThreadId: firstNativeString(item.parentThreadId, state.parentThreadId),
  };
  return {
    ...previous,
    ...Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
  } as CodexNativeAgentMetadata;
}

function nativeAgentStatus(value: unknown): CodexNativeAgentStatus | undefined {
  switch (nativeAgentString(value)?.toLowerCase()) {
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

function codexNativeAgentRuntimeEvents(
  canonicalThreadId: ThreadId,
  item: Record<string, unknown>,
  source: ProviderRuntimeEvent,
  metadataByAgent: Map<string, CodexNativeAgentMetadata>,
): ReadonlyArray<ProviderRuntimeEvent> {
  const result: ProviderRuntimeEvent[] = [];
  for (const agentId of nativeAgentIds(item)) {
    const state = nativeAgentState(item, agentId);
    const metadata = nativeAgentMetadata(metadataByAgent.get(agentId), item, state, agentId);
    metadataByAgent.set(agentId, metadata);
    const status = nativeAgentStatus(state.status ?? state.state ?? item.status);
    const message = firstNativeString(state.message, state.result, state.error, item.message);
    const operation = nativeAgentString(item.tool)?.toLowerCase();
    const activityKind = nativeAgentString(item.kind)?.toLowerCase();
    const terminal =
      activityKind === "completed" ||
      activityKind === "interrupted" ||
      status === "completed" ||
      status === "failed" ||
      status === "interrupted";
    const terminalMethod =
      operation === "closeagent" || activityKind === "interrupted"
        ? "collabAgent/closed"
        : terminal
          ? "collabAgent/turnCompleted"
          : status === "idle" || status === "waiting"
            ? "collabAgent/statusChanged"
            : message && status === undefined
              ? "collabAgent/item"
              : "collabAgent/turnStarted";
    const payload = {
      agentThreadId: agentId,
      ...metadata,
      ...(message ? { message } : {}),
    };
    const events: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["collabAgent/started", payload],
      [
        terminalMethod,
        terminalMethod === "collabAgent/turnCompleted"
          ? {
              ...payload,
              historyTerminal: true,
              turn: {
                status:
                  status === "failed"
                    ? "failed"
                    : status === "interrupted"
                      ? "interrupted"
                      : "completed",
              },
            }
          : terminalMethod === "collabAgent/statusChanged"
            ? {
                ...payload,
                status:
                  status === "waiting"
                    ? { type: "active", activeFlags: ["waitingOnUserInput"] }
                    : { type: "idle" },
              }
            : terminalMethod === "collabAgent/item"
              ? { ...payload, item: { type: "agentMessage", title: message } }
              : payload,
      ],
    ];
    for (const [index, [method, eventPayload]] of events.entries()) {
      const event: ProviderEvent = {
        id: EventId.make(`codex:agent-history:${source.eventId}:${agentId}:${index}`),
        kind: "notification",
        provider: PROVIDER,
        threadId: canonicalThreadId,
        createdAt: source.createdAt,
        ...(source.turnId ? { turnId: source.turnId } : {}),
        method,
        payload: eventPayload,
      };
      result.push(...mapCollabAgentEvent(event, canonicalThreadId));
    }
  }
  return result;
}

/**
 * Convert the complete native item stream into the activity vocabulary T3
 * already renders. Native child-thread identities are translated here too,
 * so history and live notifications share the same task ids.
 */
export function codexAppServerThreadRuntimeEvents(
  thread: CodexHistoryThread,
): ReadonlyArray<ProviderRuntimeEvent> {
  const events: ProviderRuntimeEvent[] = [];
  const metadataByAgent = new Map<string, CodexNativeAgentMetadata>();
  const canonicalThreadId = ThreadId.make(`codex:${thread.id}`);
  for (const turn of thread.turns) {
    const turnId = TurnId.make(turn.id);
    for (const [itemIndex, item] of turn.items.entries()) {
      const itemRecord = nativeHistoryItemRecord(item);
      const itemType =
        item.type === "subAgentActivity"
          ? "collab_agent_tool_call"
          : toCanonicalItemType(item.type);
      const itemLifecycle =
        "status" in item && item.status === "inProgress" ? "item.updated" : "item.completed";
      const createdAt = nativeHistoryItemTimestamp(turn, thread.updatedAt, itemIndex);
      const data = { item: itemRecord, threadId: thread.id, turnId: turn.id };
      const nativeEvent: ProviderEvent = {
        id: EventId.make(
          codexNativeActivityId(
            turn.id,
            item.id,
            itemLifecycle === "item.updated" ? "updated" : "completed",
          ),
        ),
        kind: "notification",
        provider: PROVIDER,
        threadId: canonicalThreadId,
        createdAt,
        turnId,
        itemId: ProviderItemId.make(item.id),
        method: itemLifecycle === "item.updated" ? "item/updated" : "item/completed",
        payload: data,
      };
      const projectedEvent = mapNativeItemLifecycle(
        nativeEvent,
        canonicalThreadId,
        item,
        itemLifecycle,
        data,
        itemType,
      );
      if (itemType === "context_compaction") {
        events.push(
          makeRuntimeEvent(
            nativeEvent,
            canonicalThreadId,
            "thread.state.changed",
            { state: "compacted", detail: data },
            {
              eventId: EventId.make(codexNativeActivityId(turn.id, item.id, "context-compaction")),
            },
          ),
        );
        continue;
      }
      if (projectedEvent === undefined) continue;
      if (item.type === "subAgentActivity" || itemType === "collab_agent_tool_call") {
        events.push(
          projectedEvent,
          ...codexNativeAgentRuntimeEvents(
            canonicalThreadId,
            itemRecord,
            projectedEvent,
            metadataByAgent,
          ),
        );
      } else {
        events.push(projectedEvent);
      }
    }
  }
  return [...new Map(events.map((event) => [event.eventId, event])).values()];
}

/** Compatibility helper for provider tests and callers that need T3 rows. */
export function codexAppServerThreadActivities(
  thread: CodexHistoryThread,
): ReturnType<typeof runtimeEventsToActivities> {
  return runtimeEventsToActivities(codexAppServerThreadRuntimeEvents(thread));
}

function asUnknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function normalizeMcpIntentTitle(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (!normalized) return undefined;
  const characters = Array.from(normalized);
  return characters.length <= 80 ? normalized : `${characters.slice(0, 79).join("")}…`;
}

function normalizedHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    const href = url.href;
    return (url.protocol === "http:" || url.protocol === "https:") && href.length <= 4096
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedImageUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "data:"
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedAppId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const appId = value.trim();
  return appId.length > 0 && appId.length <= 512 && /^[A-Za-z0-9._-]+$/u.test(appId)
    ? appId
    : undefined;
}

function normalizedDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const displayName = value.trim().replace(/\s+/gu, " ");
  return displayName && displayName.length <= 160 ? displayName : undefined;
}

function normalizedSourceKeyPart(value: string): string {
  return value.trim().toLowerCase();
}

function nativeAppSourceKey(appId: string): string {
  const key = `native-app:${appId.toLowerCase()}`;
  if (key.length <= 512) return key;
  const digest = NodeCrypto.createHash("sha256").update(key).digest("hex");
  return `${key.slice(0, 512 - digest.length - 1)}:${digest}`;
}

function browserDisplayName(value: unknown): string | undefined {
  const normalized = normalizedDisplayName(value)?.toLowerCase();
  if (!normalized) return undefined;
  if (normalized.includes("chrome") || normalized === "chromium") return "Chrome";
  if (normalized.includes("edge")) return "Microsoft Edge";
  if (normalized.includes("firefox")) return "Firefox";
  if (normalized.includes("safari")) return "Safari";
  if (normalized.includes("arc")) return "Arc";
  if (normalized === "iab" || normalized.includes("in-app")) return "Browser";
  return normalizedDisplayName(value);
}

function browserNativeAppReference(name: string): ToolActivityNativeAppReference | undefined {
  switch (name) {
    case "Chrome":
      return { _tag: "display-name", displayName: "Google Chrome" };
    case "Microsoft Edge":
    case "Firefox":
    case "Safari":
    case "Arc":
      return { _tag: "display-name", displayName: name };
    default:
      return undefined;
  }
}

function appDisplayNameFromId(appId: string): string | undefined {
  const knownNames: Readonly<Record<string, string>> = {
    "com.apple.finder": "Finder",
    "com.apple.safari": "Safari",
    "com.google.chrome": "Chrome",
    "com.microsoft.edgemac": "Microsoft Edge",
    "org.mozilla.firefox": "Firefox",
    "company.thebrowser.browser": "Arc",
  };
  return knownNames[appId.toLowerCase()];
}

function nativeAppReference(value: unknown): ToolActivityNativeAppReference | undefined {
  const app = asUnknownRecord(value);
  if (app?.kind === "appId") {
    const appId = normalizedAppId(app.appId);
    return appId ? { _tag: "app-id", appId } : undefined;
  }
  if (app?.kind === "displayName") {
    const displayName = normalizedDisplayName(app.displayName);
    return displayName ? { _tag: "display-name", displayName } : undefined;
  }
  return undefined;
}

function themedLogoIcon(
  ...records: ReadonlyArray<Record<string, unknown> | undefined>
): ToolActivityIcon | undefined {
  for (const record of records) {
    const logoUrl = normalizedImageUrl(record?.logoUrl);
    if (!logoUrl) continue;
    const logoUrlDark = normalizedImageUrl(record?.logoUrlDark ?? record?.logoDarkUrl);
    return {
      _tag: "themed-logo",
      logoUrl,
      ...(logoUrlDark ? { logoUrlDark } : {}),
    };
  }
  return undefined;
}

interface McpToolPresentation {
  readonly toolSurface?: "browser" | "computer";
  readonly toolIcon?: ToolActivityIcon;
  readonly toolSource?: ToolActivitySource;
}

function mcpToolPresentation(
  item: Extract<CodexLifecycleItem, { readonly type: "mcpToolCall" }>,
): McpToolPresentation {
  const result = asUnknownRecord(item.result);
  const metadata = asUnknownRecord(result?._meta);
  const surface = asUnknownRecord(metadata?.["codex/toolSurface"]);
  const sourceMetadata = asUnknownRecord(metadata?.source);
  const appContext = asUnknownRecord(item.appContext);
  const sourceLogo = themedLogoIcon(surface, sourceMetadata, appContext);
  if (surface?.kind === "browserUse") {
    const screenshot = asUnknownRecord(surface.screenshot);
    const browserUse = asUnknownRecord(metadata?.browser_use);
    const openTabs = Array.isArray(surface.openTabs) ? surface.openTabs : [];
    const latestOpenTab = openTabs
      .toReversed()
      .map(asUnknownRecord)
      .find((tab) => normalizedHttpUrl(tab?.url) !== undefined);
    const selectedPage = [
      { record: screenshot, url: screenshot?.pageUrl },
      { record: browserUse, url: browserUse?.url },
      { record: latestOpenTab, url: latestOpenTab?.url },
    ]
      .map((candidate) => ({
        ...candidate,
        pageUrl: normalizedHttpUrl(candidate.url),
      }))
      .find((candidate) => candidate.pageUrl !== undefined);
    const pageUrl = selectedPage?.pageUrl;
    const faviconUrl = normalizedImageUrl(
      selectedPage?.record?.faviconUrl ?? selectedPage?.record?.favIconUrl,
    );
    const faviconUrlDark = normalizedImageUrl(
      selectedPage?.record?.faviconUrlDark ?? selectedPage?.record?.favIconUrlDark,
    );
    const name =
      browserDisplayName(appContext?.appName) ??
      browserDisplayName(surface.browserFamily) ??
      browserDisplayName(surface.backend) ??
      "Browser";
    const nativeBrowserIcon = browserNativeAppReference(name);
    const sourceIcon =
      sourceLogo ??
      (nativeBrowserIcon ? ({ _tag: "native-app", app: nativeBrowserIcon } as const) : undefined);
    const sourceKeyPart = normalizedSourceKeyPart(name) || "browser";
    return {
      toolSurface: "browser",
      ...(pageUrl
        ? {
            toolIcon: {
              _tag: "website",
              pageUrl,
              ...(faviconUrl ? { faviconUrl } : {}),
              ...(faviconUrlDark ? { faviconUrlDark } : {}),
            } as const,
          }
        : {}),
      toolSource: {
        key: `browser-use:${sourceKeyPart}`,
        name,
        kind: name === "Browser" ? "browser" : "integration",
        ...(sourceIcon ? { icon: sourceIcon } : {}),
      },
    };
  }
  if (surface?.kind === "computerUse") {
    const app = nativeAppReference(surface.app);
    const args = asUnknownRecord(item.arguments);
    const argumentAppName =
      normalizedDisplayName(args?.appName) ??
      normalizedDisplayName(args?.application) ??
      normalizedDisplayName(typeof args?.app === "string" ? args.app : undefined);
    const name =
      normalizedDisplayName(appContext?.appName) ??
      argumentAppName ??
      (app?._tag === "display-name" ? app.displayName : undefined) ??
      (app?._tag === "app-id" ? appDisplayNameFromId(app.appId) : undefined) ??
      "Computer Use";
    const sourceIcon = sourceLogo ?? (app ? ({ _tag: "native-app", app } as const) : undefined);
    const sourceKey = app
      ? app._tag === "app-id"
        ? nativeAppSourceKey(app.appId)
        : `native-app-name:${normalizedSourceKeyPart(app.displayName)}`
      : "computer-use";
    return {
      toolSurface: "computer",
      ...(app ? { toolIcon: { _tag: "native-app", app } as const } : {}),
      toolSource: {
        key: sourceKey,
        name,
        kind: "computer",
        ...(sourceIcon ? { icon: sourceIcon } : {}),
      },
    };
  }

  return {};
}

const FATAL_CODEX_STDERR_SNIPPETS = ["failed to connect to websocket"];

function isFatalCodexProcessStderrMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return FATAL_CODEX_STDERR_SNIPPETS.some((snippet) => normalized.includes(snippet));
}

function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens <= 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
  };
}

function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

function boundedToolArgument(value: unknown): string | undefined {
  const normalized = typeof value === "string" ? value.trim().replace(/\s+/gu, " ") : "";
  if (!normalized) return undefined;
  return normalized.length <= 48 ? normalized : `${normalized.slice(0, 47)}…`;
}

function normalizedMcpToolName(value: string): string {
  return (
    value
      .split(/__|[./:]/u)
      .at(-1)
      ?.trim() ?? value.trim()
  );
}

function computerUseToolTitle(
  item: Extract<CodexLifecycleItem, { readonly type: "mcpToolCall" }>,
  presentation: McpToolPresentation,
): string | undefined {
  if (normalizeItemType(item.server) !== "computer use") return undefined;
  if (item.status === "failed") return undefined;
  const tool = normalizeItemType(normalizedMcpToolName(item.tool)).replace(/ /gu, "_");
  const inProgress = item.status === "inProgress";
  const args = asUnknownRecord(item.arguments);
  const appName =
    (presentation.toolSource?.kind === "computer" && presentation.toolSource.name !== "Computer Use"
      ? presentation.toolSource.name
      : undefined) ??
    normalizedDisplayName(args?.appName) ??
    normalizedDisplayName(args?.application) ??
    normalizedDisplayName(typeof args?.app === "string" ? args.app : undefined);
  const withApp = (label: string) => (appName ? `${label} in ${appName}` : label);
  switch (tool) {
    case "list_apps":
      return inProgress ? "Listing apps" : "Listed apps";
    case "click":
      return withApp(inProgress ? "Clicking" : "Clicked");
    case "drag":
      return withApp(inProgress ? "Dragging" : "Dragged");
    case "get_app_state":
    case "get_state":
      return appName
        ? `${inProgress ? "Looking at" : "Looked at"} ${appName}`
        : inProgress
          ? "Looking at the screen"
          : "Looked at the screen";
    case "perform_accessibility_action":
    case "perform_secondary_action":
      return inProgress ? "Performing accessibility action" : "Performed accessibility action";
    case "press_key":
      return withApp(inProgress ? "Pressing key" : "Pressed key");
    case "scroll": {
      const direction = boundedToolArgument(args?.direction)?.toLowerCase();
      return withApp(`${inProgress ? "Scrolling" : "Scrolled"}${direction ? ` ${direction}` : ""}`);
    }
    case "set_value":
      return withApp(inProgress ? "Setting value" : "Set value");
    case "type_text":
      return withApp(inProgress ? "Typing text" : "Typed text");
    default:
      return undefined;
  }
}

function itemTitle(
  itemType: CanonicalItemType,
  item?: CodexLifecycleItem,
  presentation: McpToolPresentation = {},
): string | undefined {
  if (itemType === "mcp_tool_call" && item?.type === "mcpToolCall") {
    if (normalizedMcpToolName(item.tool) === "js") {
      const intentTitle = normalizeMcpIntentTitle(asUnknownRecord(item.arguments)?.title);
      if (intentTitle) return intentTitle;
    }
    const computerUseTitle = computerUseToolTitle(item, presentation);
    if (computerUseTitle) return computerUseTitle;
    return `${item.server} · ${item.tool}`;
  }
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

function itemDetail(itemType: CanonicalItemType, item: CodexLifecycleItem): string | undefined {
  const itemRecord = item as Record<string, unknown>;
  const action = itemRecord.action as Record<string, unknown> | undefined;
  const actionQueries = Array.isArray(action?.queries) ? action.queries : [];
  const reasoning =
    itemType === "reasoning"
      ? [
          ...nativeReasoningText(itemRecord.summary),
          ...nativeReasoningText(itemRecord.content),
        ].join("\n")
      : undefined;
  const candidates = [
    ...(reasoning ? [reasoning] : []),
    ...(itemType === "web_search"
      ? [itemRecord.query, action?.query, ...actionQueries, action?.pattern, action?.url]
      : []),
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];

  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

// Codex sends `reason` only sometimes, and sends it blank rather than absent
// often enough to matter, so an empty one must not outrank the paths below.
function nonEmptyDetail(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
}

// Keeps one oversized patch from pushing a wall of paths through every consumer
// of the approval, while still saying how much it covers.
const MAX_DESCRIBED_FILE_CHANGES = 20;

// An apply-patch approval carries the edited paths as the keys of `fileChanges`.
// Without them the approval card has nothing to show but its own title — the
// command-execution branch already falls back to the command for the same reason.
function describeFileChanges(
  fileChanges: EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"] | undefined,
): string | undefined {
  if (fileChanges === undefined) return undefined;
  const entries = Object.entries(fileChanges).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return undefined;
  const described = entries.slice(0, MAX_DESCRIBED_FILE_CHANGES).map(([path, change]) => {
    const movePath = change.type === "update" ? change.move_path : undefined;
    return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
  });
  const remaining = entries.length - described.length;
  return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
}

function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "mcpServer/elicitation/request":
      return "mcp_elicitation_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    case "mcp-elicitation":
      return "mcp_elicitation_approval";
    default:
      return "unknown";
  }
}

function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

function eventRawSource(event: ProviderEvent): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

function liveActivityId(event: ProviderEvent): EventId {
  if (event.itemId !== undefined && event.method.startsWith("item/")) {
    const lifecycle =
      event.method === "item/started"
        ? "started"
        : event.method === "item/updated"
          ? "updated"
          : event.method === "item/completed"
            ? "completed"
            : event.method === "item/reasoning/summaryPartAdded" ||
                event.method === "item/commandExecution/terminalInteraction"
              ? "updated"
              : undefined;
    if (lifecycle !== undefined) {
      return EventId.make(codexNativeActivityId(event.turnId, event.itemId, lifecycle));
    }
  }
  return event.id;
}

export function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: liveActivityId(event),
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

type RuntimeEventBase = Omit<ProviderRuntimeEvent, "type" | "payload">;

function makeRuntimeEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  type: ProviderRuntimeEvent["type"],
  payload: unknown,
  overrides: Partial<RuntimeEventBase> = {},
): ProviderRuntimeEvent {
  return {
    ...runtimeEventBase(event, canonicalThreadId),
    ...overrides,
    type,
    payload,
  } as ProviderRuntimeEvent;
}

type CodexTextDeltaPayload = {
  readonly delta: string;
  readonly summaryIndex?: number;
  readonly contentIndex?: number;
};

/**
 * Small, session-scoped state for the only native stream that is delivered as
 * deltas but rendered as one T3 activity. It deliberately lives at the
 * adapter boundary, not in the database: App Server remains the transcript
 * owner and the buffer disappears when the live session ends.
 */
export interface CodexRuntimeProjectionState {
  readonly reasoningTextByItem: Map<string, string>;
}

function reasoningBufferKey(
  canonicalThreadId: ThreadId,
  turnId: ProviderEvent["turnId"],
  itemId: ProviderEvent["itemId"],
): string | undefined {
  if (turnId === undefined || itemId === undefined) return undefined;
  return `${canonicalThreadId}\u0000${turnId}\u0000${itemId}`;
}

function clearReasoningForTurn(
  state: CodexRuntimeProjectionState | undefined,
  canonicalThreadId: ThreadId,
  turnId: ProviderEvent["turnId"],
): void {
  if (state === undefined || turnId === undefined) return;
  const prefix = `${canonicalThreadId}\u0000${turnId}\u0000`;
  for (const key of state.reasoningTextByItem.keys()) {
    if (key.startsWith(prefix)) state.reasoningTextByItem.delete(key);
  }
}

function mapContentDelta<A extends CodexTextDeltaPayload>(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  streamKind:
    | "assistant_text"
    | "reasoning_text"
    | "reasoning_summary_text"
    | "command_output"
    | "file_change_output",
  schema: Schema.Schema<A>,
  extra: (payload: A) => Record<string, unknown> = () => ({}),
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = readPayload(schema, event.payload);
  const delta = event.textDelta ?? payload?.delta;
  if (!delta) return [];
  return [
    makeRuntimeEvent(event, canonicalThreadId, "content.delta", {
      streamKind,
      delta,
      ...(payload ? extra(payload) : {}),
    }),
  ];
}

function mapReasoningDelta(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  schema: Schema.Schema<CodexTextDeltaPayload>,
  state: CodexRuntimeProjectionState | undefined,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = readPayload(schema, event.payload);
  const delta = event.textDelta ?? payload?.delta;
  const key = reasoningBufferKey(canonicalThreadId, event.turnId, event.itemId);
  // Without both native ids there is no safe way to merge this delta with the
  // completion item. Dropping it is preferable to creating an activity that
  // can later be attached to a different parallel reasoning item.
  if (!delta || key === undefined) return [];
  const detail = `${state?.reasoningTextByItem.get(key) ?? ""}${delta}`;
  state?.reasoningTextByItem.set(key, detail);
  return [
    makeRuntimeEvent(
      event,
      canonicalThreadId,
      "item.updated",
      {
        itemType: "reasoning",
        title: "Reasoning",
        detail,
      },
      {
        // A delta is a replacement of the same activity, not a new row. The
        // projector already treats activity ids as latest-state identities.
        eventId: EventId.make(
          codexNativeActivityId(String(event.turnId), String(event.itemId), "reasoning"),
        ),
      },
    ),
  ];
}

function mapDecodedNotification<A>(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  schema: Schema.Schema<A>,
  type: ProviderRuntimeEvent["type"],
  project: (payload: A) => unknown | undefined,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload = readPayload(schema, event.payload);
  if (payload === undefined) return [];
  const projected = project(payload);
  return projected === undefined
    ? []
    : [makeRuntimeEvent(event, canonicalThreadId, type, projected)];
}

function canonicalRuntimeItemStatus(value: unknown): RuntimeItemStatus | undefined {
  switch (value) {
    case "inProgress":
    case "completed":
    case "failed":
    case "declined":
      return value;
    case "interrupted":
      // The shared activity contract has no interrupted item state. Keeping a
      // non-success terminal state is safer than the old fallback to
      // `completed`, which made stopped tools look successful after reload.
      return "failed";
    default:
      return undefined;
  }
}

/** Project one decoded native item. Live and history only provide different envelopes. */
function projectCodexItemLifecycle(
  item: CodexLifecycleItem,
  base: RuntimeEventBase,
  lifecycle: "item.started" | "item.updated" | "item.completed",
  data?: unknown,
  itemTypeOverride?: CanonicalItemType,
): ProviderRuntimeEvent | undefined {
  const itemType = itemTypeOverride ?? toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") return undefined;

  const detail = itemDetail(itemType, item);
  const toolPresentation = item.type === "mcpToolCall" ? mcpToolPresentation(item) : {};
  const title = itemTitle(itemType, item, toolPresentation);
  const nativeStatus = "status" in item ? canonicalRuntimeItemStatus(item.status) : undefined;
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? (nativeStatus ?? "completed")
        : nativeStatus;

  return {
    ...base,
    ...(itemType === "reasoning" && base.turnId
      ? {
          eventId: EventId.make(codexNativeActivityId(String(base.turnId), item.id, "reasoning")),
        }
      : {}),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...toolPresentation,
      ...(data !== undefined ? { data } : {}),
    },
  };
}

/**
 * The native item envelope is the same for live notifications and history
 * snapshots. Keeping the envelope creation here means a recovered item gets
 * the exact lifecycle/id rules as an item received over the WebSocket.
 */
function mapNativeItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  item: CodexLifecycleItem,
  lifecycle: "item.started" | "item.updated" | "item.completed",
  data: unknown = event.payload,
  itemTypeOverride?: CanonicalItemType,
): ProviderRuntimeEvent | undefined {
  return projectCodexItemLifecycle(
    item,
    runtimeEventBase(event, canonicalThreadId),
    lifecycle,
    data,
    itemTypeOverride,
  );
}

function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) return undefined;
  return mapNativeItemLifecycle(event, canonicalThreadId, item, lifecycle);
}

/**
 * Maps the session runtime's synthetic `collabAgent/*` events (native
 * multi-agent v2 child-thread signals) into the shared task.* lifecycle.
 * Agent identity = child thread id; nickname is the display title, role is
 * agentRole (fallback: last agentPath segment, then "general-purpose").
 * A completed child turn is idle (resumable), not terminal. timelineBypass
 * keeps these rows out of the parent chat.
 */
function mapCollabAgentEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : undefined;
  const agentThreadId = typeof payload?.agentThreadId === "string" ? payload.agentThreadId : "";
  if (!payload || agentThreadId.length === 0) {
    return [];
  }
  const phase =
    event.method === "collabAgent/started" ||
    (event.method === "collabAgent/activity" && payload.activityKind === "started")
      ? "started"
      : event.method === "collabAgent/turnCompleted" && payload.historyTerminal === true
        ? "completed"
        : event.method === "collabAgent/tokenUsage" || event.method === "collabAgent/item"
          ? "progress"
          : "updated";
  const base = {
    ...runtimeEventBase(event, canonicalThreadId),
    // Synthetic ProviderEvents are re-created on every connection. The child
    // thread id is the durable identity, so task rows must not use the random
    // event id or reconnects append another lifecycle row.
    eventId: EventId.make(`codex:agent:${agentThreadId}:${phase}`),
  };
  const taskEvent = (
    type: Extract<ProviderRuntimeEvent, { readonly type: `task.${string}` }>["type"],
    taskPayload: unknown,
  ) =>
    makeRuntimeEvent(event, canonicalThreadId, type, taskPayload, {
      eventId: base.eventId,
    });
  const taskId = RuntimeTaskId.make(agentThreadId);
  const agentPath = typeof payload.agentPath === "string" ? payload.agentPath : undefined;
  const pathLeaf = agentPath?.split("/").findLast((segment) => segment.length > 0);
  const nickname = typeof payload.nickname === "string" ? payload.nickname : undefined;
  const role =
    (typeof payload.role === "string" ? payload.role : undefined) ?? pathLeaf ?? "general-purpose";
  // A bare thread id is not a name. Omitting the title lets the client fold
  // keep the real one from task.started instead of clobbering it (probe
  // finding: progress rows renamed math_one to its UUID).
  const knownName = nickname ?? pathLeaf;
  const title = knownName ?? agentThreadId;
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  const effort = typeof payload.effort === "string" ? payload.effort.trim() : "";
  // Identity repeated on every status patch so rows are self-describing when
  // the start row ages out of activity retention (review finding: a
  // reconstructed agent had a UUID name and no role/path).
  const linkage = {
    role,
    ...(knownName ? { title: knownName } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(agentPath ? { agentPath } : {}),
    timelineBypass: true,
  } as const;

  switch (event.method) {
    case "collabAgent/started":
      return [
        taskEvent("task.started", {
          taskId,
          description: title,
          title,
          ...linkage,
          ...(typeof payload.parentThreadId === "string"
            ? { parentAgentId: payload.parentThreadId }
            : {}),
        }),
      ];
    case "collabAgent/metadataUpdated":
      return [taskEvent("task.updated", { taskId, ...linkage })];
    case "collabAgent/activity": {
      const activityKind = typeof payload.activityKind === "string" ? payload.activityKind : "";
      if (activityKind === "interrupted") {
        return [
          taskEvent("task.updated", {
            taskId,
            status: "interrupted",
            ...linkage,
          }),
        ];
      }
      if (activityKind === "started") {
        // Wire-probe finding: children often register via subAgentActivity
        // alone (no thread/started with a spawn source), so this is the one
        // shot at a task.started with a real name — agentPath leaf beats a
        // bare thread-id title.
        return [
          taskEvent("task.started", {
            taskId,
            description: title,
            title,
            ...linkage,
          }),
        ];
      }
      // Reading a child's result also emits "interacted" after its turn is idle.
      // Only the child's turn or thread lifecycle can prove it resumed work.
      return [];
    }
    case "collabAgent/turnStarted":
      return [taskEvent("task.updated", { taskId, status: "running", ...linkage })];
    case "collabAgent/turnCompleted": {
      const turn =
        typeof payload.turn === "object" && payload.turn !== null
          ? (payload.turn as Record<string, unknown>)
          : undefined;
      const turnStatus = typeof turn?.status === "string" ? turn.status : undefined;
      const status =
        turnStatus === "failed"
          ? ("failed" as const)
          : turnStatus === "interrupted"
            ? ("interrupted" as const)
            : ("idle" as const);
      const summary = typeof payload.message === "string" ? payload.message.trim() : "";
      if (payload.historyTerminal === true) {
        return [
          taskEvent("task.completed", {
            taskId,
            status:
              status === "failed" ? "failed" : status === "interrupted" ? "stopped" : "completed",
            ...(summary ? { summary } : {}),
            ...linkage,
          }),
        ];
      }
      return [taskEvent("task.updated", { taskId, status, ...linkage })];
    }
    case "collabAgent/statusChanged": {
      const status =
        typeof payload.status === "object" && payload.status !== null
          ? (payload.status as Record<string, unknown>)
          : undefined;
      const statusType = typeof status?.type === "string" ? status.type : undefined;
      if (statusType === "systemError") {
        // Silently dropping this once left children stuck running forever.
        return [taskEvent("task.updated", { taskId, status: "failed", ...linkage })];
      }
      if (statusType === "active") {
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
        const waiting = flags.some(
          (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
        );
        return [
          taskEvent("task.updated", {
            taskId,
            status: waiting ? "waiting" : "running",
            ...linkage,
          }),
        ];
      }
      if (statusType === "idle") {
        return [taskEvent("task.updated", { taskId, status: "idle", ...linkage })];
      }
      return [];
    }
    case "collabAgent/tokenUsage": {
      // Cumulative per child thread: always the `total` breakdown, never
      // `last` (which shrinks on follow-ups). Client folds max-merge.
      const tokenUsage =
        typeof payload.tokenUsage === "object" && payload.tokenUsage !== null
          ? (payload.tokenUsage as Record<string, unknown>)
          : undefined;
      const total =
        typeof tokenUsage?.total === "object" && tokenUsage.total !== null
          ? (tokenUsage.total as Record<string, unknown>)
          : undefined;
      const count = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
      // Same validation as every other field: RuntimeTaskUsage.totalTokens
      // is NonNegativeInt, so NaN/Infinity/negative wire values must miss.
      const totalTokens = count(total?.totalTokens);
      if (totalTokens === undefined) {
        return [];
      }
      const typedUsage: RuntimeTaskUsage = {
        totalTokens,
        ...(count(total?.inputTokens) !== undefined
          ? { inputTokens: count(total?.inputTokens) }
          : {}),
        ...(count(total?.cachedInputTokens) !== undefined
          ? { cachedInputTokens: count(total?.cachedInputTokens) }
          : {}),
        ...(count(total?.outputTokens) !== undefined
          ? { outputTokens: count(total?.outputTokens) }
          : {}),
        ...(count(total?.reasoningOutputTokens) !== undefined
          ? { reasoningOutputTokens: count(total?.reasoningOutputTokens) }
          : {}),
      };
      return [
        taskEvent("task.progress", {
          taskId,
          description: title,
          ...linkage,
          typedUsage,
        }),
      ];
    }
    case "collabAgent/item": {
      const item =
        typeof payload.item === "object" && payload.item !== null
          ? (payload.item as Record<string, unknown>)
          : undefined;
      const itemTypeRaw = typeof item?.type === "string" ? item.type : undefined;
      if (!itemTypeRaw) {
        return [];
      }
      // A loose summary from the raw item: the child stream is untyped at
      // this boundary (synthetic event payload), so read best-effort fields
      // rather than force a schema decode.
      const looseSummary =
        (typeof item?.command === "string" ? item.command : undefined) ??
        (typeof item?.title === "string" ? item.title : undefined) ??
        (typeof item?.query === "string" ? item.query : undefined);
      const canonical = toCanonicalItemType(itemTypeRaw);
      const summary = looseSummary ?? canonical.replaceAll("_", " ");
      return [
        taskEvent("task.progress", {
          taskId,
          description: title,
          ...linkage,
          summary,
        }),
      ];
    }
    case "collabAgent/closed":
      return [
        taskEvent("task.updated", {
          taskId,
          status: "interrupted",
          ...linkage,
        }),
      ];
    default:
      return [];
  }
}

export function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  state?: CodexRuntimeProjectionState,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "notification" && event.method.startsWith("collabAgent/")) {
    return mapCollabAgentEvent(event, canonicalThreadId);
  }
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      makeRuntimeEvent(event, canonicalThreadId, "runtime.error", {
        message: event.message,
        class: "provider_error",
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      }),
    ];
  }

  if (event.kind === "request") {
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        makeRuntimeEvent(event, canonicalThreadId, "user-input.requested", {
          questions,
        }),
      ];
    }

    const elicitation =
      event.method === "mcpServer/elicitation/request"
        ? readPayload(EffectCodexSchema.McpServerElicitationRequestParams, event.payload)
        : undefined;
    const elicitationApproval = elicitation ? describeMcpElicitation(elicitation) : undefined;
    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          // These params carry no path of their own, only the root the agent
          // wants to write under.
          return nonEmptyDetail(payload?.reason) ?? nonEmptyDetail(payload?.grantRoot);
        }
        case "mcpServer/elicitation/request":
          return elicitation?.message;
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return (
            nonEmptyDetail(payload?.reason) ??
            describeFileChanges(payload?.fileChanges) ??
            nonEmptyDetail(payload?.grantRoot)
          );
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(elicitationApproval
            ? {
                appName: elicitationApproval.appName,
                options: elicitationApproval.options,
              }
            : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "item/requestApproval/decision" && event.requestId) {
    const payload = readPayload(ApprovalDecisionPayload, event.payload);
    const requestType =
      event.requestKind !== undefined
        ? toRequestTypeFromKind(event.requestKind)
        : toRequestTypeFromMethod(event.method);
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.resolved",
        payload: {
          requestType,
          ...(payload ? { decision: payload.decision } : {}),
          ...(event.payload !== undefined ? { resolution: event.payload } : {}),
        },
      },
    ];
  }

  if (event.method === "session/connecting") {
    return [
      makeRuntimeEvent(event, canonicalThreadId, "session.state.changed", {
        state: "starting",
        ...(event.message ? { reason: event.message } : {}),
      }),
    ];
  }

  if (event.method === "session/ready") {
    return [
      makeRuntimeEvent(event, canonicalThreadId, "session.state.changed", {
        state: "ready",
        ...(event.message ? { reason: event.message } : {}),
      }),
    ];
  }

  if (event.method === "session/started") {
    return [
      makeRuntimeEvent(event, canonicalThreadId, "session.started", {
        ...(event.message ? { message: event.message } : {}),
        ...(event.payload !== undefined ? { resume: event.payload } : {}),
      }),
    ];
  }

  if (event.method === "session/exited" || event.method === "session/closed") {
    return [
      makeRuntimeEvent(event, canonicalThreadId, "session.exited", {
        ...(event.message ? { reason: event.message } : {}),
        ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
      }),
    ];
  }

  if (event.method === "thread/started") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ThreadStartedNotification,
      "thread.started",
      (payload) => ({ providerThreadId: payload.thread.id }),
    );
  }

  if (
    event.method === "thread/status/changed" ||
    event.method === "thread/archived" ||
    event.method === "thread/unarchived" ||
    event.method === "thread/closed" ||
    event.method === "thread/compacted"
  ) {
    const payload =
      event.method === "thread/status/changed"
        ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
        : undefined;
    return [
      makeRuntimeEvent(event, canonicalThreadId, "thread.state.changed", {
        state:
          event.method === "thread/archived"
            ? "archived"
            : event.method === "thread/closed"
              ? "closed"
              : event.method === "thread/compacted"
                ? "compacted"
                : payload
                  ? toThreadState(payload.status)
                  : "active",
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      }),
    ];
  }

  if (event.method === "thread/name/updated") {
    const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
    return [
      makeRuntimeEvent(event, canonicalThreadId, "thread.metadata.updated", {
        ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
        ...(payload
          ? {
              metadata: {
                threadId: payload.threadId,
                ...(payload.threadName !== undefined && payload.threadName !== null
                  ? { threadName: payload.threadName }
                  : {}),
              },
            }
          : {}),
      }),
    ];
  }

  if (event.method === "thread/tokenUsage/updated") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
      "thread.token-usage.updated",
      (payload) => {
        const usage = normalizeCodexTokenUsage(payload.tokenUsage);
        return usage ? { usage } : undefined;
      },
    );
  }

  if (event.method === "turn/started") {
    const turnId = event.turnId;
    if (!turnId) {
      return [];
    }
    return [makeRuntimeEvent(event, canonicalThreadId, "turn.started", {}, { turnId })];
  }

  if (event.method === "turn/completed") {
    const mapped = mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2TurnCompletedNotification,
      "turn.completed",
      (payload) => {
        const errorMessage = trimText(payload.turn.error?.message);
        return {
          state: toTurnStatus(payload.turn.status),
          ...(errorMessage ? { errorMessage } : {}),
        };
      },
    );
    clearReasoningForTurn(state, canonicalThreadId, event.turnId);
    return mapped;
  }

  if (event.method === "turn/aborted") {
    clearReasoningForTurn(state, canonicalThreadId, event.turnId);
    return [
      makeRuntimeEvent(event, canonicalThreadId, "turn.aborted", {
        reason: event.message ?? "Turn aborted",
      }),
    ];
  }

  if (event.method === "turn/plan/updated") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2TurnPlanUpdatedNotification,
      "turn.plan.updated",
      (payload) => ({
        ...(trimText(payload.explanation) ? { explanation: trimText(payload.explanation) } : {}),
        plan: payload.plan.map((step) => ({
          step: trimText(step.step) ?? "step",
          status:
            step.status === "completed" || step.status === "inProgress" ? step.status : "pending",
        })),
      }),
    );
  }

  if (event.method === "item/started") {
    const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
    return started ? [started] : [];
  }

  if (event.method === "item/completed") {
    const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
    const item = payload?.item;
    if (!item) {
      return [];
    }
    if (item.type === "agentMessage" && item.delivery === "async" && item.questions?.length) {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          requestId: RuntimeRequestId.make(`codex-async:${canonicalThreadId}:${item.id}`),
          eventId: EventId.make(`codex-async:${canonicalThreadId}:${item.id}`),
          payload: {
            responseMode: "message",
            questions: item.questions.map((question, index) => ({
              id: String(index),
              header: "Question",
              question: question.title,
              options: (question.options ?? []).map((label) => ({
                label,
                description: "",
              })),
              allowCustomAnswer: true,
              multiSelect: false,
            })),
          },
        },
      ];
    }
    const itemType = toCanonicalItemType(item.type);
    if (itemType === "plan") {
      const detail = itemDetail(itemType, item);
      if (!detail) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.completed",
          payload: {
            planMarkdown: detail,
          },
        },
      ];
    }
    let completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
    const reasoningKey =
      itemType === "reasoning"
        ? reasoningBufferKey(canonicalThreadId, event.turnId, event.itemId)
        : undefined;
    if (completed?.type === "item.completed" && reasoningKey !== undefined) {
      const bufferedDetail = state?.reasoningTextByItem.get(reasoningKey);
      if (bufferedDetail !== undefined && completed.payload.detail === undefined) {
        completed = {
          ...completed,
          payload: { ...completed.payload, detail: bufferedDetail },
        };
      }
      state?.reasoningTextByItem.delete(reasoningKey);
    }
    if (!completed || itemType !== "context_compaction") {
      return completed ? [completed] : [];
    }
    return [
      completed,
      {
        ...runtimeEventBase(event, canonicalThreadId),
        eventId: EventId.make(codexNativeActivityId(event.turnId, item.id, "context-compaction")),
        type: "thread.state.changed",
        payload: { state: "compacted" },
      },
    ];
  }

  if (event.method === "item/commandExecution/terminalInteraction") {
    return [
      makeRuntimeEvent(event, canonicalThreadId, "item.updated", {
        itemType: "command_execution",
        ...(event.payload !== undefined ? { data: event.payload } : {}),
      }),
    ];
  }

  if (event.method === "item/reasoning/summaryPartAdded") {
    // This notification only announces a new summary block. The following
    // summaryTextDelta carries its content; emitting an empty item.updated
    // creates a row that the activity projection cannot render.
    return [];
  }

  if (event.method === "item/plan/delta") {
    const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
    const delta = event.textDelta ?? payload?.delta;
    if (!delta || delta.length === 0) {
      return [];
    }
    return [
      makeRuntimeEvent(event, canonicalThreadId, "turn.proposed.delta", {
        delta,
      }),
    ];
  }

  if (event.method === "item/agentMessage/delta") {
    return mapContentDelta(
      event,
      canonicalThreadId,
      "assistant_text",
      EffectCodexSchema.V2AgentMessageDeltaNotification,
    );
  }

  if (event.method === "item/commandExecution/outputDelta") {
    return mapContentDelta(
      event,
      canonicalThreadId,
      "command_output",
      EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
    );
  }

  if (event.method === "item/fileChange/outputDelta") {
    return mapContentDelta(
      event,
      canonicalThreadId,
      "file_change_output",
      EffectCodexSchema.V2FileChangeOutputDeltaNotification,
    );
  }

  if (event.method === "item/reasoning/summaryTextDelta") {
    return mapReasoningDelta(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
      state,
    );
  }

  if (event.method === "item/reasoning/textDelta") {
    return mapReasoningDelta(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ReasoningTextDeltaNotification,
      state,
    );
  }

  if (event.method === "item/mcpToolCall/progress") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2McpToolCallProgressNotification,
      "tool.progress",
      (payload) => ({ summary: payload.message }),
    );
  }

  if (event.method === "serverRequest/resolved") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ServerRequestResolvedNotification,
      "request.resolved",
      () => ({
        requestType: toRequestTypeFromKind(event.requestKind),
        ...(event.payload !== undefined ? { resolution: event.payload } : {}),
      }),
    );
  }

  if (event.method === "item/tool/requestUserInput/answered") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.ToolRequestUserInputResponse,
      "user-input.resolved",
      (payload) => ({ answers: toCanonicalUserInputAnswers(payload.answers) }),
    );
  }

  if (event.method === "model/rerouted") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ModelReroutedNotification,
      "model.rerouted",
      (payload) => ({
        fromModel: payload.fromModel,
        toModel: payload.toModel,
        reason: payload.reason,
      }),
    );
  }

  if (event.method === "deprecationNotice") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2DeprecationNoticeNotification,
      "deprecation.notice",
      (payload) => ({
        summary: payload.summary,
        ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
      }),
    );
  }

  if (event.method === "configWarning") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ConfigWarningNotification,
      "config.warning",
      (payload) => ({
        summary: payload.summary,
        ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
        ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
        ...(payload.range !== undefined && payload.range !== null ? { range: payload.range } : {}),
      }),
    );
  }

  if (event.method === "account/updated") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2AccountUpdatedNotification,
      "account.updated",
      () => ({ account: event.payload ?? {} }),
    );
  }

  if (event.method === "account/rateLimits/updated") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2AccountRateLimitsUpdatedNotification,
      "account.rate-limits.updated",
      (payload) => {
        const limits = codexRateLimitsToUpdate(payload.rateLimits);
        return limits ? { limits } : undefined;
      },
    );
  }

  if (event.method === "mcpServer/oauthLogin/completed") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
      "mcp.oauth.completed",
      (payload) => ({
        success: payload.success,
        name: payload.name,
        ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
      }),
    );
  }

  if (event.method === "thread/realtime/started") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ThreadRealtimeStartedNotification,
      "thread.realtime.started",
      (payload) => ({
        realtimeSessionId: payload.realtimeSessionId ?? undefined,
      }),
    );
  }

  if (event.method === "thread/realtime/itemAdded") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
      "thread.realtime.item-added",
      (payload) => ({ item: payload.item }),
    );
  }

  if (event.method === "thread/realtime/outputAudio/delta") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
      "thread.realtime.audio.delta",
      (payload) => ({ audio: payload.audio }),
    );
  }

  if (event.method === "thread/realtime/error") {
    const payload = readPayload(EffectCodexSchema.V2ThreadRealtimeErrorNotification, event.payload);
    return [
      makeRuntimeEvent(event, canonicalThreadId, "thread.realtime.error", {
        message: payload?.message ?? event.message ?? "Realtime error",
      }),
    ];
  }

  if (event.method === "thread/realtime/closed") {
    const payload = readPayload(
      EffectCodexSchema.V2ThreadRealtimeClosedNotification,
      event.payload,
    );
    return [
      makeRuntimeEvent(event, canonicalThreadId, "thread.realtime.closed", {
        reason: payload?.reason ?? event.message,
      }),
    ];
  }

  if (event.method === "error") {
    const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
    const message = payload?.error.message ?? event.message ?? "Provider runtime error";
    const willRetry = payload?.willRetry === true;
    return [
      makeRuntimeEvent(event, canonicalThreadId, willRetry ? "runtime.warning" : "runtime.error", {
        message,
        ...(!willRetry ? { class: "provider_error" as const } : {}),
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      }),
    ];
  }

  if (event.method === "process/stderr") {
    const message = event.message ?? "Codex process stderr";
    const isFatal = isFatalCodexProcessStderrMessage(message);
    return [
      isFatal
        ? makeRuntimeEvent(event, canonicalThreadId, "runtime.error", {
            message,
            class: "provider_error" as const,
            ...(event.payload !== undefined ? { detail: event.payload } : {}),
          })
        : makeRuntimeEvent(event, canonicalThreadId, "runtime.warning", {
            message,
            ...(event.payload !== undefined ? { detail: event.payload } : {}),
          }),
    ];
  }

  if (event.method === "windows/worldWritableWarning") {
    return mapDecodedNotification(
      event,
      canonicalThreadId,
      EffectCodexSchema.V2WindowsWorldWritableWarningNotification,
      "runtime.warning",
      () => ({
        message: event.message ?? "Windows world-writable warning",
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      }),
    );
  }

  if (event.method === "windowsSandbox/setupCompleted") {
    const payload = readPayload(
      EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
      event.payload,
    );
    if (!payload) {
      return [];
    }
    const successMessage = event.message ?? "Windows sandbox setup completed";
    const failureMessage = event.message ?? "Windows sandbox setup failed";

    return [
      {
        type: "session.state.changed",
        ...runtimeEventBase(event, canonicalThreadId),
        payload: {
          state: payload.success === false ? "error" : "ready",
          reason: payload.success === false ? failureMessage : successMessage,
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
      ...(payload.success === false
        ? [
            {
              type: "runtime.warning" as const,
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message: failureMessage,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
          ]
        : []),
    ];
  }

  return [];
}
