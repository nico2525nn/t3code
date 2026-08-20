/**
 * OpenCode2Adapter — provider adapter for the OpenCode 2 (`opencode2`)
 * preview API.
 *
 * Talks to the V2 HTTP API via {@link ../opencode2Runtime | OpenCode2Runtime}:
 * creates/adopts sessions at a cwd, switches models, prompts through the
 * inbox, and streams the flat `session.*` SSE event vocabulary into T3
 * runtime events (content deltas, tool lifecycle, permission requests,
 * turn completion via `session.execution.succeeded`/`interrupted`).
 *
 * @module provider/Layers/OpenCode2Adapter
 */
import {
  EventId,
  type OpenCode2Settings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ToolLifecycleItemType,
  TurnId,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { type OpenCode2AdapterShape } from "../Services/OpenCode2Adapter.ts";
import {
  openCode2RuntimeErrorDetail,
  OpenCode2Runtime,
  OpenCode2RuntimeError,
  makeOpenCode2ApiClient,
  parseOpenCode2ModelSlug,
  toOpenCode2FileParts,
  type OpenCode2ApiClient,
  type OpenCode2Form,
  type OpenCode2ServerConnection,
  type OpenCode2Usage,
} from "../opencode2Runtime.ts";

const PROVIDER = ProviderDriverKind.make("opencode2");

/** Version tag stamped into the resume cursor. */
const OPENCODE2_RESUME_VERSION = 1 as const;

/** Cursor shape bumped together with OPENCODE2_RESUME_VERSION. */
function parseOpenCode2Resume(raw: unknown): { readonly sessionId: string } | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== OPENCODE2_RESUME_VERSION) {
    return undefined;
  }
  if (typeof record.sessionId !== "string" || record.sessionId.trim().length === 0) {
    return undefined;
  }
  return { sessionId: record.sessionId.trim() };
}

interface OpenCode2TurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface OpenCode2SessionContext {
  session: ProviderSession;
  readonly api: OpenCode2ApiClient;
  readonly server: OpenCode2ServerConnection;
  readonly directory: string;
  readonly openCode2SessionId: string;
  readonly pendingPermissions: Map<
    string,
    { readonly action: string; readonly resources: ReadonlyArray<string> }
  >;
  /** Pending V2 form requests surfaced to the client as user-input requests. */
  readonly pendingForms: Map<string, OpenCode2Form>;
  readonly toolByCallId: Map<string, { readonly name: string; readonly input: unknown }>;
  readonly turns: Array<OpenCode2TurnSnapshot>;
  activeTurnId: TurnId | undefined;
  currentModel:
    | { readonly id: string; readonly providerID: string; readonly variant?: string }
    | undefined;
  lastUsage: OpenCode2Usage | undefined;
  readonly stopped: Ref.Ref<boolean>;
  readonly sessionScope: Scope.Closeable;
}

export interface OpenCode2AdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

const toRequestError = (cause: OpenCode2RuntimeError): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method: cause.operation,
    detail: cause.detail,
    cause: cause.cause,
  });

const toProcessError = (threadId: ThreadId, cause: unknown): ProviderAdapterProcessError =>
  new ProviderAdapterProcessError({
    provider: PROVIDER,
    threadId,
    detail: OpenCode2RuntimeError.is(cause) ? cause.detail : openCode2RuntimeErrorDetail(cause),
    cause,
  });

function toToolLifecycleItemType(toolName: string): ToolLifecycleItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("bash") ||
    normalized.includes("shell") ||
    normalized.includes("command")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("patch") ||
    normalized.includes("multiedit")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) {
    return "web_search";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

function mapPermissionToRequestType(
  action: string,
): "command_execution_approval" | "file_read_approval" | "file_change_approval" | "unknown" {
  switch (action) {
    case "bash":
    case "shell":
      return "command_execution_approval";
    case "read":
      return "file_read_approval";
    case "edit":
    case "write":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

function mapPermissionDecision(reply: "once" | "always" | "reject" | undefined): string {
  switch (reply) {
    case "once":
      return "accept";
    case "always":
      return "acceptForSession";
    case "reject":
    default:
      return "decline";
  }
}

const ensureSessionContext = Effect.fn("ensureSessionContext")(function* (
  sessions: ReadonlyMap<ThreadId, OpenCode2SessionContext>,
  threadId: ThreadId,
) {
  const session = sessions.get(threadId);
  if (!session) {
    return yield* new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
    });
  }
  if (yield* Ref.get(session.stopped)) {
    return yield* new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
    });
  }
  return session;
});

export function findOpenCode2EventData(envelope: {
  readonly type: string;
  readonly data?: unknown;
}): Record<string, unknown> {
  return envelope.data !== null && typeof envelope.data === "object"
    ? (envelope.data as Record<string, unknown>)
    : {};
}

function openCode2FormLike(value: unknown): value is OpenCode2Form {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" && record.id.startsWith("frm_") && Array.isArray(record.fields)
  );
}

/**
 * Tolerantly extract pending form candidates from an event payload. The V2
 * server can emit a single `Form.Info`, wrap it in `data`, or send a batch
 * under `forms` — accept each shape so a `session.form.sync` event surfaces a
 * request regardless of exact framing. Pure and exported for testing.
 */
export function extractOpenCode2FormCandidates(payload: Record<string, unknown>): OpenCode2Form[] {
  const candidates: unknown[] = [];
  if (Array.isArray(payload)) {
    candidates.push(...payload);
  }
  if (openCode2FormLike(payload)) {
    candidates.push(payload);
  }
  if (openCode2FormLike(payload.data)) {
    candidates.push(payload.data);
  }
  if (Array.isArray(payload.forms)) {
    candidates.push(...payload.forms);
  }
  if (Array.isArray(payload.data)) {
    candidates.push(...payload.data);
  }
  const seen = new Set<string>();
  const forms: OpenCode2Form[] = [];
  for (const candidate of candidates) {
    if (!openCode2FormLike(candidate)) {
      continue;
    }
    if (seen.has(candidate.id)) {
      continue;
    }
    seen.add(candidate.id);
    forms.push(candidate);
  }
  return forms;
}

/**
 * Map a V2 form into the T3 user-input question list. Question ids equal the
 * underlying field keys so replies round-trip through {@link toOpenCode2FormAnswer}.
 */
export function openCode2FormToQuestions(form: OpenCode2Form): ReadonlyArray<UserInputQuestion> {
  return (form.fields ?? []).map((field) => {
    const header = field.title ?? field.key;
    const options = (field.options ?? []).map((option) => ({
      label: option.label ?? option.value,
      description: option.description ?? "",
    }));
    return {
      id: field.key,
      header,
      question: field.description ?? header,
      ...(field.type === "multiselect" ? { multiSelect: true } : {}),
      options,
    };
  });
}

/**
 * Convert T3 answers (keyed by question id == field key) into a V2 `Form.Answer`
 * value map, coercing booleans/numbers/multiselects to the wire types the V2
 * form fields expect.
 */
export function toOpenCode2FormAnswer(
  form: OpenCode2Form,
  answers: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  for (const field of form.fields ?? []) {
    const raw = answers[field.key] ?? answers[field.title ?? ""];
    if (raw === undefined || raw === null) {
      continue;
    }
    switch (field.type) {
      case "boolean":
        answer[field.key] = raw === true || raw === "true";
        break;
      case "multiselect": {
        const values = Array.isArray(raw) ? raw : [String(raw)];
        answer[field.key] = values
          .map((value) => String(value))
          .filter((value) => value.length > 0);
        break;
      }
      case "number":
      case "integer": {
        const numeric = Number(raw);
        answer[field.key] = Number.isNaN(numeric) ? String(raw) : numeric;
        break;
      }
      default:
        answer[field.key] = String(raw);
    }
  }
  return answer;
}

export function makeOpenCode2Adapter(
  openCode2Settings: OpenCode2Settings,
  options?: OpenCode2AdapterLiveOptions,
) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("opencode2");
    const serverConfig = yield* ServerConfig;
    const openCode2Runtime = yield* OpenCode2Runtime;
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, OpenCode2SessionContext>();
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate OpenCode 2 runtime identifier.",
            cause,
          }),
      ),
    );

    const buildEventBase = (input: {
      readonly threadId: ThreadId;
      readonly turnId?: TurnId | undefined;
      readonly itemId?: string | undefined;
      readonly requestId?: string | undefined;
      readonly createdAt?: string | undefined;
      readonly raw?: unknown;
    }) =>
      Effect.all({
        eventId: randomUUIDv4.pipe(Effect.map(EventId.make)),
        createdAt: input.createdAt === undefined ? nowIso : Effect.succeed(input.createdAt),
      }).pipe(
        Effect.map(({ eventId, createdAt }) => ({
          eventId,
          provider: PROVIDER,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          ...(input.requestId ? { requestId: RuntimeRequestId.make(input.requestId) } : {}),
          ...(input.raw !== undefined
            ? {
                raw: {
                  source: "opencode2.sdk.event" as const,
                  payload: input.raw,
                },
              }
            : {}),
        })),
      );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCode2Context(context)),
          { concurrency: "unbounded", discard: true },
        );
        if (managedNativeEventLogger !== undefined) {
          yield* managedNativeEventLogger.close();
        }
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);
    const writeNativeEvent = (
      threadId: ThreadId,
      event: { readonly observedAt: string; readonly event: Record<string, unknown> },
    ) => (nativeEventLogger ? nativeEventLogger.write(event, threadId) : Effect.void);

    const emitUnexpectedExit = Effect.fn("emitUnexpectedExit")(function* (
      context: OpenCode2SessionContext,
      message: string,
    ) {
      if (yield* Ref.getAndSet(context.stopped, true)) {
        return;
      }
      const turnId = context.activeTurnId;
      sessions.delete(context.session.threadId);
      yield* emit({
        ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
        type: "session.exited",
        payload: {
          reason: message,
          recoverable: false,
          exitKind: "error",
        },
      }).pipe(Effect.ignore);
      yield* Scope.close(context.sessionScope, Exit.void);
    });

    const updateProviderSession = (
      context: OpenCode2SessionContext,
      patch: Partial<ProviderSession>,
      options?: { readonly clearActiveTurnId?: boolean },
    ): Effect.Effect<ProviderSession> =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const nextSession = {
          ...context.session,
          ...patch,
          updatedAt,
        } as ProviderSession & Record<string, unknown>;
        const mutableSession = nextSession as Record<string, unknown>;
        if (options?.clearActiveTurnId) {
          delete mutableSession.activeTurnId;
        }
        context.session = nextSession;
        return nextSession;
      });

    const surfaceOpenCode2Forms = Effect.fn("surfaceOpenCode2Forms")(function* (
      context: OpenCode2SessionContext,
      forms: ReadonlyArray<OpenCode2Form>,
    ) {
      const threadId = context.session.threadId;
      for (const form of forms) {
        if (context.pendingForms.has(form.id)) {
          continue;
        }
        context.pendingForms.set(form.id, form);
        const questions = openCode2FormToQuestions(form);
        if (questions.length === 0) {
          continue;
        }
        yield* emit({
          ...(yield* buildEventBase({
            threadId,
            turnId: context.activeTurnId,
            requestId: form.id,
          })),
          type: "user-input.requested",
          payload: { questions },
        });
      }
    });

    /**
     * Pull pending forms for the session and surface any not already shown.
     * V2 does not reliably push a form-ask event, so the adapter polls after
     * each model step; a `session.form.sync` event (when emitted) feeds the
     * same path.
     */
    const syncOpenCode2Forms = Effect.fn("syncOpenCode2Forms")(function* (
      context: OpenCode2SessionContext,
    ) {
      const forms = yield* context.api
        .listForms(context.openCode2SessionId)
        .pipe(Effect.catchCause(() => Effect.succeed([])));
      yield* surfaceOpenCode2Forms(context, forms);
    });

    const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
      context: OpenCode2SessionContext,
      envelope: { readonly type: string; readonly data?: unknown },
    ) {
      const payload = findOpenCode2EventData(envelope);
      const payloadSessionId = payload.sessionID;
      if (typeof payloadSessionId === "string" && payloadSessionId !== context.openCode2SessionId) {
        return;
      }
      const turnId = context.activeTurnId;
      const threadId = context.session.threadId;
      yield* writeNativeEvent(threadId, {
        observedAt: yield* nowIso,
        event: {
          provider: PROVIDER,
          threadId,
          providerThreadId: context.openCode2SessionId,
          type: envelope.type,
          ...(turnId ? { turnId } : {}),
          payload: envelope,
        },
      }).pipe(Effect.ignore);

      switch (envelope.type) {
        case "session.model.selected": {
          const model = payload.model as
            | { readonly id?: string; readonly providerID?: string; readonly variant?: string }
            | undefined;
          if (model?.id && model.providerID) {
            context.currentModel = {
              id: model.id,
              providerID: model.providerID,
              ...(model.variant ? { variant: model.variant } : {}),
            };
          }
          break;
        }

        case "session.renamed": {
          const title = typeof payload.title === "string" ? payload.title.trim() : undefined;
          if (title && title.length > 0) {
            yield* emit({
              ...(yield* buildEventBase({ threadId, raw: envelope })),
              type: "thread.metadata.updated",
              payload: {
                name: title,
                metadata: {
                  sessionID: context.openCode2SessionId,
                },
              },
            });
          }
          break;
        }

        case "session.execution.started": {
          yield* updateProviderSession(context, { status: "running", activeTurnId: turnId });
          break;
        }

        case "session.reasoning.delta":
        case "session.text.delta": {
          const delta = typeof payload.delta === "string" ? payload.delta : "";
          const assistantMessageId =
            typeof payload.assistantMessageID === "string" ? payload.assistantMessageID : undefined;
          if (delta.length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: assistantMessageId,
              raw: envelope,
            })),
            type: "content.delta",
            payload: {
              streamKind:
                envelope.type === "session.reasoning.delta" ? "reasoning_text" : "assistant_text",
              delta,
            },
          });
          break;
        }

        case "session.reasoning.ended": {
          const text = typeof payload.text === "string" ? payload.text : "";
          if (text.length === 0) {
            break;
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId:
                typeof payload.assistantMessageID === "string"
                  ? payload.assistantMessageID
                  : undefined,
              raw: envelope,
            })),
            type: "item.completed",
            payload: {
              itemType: "reasoning",
              status: "completed",
              title: "Thinking",
              ...(text.length > 0 ? { detail: text } : {}),
            },
          });
          break;
        }

        case "session.text.ended": {
          const text = typeof payload.text === "string" ? payload.text : "";
          const assistantMessageId =
            typeof payload.assistantMessageID === "string" ? payload.assistantMessageID : undefined;
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              itemId: assistantMessageId,
              raw: envelope,
            })),
            type: "item.completed",
            payload: {
              itemType: "assistant_message",
              status: "completed",
              title: "Assistant message",
              ...(text.length > 0 ? { detail: text } : {}),
            },
          });
          break;
        }

        case "session.tool.input.started": {
          const callId = typeof payload.id === "string" ? payload.id : undefined;
          const name = typeof payload.name === "string" ? payload.name : "tool";
          if (callId) {
            context.toolByCallId.set(callId, { name, input: payload.input ?? payload.text });
          }
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: callId, raw: envelope })),
            type: "item.started",
            payload: {
              itemType: toToolLifecycleItemType(name),
              status: "inProgress",
              title: name,
            },
          });
          break;
        }

        case "session.tool.called": {
          const callId = typeof payload.id === "string" ? payload.id : undefined;
          const existing = callId ? context.toolByCallId.get(callId) : undefined;
          const name = existing?.name ?? "tool";
          if (callId) {
            context.toolByCallId.set(callId, { name, input: existing?.input ?? payload.input });
          }
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: callId, raw: envelope })),
            type: "item.updated",
            payload: {
              itemType: toToolLifecycleItemType(name),
              status: "inProgress",
              title: name,
              data: { tool: name, input: payload.input },
            },
          });
          break;
        }

        case "session.tool.progress": {
          const callId = typeof payload.id === "string" ? payload.id : undefined;
          const name = callId ? context.toolByCallId.get(callId)?.name : undefined;
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: callId, raw: envelope })),
            type: "item.updated",
            payload: {
              itemType: toToolLifecycleItemType(name ?? "tool"),
              status: "inProgress",
              ...(name ? { title: name } : {}),
              ...(payload.metadata !== undefined ? { data: payload.metadata } : {}),
            },
          });
          break;
        }

        case "session.tool.success": {
          const callId = typeof payload.id === "string" ? payload.id : undefined;
          const name = callId ? context.toolByCallId.get(callId)?.name : undefined;
          const content = Array.isArray(payload.content) ? payload.content : undefined;
          const detail = (content ?? [])
            .filter(
              (entry): entry is { readonly type: string; readonly text?: string } =>
                entry !== null &&
                typeof entry === "object" &&
                "type" in (entry as object) &&
                (entry as { type?: unknown }).type === "text",
            )
            .map((entry) => entry.text ?? "")
            .join("")
            .trim();
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, itemId: callId, raw: envelope })),
            type: "item.completed",
            payload: {
              itemType: toToolLifecycleItemType(name ?? "tool"),
              status: "completed",
              ...(name ? { title: name } : {}),
              ...(detail.length > 0 ? { detail } : {}),
            },
          });
          break;
        }

        case "session.tool.failed":
        case "session.step.failed": {
          const callId = typeof payload.id === "string" ? payload.id : undefined;
          const name = callId ? context.toolByCallId.get(callId)?.name : undefined;
          const error = payload.error as { readonly message?: unknown } | undefined;
          const message =
            typeof error?.message === "string" && error.message.length > 0
              ? error.message
              : envelope.type === "session.step.failed"
                ? "OpenCode 2 step failed."
                : "Tool failed.";
          const base = yield* buildEventBase({
            threadId,
            turnId,
            itemId: callId,
            raw: envelope,
          });
          if (envelope.type === "session.step.failed") {
            yield* emit({
              ...base,
              type: "runtime.warning",
              payload: { message },
            });
            break;
          }
          yield* emit({
            ...base,
            type: "item.completed",
            payload: {
              itemType: toToolLifecycleItemType(name ?? "tool"),
              status: "failed",
              ...(name ? { title: name } : {}),
              ...(message.length > 0 ? { detail: message } : {}),
            },
          });
          break;
        }

        case "session.step.started": {
          // V2 pushes form asks unreliably, so each model step re-surfaces any
          // new pending form (see syncOpenCode2Forms).
          yield* syncOpenCode2Forms(context);
          break;
        }

        case "session.form.sync": {
          const forms = extractOpenCode2FormCandidates(payload);
          yield* surfaceOpenCode2Forms(context, forms);
          break;
        }

        case "session.usage.updated": {
          const tokens = payload.tokens as
            | {
                readonly input?: number;
                readonly output?: number;
                readonly reasoning?: number;
                readonly cache?: { readonly read?: number; readonly write?: number };
              }
            | undefined;
          context.lastUsage = {
            ...(typeof payload.cost === "number" ? { cost: payload.cost } : {}),
            ...(tokens !== undefined && typeof tokens === "object" ? { tokens } : {}),
          };
          break;
        }

        case "session.execution.succeeded": {
          context.activeTurnId = undefined;
          yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          const usage = context.lastUsage;
          const inputTokens = usage?.tokens?.input;
          const outputTokens = usage?.tokens?.output;
          const reasoningTokens = usage?.tokens?.reasoning;
          const cachedInputTokens = usage?.tokens?.cache?.read;
          const totalTokens =
            inputTokens !== undefined || outputTokens !== undefined
              ? (inputTokens ?? 0) + (outputTokens ?? 0) + (reasoningTokens ?? 0)
              : undefined;
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId, raw: envelope })),
            type: "turn.completed",
            payload: {
              state: "completed",
              ...(usage?.cost !== undefined ? { totalCostUsd: usage.cost } : {}),
              ...(totalTokens !== undefined
                ? {
                    usage: {
                      totalTokens,
                      ...(inputTokens !== undefined ? { inputTokens } : {}),
                      ...(outputTokens !== undefined ? { outputTokens } : {}),
                      ...(reasoningTokens !== undefined
                        ? { reasoningOutputTokens: reasoningTokens }
                        : {}),
                      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
                    },
                  }
                : {}),
            },
          });
          break;
        }

        case "session.execution.interrupted": {
          context.activeTurnId = undefined;
          yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          if (turnId) {
            yield* emit({
              ...(yield* buildEventBase({ threadId, turnId, raw: envelope })),
              type: "turn.completed",
              payload: {
                state: "interrupted",
              },
            });
          }
          break;
        }

        case "permission.asked": {
          const requestId = typeof payload.id === "string" ? payload.id : undefined;
          const action = typeof payload.action === "string" ? payload.action : "unknown";
          const resources = Array.isArray(payload.resources)
            ? payload.resources.filter((r): r is string => typeof r === "string")
            : [];
          if (requestId) {
            context.pendingPermissions.set(requestId, { action, resources });
          }
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              requestId,
              raw: envelope,
            })),
            type: "request.opened",
            payload: {
              requestType: mapPermissionToRequestType(action),
              detail: resources.length > 0 ? resources.join("\n") : action,
              ...(payload.source !== undefined ? { args: payload.source } : {}),
            },
          });
          break;
        }

        case "permission.replied": {
          const requestId = typeof payload.requestID === "string" ? payload.requestID : undefined;
          context.pendingPermissions.delete(requestId ?? "");
          yield* emit({
            ...(yield* buildEventBase({
              threadId,
              turnId,
              requestId,
              raw: envelope,
            })),
            type: "request.resolved",
            payload: {
              requestType: "unknown",
              decision: mapPermissionDecision(
                payload.reply === "once" || payload.reply === "always" || payload.reply === "reject"
                  ? payload.reply
                  : undefined,
              ),
            },
          });
          break;
        }

        default:
          break;
      }
    });

    const startEventPump = Effect.fn("startEventPump")(function* (
      context: OpenCode2SessionContext,
    ) {
      yield* openCode2Runtime.streamOpenCode2Events({ connection: context.server }).pipe(
        Effect.flatMap((stream) =>
          stream.pipe(
            Stream.runForEach((message) =>
              handleSubscribedEvent(context, message.data as { type: string; data?: unknown }),
            ),
          ),
        ),
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.gen(function* () {
            if (yield* Ref.get(context.stopped)) {
              return;
            }
            if (Exit.isFailure(exit)) {
              yield* emitUnexpectedExit(
                context,
                openCode2RuntimeErrorDetail(Cause.squash(exit.cause)),
              );
            }
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );

      if (!context.server.external && context.server.exitCode !== null) {
        yield* context.server.exitCode.pipe(
          Effect.flatMap((code) =>
            Effect.gen(function* () {
              if (yield* Ref.get(context.stopped)) {
                return;
              }
              yield* emitUnexpectedExit(
                context,
                `OpenCode 2 server exited unexpectedly (${code}).`,
              );
            }),
          ),
          Effect.forkIn(context.sessionScope),
        );
      }
    });

    const startSession: OpenCode2AdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const binaryPath = openCode2Settings.binaryPath;
        const serverUrl = openCode2Settings.serverUrl;
        const serverPassword = openCode2Settings.serverPassword;
        const directory = input.cwd ?? serverConfig.cwd;
        const resumeSessionId = parseOpenCode2Resume(input.resumeCursor)?.sessionId;
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* stopOpenCode2Context(existing);
          sessions.delete(input.threadId);
        }

        const started = yield* Effect.gen(function* () {
          const sessionScope = yield* Scope.make();
          const startedExit = yield* Effect.exit(
            Effect.gen(function* () {
              const server = yield* openCode2Runtime.connectToOpenCode2Server({
                binaryPath,
                serverUrl,
                serverPassword,
                ...(options?.environment ? { environment: options.environment } : {}),
              });
              const api = makeOpenCode2ApiClient({
                connection: server,
                request: openCode2Runtime.request,
              });

              const resolved = yield* Effect.gen(function* () {
                const adopted = resumeSessionId ? yield* api.getSession(resumeSessionId) : null;
                if (adopted) {
                  const adoptedDirectory = adopted.location?.directory;
                  if (adoptedDirectory === undefined || adoptedDirectory === directory) {
                    return { openCode2Session: adopted, created: false };
                  }
                  // The thread moved into a different cwd (e.g. a git worktree).
                  // Fork the adopted session into the new directory — the fork
                  // carries the full history, so the follow-up keeps its context.
                  yield* Effect.logWarning(
                    `OpenCode 2 session '${adopted.id}' was created under a different working directory; forking into '${directory}' to preserve conversation history.`,
                  );
                  const forked = yield* api.forkSession(adopted.id);
                  return { openCode2Session: forked, created: true };
                } else if (resumeSessionId) {
                  yield* Effect.logWarning(
                    `OpenCode 2 session '${resumeSessionId}' no longer exists; starting a fresh session.`,
                  );
                }

                const created = yield* api.createSession(directory, input.title);
                return { openCode2Session: created, created: true };
              });

              // Attach the thread's MCP session (when present) to the managed
              // server so provider tools see T3's MCP bridge — mirrors the v1
              // adapter's `mcp.add`. External servers are left untouched.
              const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
              if (mcpSession && !server.external) {
                yield* api
                  .mcpAdd("t3-code", {
                    type: "remote",
                    url: mcpSession.endpoint,
                    headers: {
                      Authorization: mcpSession.authorizationHeader,
                    },
                    oauth: false,
                  })
                  .pipe(Effect.ignore);
              }

              const selectedVariant = getModelSelectionStringOptionValue(
                input.modelSelection,
                "variant",
              );
              const selectedModel = input.modelSelection
                ? parseOpenCode2ModelSlug(input.modelSelection.model)
                : undefined;
              if (selectedModel) {
                yield* api.switchModel(resolved.openCode2Session.id, {
                  id: selectedModel.modelID,
                  providerID: selectedModel.providerID,
                  ...(selectedVariant ? { variant: selectedVariant } : {}),
                });
              }

              return {
                sessionScope,
                server,
                api,
                openCode2Session: resolved.openCode2Session,
                model: selectedModel
                  ? {
                      id: selectedModel.modelID,
                      providerID: selectedModel.providerID,
                      ...(selectedVariant ? { variant: selectedVariant } : {}),
                    }
                  : undefined,
              };
            }).pipe(Effect.provideService(Scope.Scope, sessionScope)),
          );
          if (Exit.isFailure(startedExit)) {
            yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
            return yield* toProcessError(input.threadId, Cause.squash(startedExit.cause));
          }
          return startedExit.value;
        });

        const raceWinner = sessions.get(input.threadId);
        if (raceWinner) {
          yield* Scope.close(started.sessionScope, Exit.void).pipe(Effect.ignore);
          return raceWinner.session;
        }

        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: directory,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: OPENCODE2_RESUME_VERSION,
            sessionId: started.openCode2Session.id,
          },
          createdAt,
          updatedAt: createdAt,
        };

        const context: OpenCode2SessionContext = {
          session,
          api: started.api,
          server: started.server,
          directory,
          openCode2SessionId: started.openCode2Session.id,
          pendingPermissions: new Map(),
          pendingForms: new Map(),
          toolByCallId: new Map(),
          turns: [],
          activeTurnId: undefined,
          currentModel: started.model,
          lastUsage: undefined,
          stopped: yield* Ref.make(false),
          sessionScope: started.sessionScope,
        };
        sessions.set(input.threadId, context);
        yield* startEventPump(context);

        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: {
            message: "OpenCode 2 session started",
          },
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "thread.started",
          payload: {
            providerThreadId: started.openCode2Session.id,
          },
        });

        return session;
      },
    );

    const sendTurn: OpenCode2AdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSessionContext(sessions, input.threadId);
      const steeringTurnId = context.activeTurnId;
      const turnId = steeringTurnId ?? TurnId.make(`opencode2-turn-${yield* randomUUIDv4}`);
      const modelSelection =
        input.modelSelection ??
        (context.session.model
          ? { instanceId: boundInstanceId, model: context.session.model }
          : undefined);
      if (modelSelection !== undefined && modelSelection.instanceId !== boundInstanceId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: `OpenCode 2 model selection is bound to instance '${modelSelection?.instanceId}', expected '${boundInstanceId}'.`,
        });
      }
      const parsedModel = parseOpenCode2ModelSlug(modelSelection?.model);
      if (!parsedModel) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode 2 model selection must use the 'provider/model' format.",
        });
      }
      const variant = getModelSelectionStringOptionValue(modelSelection, "variant");

      const text = input.input?.trim();
      const fileParts = toOpenCode2FileParts({
        attachments: input.attachments,
        resolveAttachmentPath: (attachment) =>
          resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment,
          }),
      });
      if ((!text || text.length === 0) && fileParts.length === 0) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "OpenCode 2 turns require text input or at least one attachment.",
        });
      }

      const nextModel = {
        id: parsedModel.modelID,
        providerID: parsedModel.providerID,
        ...(variant ? { variant } : {}),
      };
      const current = context.currentModel;
      const modelChanged =
        current === undefined ||
        current.id !== nextModel.id ||
        current.providerID !== nextModel.providerID ||
        (nextModel.variant !== undefined && current.variant !== nextModel.variant);
      if (modelChanged) {
        yield* context.api
          .switchModel(context.openCode2SessionId, {
            id: nextModel.id,
            providerID: nextModel.providerID,
            ...(variant ? { variant } : {}),
          })
          .pipe(Effect.mapError(toRequestError));
        context.currentModel = nextModel;
      }

      context.activeTurnId = turnId;
      yield* updateProviderSession(context, {
        status: "running",
        activeTurnId: turnId,
        model: modelSelection?.model ?? context.session.model,
      });

      if (steeringTurnId === undefined) {
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
          type: "turn.started",
          payload: {
            model: modelSelection?.model ?? context.session.model,
            ...(variant ? { effort: variant } : {}),
          },
        });
      }

      yield* context.api
        .promptSession(context.openCode2SessionId, text ?? "", fileParts, "steer")
        .pipe(Effect.mapError(toRequestError));

      return {
        threadId: input.threadId,
        turnId,
        ...(context.session.resumeCursor !== undefined
          ? { resumeCursor: context.session.resumeCursor }
          : {}),
      };
    });

    const interruptTurn: OpenCode2AdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        yield* context.api
          .interruptSession(context.openCode2SessionId)
          .pipe(Effect.mapError(toRequestError));
        const activeTurnId = turnId ?? context.activeTurnId;
        context.activeTurnId = undefined;
        yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
        if (activeTurnId) {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
            type: "turn.aborted",
            payload: {
              reason: "Interrupted by user.",
            },
          });
        }
      },
    );

    const respondToRequest: OpenCode2AdapterShape["respondToRequest"] = Effect.fn(
      "respondToRequest",
    )(function* (threadId, requestId, decision) {
      const context = yield* ensureSessionContext(sessions, threadId);
      if (!context.pendingPermissions.has(requestId)) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "permission.reply",
          detail: `Unknown pending permission request: ${requestId}`,
        });
      }
      const reply: "once" | "always" | "reject" =
        decision === "accept" ? "once" : decision === "acceptForSession" ? "always" : "reject";
      yield* context.api
        .replyPermission(context.openCode2SessionId, requestId, reply)
        .pipe(Effect.mapError(toRequestError));
    });

    const respondToUserInput: OpenCode2AdapterShape["respondToUserInput"] = Effect.fn(
      "respondToUserInput",
    )(function* (threadId, requestId, answers) {
      const context = yield* ensureSessionContext(sessions, threadId);
      const form = context.pendingForms.get(requestId);
      if (!form) {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "form.reply",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      yield* context.api
        .replyForm(context.openCode2SessionId, form.id, toOpenCode2FormAnswer(form, answers))
        .pipe(Effect.mapError(toRequestError));
      context.pendingForms.delete(requestId);
      yield* emit({
        ...(yield* buildEventBase({ threadId, turnId: context.activeTurnId, requestId })),
        type: "user-input.resolved",
        payload: { answers },
      });
    });

    const stopOpenCode2ContextImpl = (context: OpenCode2SessionContext) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return false;
        }
        yield* context.api.interruptSession(context.openCode2SessionId).pipe(Effect.ignore);
        yield* Scope.close(context.sessionScope, Exit.void);
        return true;
      });

    const stopSession: OpenCode2AdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        const stopped = yield* stopOpenCode2ContextImpl(context);
        sessions.delete(threadId);
        if (!stopped) {
          return;
        }
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const listSessions: OpenCode2AdapterShape["listSessions"] = () =>
      Effect.sync(() => [...sessions.values()].map((context) => context.session));

    const hasSession: OpenCode2AdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const readThread: OpenCode2AdapterShape["readThread"] = Effect.fn("readThread")(
      function* (threadId) {
        const context = yield* ensureSessionContext(sessions, threadId);
        const messages = yield* context.api
          .listMessages(context.openCode2SessionId)
          .pipe(Effect.mapError(toRequestError));
        const turns: Array<OpenCode2TurnSnapshot> = [];
        for (const message of messages) {
          if (message.type === "assistant") {
            turns.push({
              id: TurnId.make(message.id),
              items: [message],
            });
          }
        }
        return { threadId, turns };
      },
    );

    const rollbackThread: OpenCode2AdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId, numTurns) {
        const context = yield* ensureSessionContext(sessions, threadId);
        if (numTurns <= 0) {
          return yield* readThread(threadId);
        }
        const messages = yield* context.api
          .listMessages(context.openCode2SessionId)
          .pipe(Effect.mapError(toRequestError));
        const assistantMessages = messages.filter((message) => message.type === "assistant");
        if (assistantMessages.length === 0) {
          return yield* readThread(threadId);
        }

        // Revert before the (len - numTurns):th assistant message, keeping the
        // first (len - numTurns) turns. Clamp to the first message so an
        // over-large numTurns reverts the whole session instead of erroring.
        const keep = Math.max(1, assistantMessages.length - numTurns);
        const boundary = assistantMessages[keep];
        if (boundary && boundary.type === "assistant") {
          yield* context.api
            .revertStage(context.openCode2SessionId, boundary.id)
            .pipe(Effect.mapError(toRequestError));
        } else {
          const first = assistantMessages[0];
          if (first !== undefined && first.type === "assistant") {
            yield* context.api
              .revertStage(context.openCode2SessionId, first.id)
              .pipe(Effect.mapError(toRequestError));
          }
        }
        yield* context.api
          .revertCommit(context.openCode2SessionId)
          .pipe(Effect.mapError(toRequestError));

        // Clear stale per-session transient state after the rollback.
        context.pendingPermissions.clear();
        context.pendingForms.clear();
        return yield* readThread(threadId);
      },
    );

    const stopAll: OpenCode2AdapterShape["stopAll"] = () =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(
          contexts,
          (context) => Effect.ignoreCause(stopOpenCode2ContextImpl(context)),
          { concurrency: "unbounded", discard: true },
        );
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies OpenCode2AdapterShape;
  });
}

function stopOpenCode2Context(context: OpenCode2SessionContext): Effect.Effect<boolean, never> {
  return Effect.gen(function* () {
    if (yield* Ref.getAndSet(context.stopped, true)) {
      return false;
    }
    yield* context.api.interruptSession(context.openCode2SessionId).pipe(Effect.ignore);
    yield* Scope.close(context.sessionScope, Exit.void);
    return true;
  });
}
