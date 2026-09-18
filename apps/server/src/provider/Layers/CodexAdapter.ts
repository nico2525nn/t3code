/**
 * CodexAdapterLive - Scoped live implementation for the Codex provider adapter.
 *
 * Wraps the typed Codex session runtime behind the `CodexAdapter` service
 * contract and maps runtime failures into the shared `ProviderAdapterError`
 * algebra.
 *
 * @module CodexAdapterLive
 */
import {
  type CodexSettings,
  ProviderDriverKind,
  type ProviderEvent,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type TurnTokenUsage,
  TurnId,
  ThreadId,
  ProviderSendTurnInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterProcessError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { type CodexAdapterShape } from "../Services/CodexAdapter.ts";
import type {
  ProviderStoredThreadHistory,
  ProviderStoredThreadSummary,
  ProviderThreadCatalog,
} from "../Services/ProviderAdapter.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  CodexResumeCursorSchema,
  CodexSessionRuntimeThreadIdMissingError,
  makeCodexSessionRuntime,
  type CodexSessionRuntimeError,
  type CodexSessionRuntimeOptions,
  type CodexSessionRuntimeSendTurnInput,
  type CodexSessionRuntimeShape,
} from "./CodexSessionRuntime.ts";
import {
  makeCodexAppServerManager,
  CODEX_APP_SERVER_THREAD_SOURCE_KINDS,
  type CodexAppServerManagerShape,
} from "./CodexAppServerManager.ts";
import {
  codexAppServerThreadToStoredHistory,
  type CodexRuntimeProjectionState,
  mapToRuntimeEvents,
  readPayload,
  runtimeEventBase,
} from "./CodexAppServerEventProjection.ts";
import { codexAppServerThreadSummary } from "./CodexAppServerHistoryProjection.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";
import { resolveCodexLaunchArgs } from "./codexLaunchArgs.ts";
import {
  type CodexRateLimitSnapshot,
  codexUsageLimitMessage,
  mergeCodexRateLimits,
} from "./codexUsageLimits.ts";
const isCodexAppServerProcessExitedError = Schema.is(CodexErrors.CodexAppServerProcessExitedError);
const isCodexAppServerTransportError = Schema.is(CodexErrors.CodexAppServerTransportError);
const isCodexSessionRuntimeThreadIdMissingError = Schema.is(
  CodexSessionRuntimeThreadIdMissingError,
);
const isCodexResumeCursorSchema = Schema.is(CodexResumeCursorSchema);

const PROVIDER = ProviderDriverKind.make("codex");

export interface CodexAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  /** Shared home used by Codex's app-server-daemon control socket. */
  readonly appServerHomePath?: string;
  /** Attach to the user's existing Codex app-server daemon when available. */
  readonly preferExistingDaemon?: boolean;
  readonly makeRuntime?: (
    options: CodexSessionRuntimeOptions,
  ) => Effect.Effect<
    CodexSessionRuntimeShape,
    CodexSessionRuntimeError,
    ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
  >;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface CodexAdapterSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly runtime: CodexSessionRuntimeShape;
  readonly eventFiber: Fiber.Fiber<void, never>;
  readonly turnTokenUsage: CodexTurnTokenUsageState;
  stopped: boolean;
}

type CodexCumulativeTokenUsage = {
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheCreationTokens?: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
};

interface CodexTurnTokenUsageAccumulator {
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number | undefined;
  outputTokens: number;
  reasoningTokens: number;
  observed: boolean;
  hasSubagents: boolean;
}

interface CodexTurnTokenUsageState {
  baseline: CodexCumulativeTokenUsage | undefined;
  activeTurnId: string | undefined;
  readonly byTurnId: Map<string, CodexTurnTokenUsageAccumulator>;
}

function mapCodexRuntimeError(
  threadId: ThreadId,
  method: string,
  error: CodexSessionRuntimeError,
): ProviderAdapterError {
  if (isCodexAppServerProcessExitedError(error) || isCodexAppServerTransportError(error)) {
    return new ProviderAdapterSessionClosedError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  if (isCodexSessionRuntimeThreadIdMissingError(error)) {
    return new ProviderAdapterSessionNotFoundError({
      provider: PROVIDER,
      threadId,
      cause: error,
    });
  }

  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: error.message,
    cause: error,
  });
}

function codexTokenUsageBreakdown(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification__TokenUsageBreakdown,
): CodexCumulativeTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    cachedInputTokens: usage.cachedInputTokens,
    ...(usage.cacheWriteInputTokens !== undefined
      ? { cacheCreationTokens: usage.cacheWriteInputTokens }
      : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: usage.reasoningOutputTokens,
  };
}

function makeCodexTurnTokenUsageState(): CodexTurnTokenUsageState {
  return {
    baseline: undefined,
    activeTurnId: undefined,
    byTurnId: new Map(),
  };
}

function getCodexTurnAccumulator(
  state: CodexTurnTokenUsageState,
  turnId: string,
): CodexTurnTokenUsageAccumulator {
  const existing = state.byTurnId.get(turnId);
  if (existing) return existing;
  const created: CodexTurnTokenUsageAccumulator = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    observed: false,
    hasSubagents: false,
  };
  state.byTurnId.set(turnId, created);
  return created;
}

/**
 * Usage added by one `thread/tokenUsage/updated` notification. Codex reports a
 * running `total` for the thread and `last`, the usage of the newest model
 * response. Within a turn the growth of `total` equals `last`. Without a prior
 * total (first update after resume or rollback), or when Codex reset the
 * running total, `last` is the delta.
 */
function codexTurnTokenUsageDelta(
  previous: CodexCumulativeTokenUsage | undefined,
  current: CodexCumulativeTokenUsage,
  last: CodexCumulativeTokenUsage,
): CodexCumulativeTokenUsage {
  if (
    previous === undefined ||
    current.inputTokens < previous.inputTokens ||
    current.cachedInputTokens < previous.cachedInputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.reasoningTokens < previous.reasoningTokens
  ) {
    return last;
  }
  return {
    inputTokens: current.inputTokens - previous.inputTokens,
    cachedInputTokens: current.cachedInputTokens - previous.cachedInputTokens,
    ...(current.cacheCreationTokens !== undefined &&
    previous.cacheCreationTokens !== undefined &&
    current.cacheCreationTokens >= previous.cacheCreationTokens
      ? { cacheCreationTokens: current.cacheCreationTokens - previous.cacheCreationTokens }
      : {}),
    outputTokens: current.outputTokens - previous.outputTokens,
    reasoningTokens: current.reasoningTokens - previous.reasoningTokens,
  };
}

function accumulateCodexTurnTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
): void {
  const current = codexTokenUsageBreakdown(usage.total);
  if (state.activeTurnId !== turnId) {
    // The total is thread-wide, so every update moves the baseline. A late
    // update for a finished turn is not counted toward the live turn.
    state.baseline = current;
    return;
  }

  const accumulator = getCodexTurnAccumulator(state, turnId);
  const delta = codexTurnTokenUsageDelta(
    state.baseline,
    current,
    codexTokenUsageBreakdown(usage.last),
  );
  state.baseline = current;

  if (
    delta.inputTokens > 0 ||
    delta.cachedInputTokens > 0 ||
    delta.outputTokens > 0 ||
    delta.reasoningTokens > 0
  ) {
    accumulator.observed = true;
  }
  accumulator.inputTokens += delta.inputTokens;
  accumulator.cachedInputTokens += delta.cachedInputTokens;
  accumulator.outputTokens += delta.outputTokens;
  accumulator.reasoningTokens += delta.reasoningTokens;
  if (delta.cacheCreationTokens === undefined) {
    accumulator.cacheCreationTokens = undefined;
  } else if (accumulator.cacheCreationTokens !== undefined) {
    accumulator.cacheCreationTokens += delta.cacheCreationTokens;
  }
}

function completeCodexTurnTokenUsage(
  state: CodexTurnTokenUsageState,
  turnId: string,
  completed: boolean,
): TurnTokenUsage {
  const usage = state.byTurnId.get(turnId);
  state.byTurnId.delete(turnId);
  if (state.activeTurnId === turnId) state.activeTurnId = undefined;
  if (!usage) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: false,
    };
  }

  if (!usage.observed) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents: usage.hasSubagents,
    };
  }

  // Codex counts cache reads and writes inside inputTokens. Clamp the
  // subsets so the record keeps the documented relationships even if a
  // counter drifts.
  return {
    usageStatus: completed ? "complete" : "partial",
    usageScope: "main_agent",
    inputTokens: usage.inputTokens,
    cachedInputTokens: Math.min(usage.inputTokens, usage.cachedInputTokens),
    ...(usage.cacheCreationTokens !== undefined
      ? { cacheCreationTokens: Math.min(usage.inputTokens, usage.cacheCreationTokens) }
      : {}),
    outputTokens: usage.outputTokens,
    reasoningTokens: Math.min(usage.outputTokens, usage.reasoningTokens),
    hasSubagents: usage.hasSubagents,
  };
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
export const makeCodexAdapter = Effect.fn("makeCodexAdapter")(function* (
  codexConfig: CodexSettings,
  options?: CodexAdapterLiveOptions,
) {
  const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("codex");
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const serverConfig = yield* Effect.service(ServerConfig);
  const nativeEventLogger =
    options?.nativeEventLogger ??
    (options?.nativeEventLogPath !== undefined
      ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, {
          stream: "native",
        })
      : undefined);
  const managedNativeEventLogger =
    options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;
  const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const bindings = new Map<ThreadId, CodexAdapterSessionContext>();
  const sharedAppServer: CodexAppServerManagerShape | undefined =
    options?.makeRuntime === undefined && process.platform !== "win32"
      ? yield* makeCodexAppServerManager({
          instanceId: boundInstanceId,
          binaryPath: codexConfig.binaryPath,
          launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options?.environment),
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          ...(options?.appServerHomePath ? { appServerHomePath: options.appServerHomePath } : {}),
          ...(options?.preferExistingDaemon === true ? { preferExistingDaemon: true } : {}),
          ...(options?.environment ? { environment: options.environment } : {}),
          cwd: process.cwd(),
        })
      : undefined;

  const mapCatalogError = (method: string, cause: CodexErrors.CodexAppServerError) =>
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method,
      detail: cause.message,
      cause,
    });

  const listStoredThreads = (): Effect.Effect<
    ReadonlyArray<ProviderStoredThreadSummary>,
    ProviderAdapterError
  > => {
    if (sharedAppServer === undefined) {
      return Effect.succeed([]);
    }

    return Effect.gen(function* () {
      const listParams = {
        sourceKinds: CODEX_APP_SERVER_THREAD_SOURCE_KINDS,
        sortKey: "updated_at" as const,
        sortDirection: "desc" as const,
      };
      const activeThreads = yield* sharedAppServer
        .listThreads({ ...listParams, archived: false })
        .pipe(Effect.mapError((cause) => mapCatalogError("thread/list", cause)));
      const archivedThreads = yield* sharedAppServer
        .listThreads({ ...listParams, archived: true })
        .pipe(Effect.mapError((cause) => mapCatalogError("thread/list", cause)));
      const byNativeId = new Map<string, ProviderStoredThreadSummary>();
      for (const thread of activeThreads) {
        byNativeId.set(thread.id, codexAppServerThreadSummary(thread, false));
      }
      for (const thread of archivedThreads) {
        if (!byNativeId.has(thread.id)) {
          byNativeId.set(thread.id, codexAppServerThreadSummary(thread, true));
        }
      }
      return Array.from(byNativeId.values());
    });
  };

  const readStoredThread = (input: {
    readonly nativeThreadId: string;
    readonly archived: boolean;
    readonly turnLimit?: number;
    readonly beforeTurnId?: TurnId;
  }): Effect.Effect<ProviderStoredThreadHistory, ProviderAdapterError> => {
    if (sharedAppServer === undefined) {
      return Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/read",
          detail: "Codex App Server catalog is not available for this adapter.",
        }),
      );
    }

    return sharedAppServer
      .readThread(input.nativeThreadId, {
        ...(input.turnLimit === undefined ? {} : { userTurnLimit: input.turnLimit + 1 }),
        ...(input.beforeTurnId === undefined
          ? {}
          : { beforeTurnId: input.beforeTurnId.toString() }),
      })
      .pipe(
        Effect.map((thread) => codexAppServerThreadToStoredHistory(thread, input.archived)),
        Effect.mapError((cause) => mapCatalogError("thread/read", cause)),
      );
  };

  const storedThreadCatalog: ProviderThreadCatalog<ProviderAdapterError> | undefined =
    sharedAppServer === undefined
      ? undefined
      : {
          listStoredThreads,
          readStoredThread,
        };

  const startSession: CodexAdapterShape["startSession"] = (input) =>
    Effect.scoped(
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        const existing = bindings.get(input.threadId);
        if (existing && !existing.stopped) {
          yield* Effect.suspend(() => stopSessionInternal(existing));
        }

        const serviceTier =
          input.modelSelection?.instanceId === boundInstanceId
            ? getCodexServiceTierOptionValue(input.modelSelection)
            : undefined;
        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
        const sharedMcpThreadConfig =
          sharedAppServer && mcpSession
            ? {
                "mcp_servers.t3-code.url": mcpSession.endpoint,
                "mcp_servers.t3-code.http_headers.Authorization": mcpSession.authorizationHeader,
              }
            : undefined;
        const runtimeInput: CodexSessionRuntimeOptions = {
          threadId: input.threadId,
          providerInstanceId: boundInstanceId,
          cwd: input.cwd ?? process.cwd(),
          binaryPath: codexConfig.binaryPath,
          launchArgs: resolveCodexLaunchArgs(codexConfig.launchArgs, options?.environment),
          ...(options?.environment ? { environment: options.environment } : {}),
          ...(codexConfig.homePath ? { homePath: codexConfig.homePath } : {}),
          ...(isCodexResumeCursorSchema(input.resumeCursor)
            ? { resumeCursor: input.resumeCursor }
            : {}),
          runtimeMode: input.runtimeMode,
          ...(input.modelSelection?.instanceId === boundInstanceId
            ? { model: input.modelSelection.model }
            : {}),
          ...(serviceTier ? { serviceTier } : {}),
          ...(input.preserveProviderSettingsOnResume === true
            ? { preserveProviderSettingsOnResume: true }
            : {}),
          ...(input.activeTurnId ? { activeTurnId: input.activeTurnId } : {}),
          ...(mcpSession && sharedAppServer === undefined
            ? {
                environment: {
                  ...McpProviderSession.withAgentDeviceEnvironment(
                    options?.environment ?? process.env,
                    mcpSession,
                  ),
                  T3_MCP_BEARER_TOKEN: mcpSession.authorizationHeader.replace(/^Bearer\s+/, ""),
                },
                appServerArgs: [
                  "-c",
                  `mcp_servers.t3-code.url=${mcpSession.endpoint}`,
                  "-c",
                  'mcp_servers.t3-code.bearer_token_env_var="T3_MCP_BEARER_TOKEN"',
                ],
                mcpCapabilities: mcpSession.capabilities,
              }
            : {}),
          ...(sharedMcpThreadConfig ? { threadConfig: sharedMcpThreadConfig } : {}),
        };
        const turnTokenUsage = makeCodexTurnTokenUsageState();
        // Codex reports a usage-limit stop as OpenAI's own sentence, which on a
        // Business workspace blames credits for a window that ran out. The
        // snapshot naming that window arrives in its own notification, before or
        // after the stop and often sparse, so keep the session's merged view of
        // it and read it when a turn fails on the limit.
        let rateLimits: CodexRateLimitSnapshot | undefined;
        const projectionState: CodexRuntimeProjectionState = {
          reasoningTextByItem: new Map(),
        };
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );
        const appServerSession = sharedAppServer
          ? yield* sharedAppServer.openSession().pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            )
          : undefined;
        const createRuntime = options?.makeRuntime ?? makeCodexSessionRuntime;
        const effectiveRuntimeInput =
          appServerSession === undefined
            ? runtimeInput
            : {
                ...runtimeInput,
                appServerSession,
              };
        const runtime = yield* createRuntime(effectiveRuntimeInput).pipe(
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        // Fork into the session scope, not the calling fiber. `forkChild` makes
        // this a child of `startSession`, and Effect interrupts a fiber's
        // children when it completes, so the consumer died on return and every
        // runtime event the session emitted afterwards was dropped.
        const eventFiber = yield* Stream.runForEach(runtime.events, (event) =>
          Effect.gen(function* () {
            yield* writeNativeEvent(event);
            if (event.method === "turn/started" && event.turnId) {
              if (turnTokenUsage.activeTurnId !== event.turnId) {
                turnTokenUsage.byTurnId.clear();
                turnTokenUsage.activeTurnId = event.turnId;
                getCodexTurnAccumulator(turnTokenUsage, event.turnId);
              }
            } else if (event.method === "thread/tokenUsage/updated") {
              const payload = readPayload(
                EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
                event.payload,
              );
              if (payload) {
                accumulateCodexTurnTokenUsage(turnTokenUsage, payload.turnId, payload.tokenUsage);
              }
            } else if (turnTokenUsage.activeTurnId) {
              const collabPayload =
                typeof event.payload === "object" && event.payload !== null
                  ? (event.payload as Record<string, unknown>)
                  : undefined;
              const isCollabSpawn =
                event.method === "collabAgent/started" ||
                (event.method === "collabAgent/activity" &&
                  collabPayload?.activityKind === "started");
              if (isCollabSpawn && event.turnId === turnTokenUsage.activeTurnId) {
                getCodexTurnAccumulator(turnTokenUsage, turnTokenUsage.activeTurnId).hasSubagents =
                  true;
              }
            }

            if (event.method === "account/rateLimits/updated") {
              const limitsPayload = readPayload(
                EffectCodexSchema.V2AccountRateLimitsUpdatedNotification,
                event.payload,
              );
              if (limitsPayload) {
                rateLimits = mergeCodexRateLimits(rateLimits, limitsPayload.rateLimits);
              }
            } else if (event.method === "error") {
              const errorPayload = readPayload(
                EffectCodexSchema.V2ErrorNotification,
                event.payload,
              );
              // The failed `turn/completed` repeats this sentence and is answered
              // below; relaying both would show the limit twice.
              if (errorPayload?.error.codexErrorInfo === "usageLimitExceeded") return;
            }

            let usageLimitError: ProviderRuntimeEvent | undefined;
            let usageLimitMessage: string | undefined;
            if (event.method === "turn/completed") {
              const completedPayload = readPayload(
                EffectCodexSchema.V2TurnCompletedNotification,
                event.payload,
              );
              const turnError =
                completedPayload?.turn.status === "failed"
                  ? completedPayload.turn.error
                  : undefined;
              if (turnError?.codexErrorInfo === "usageLimitExceeded") {
                usageLimitMessage = codexUsageLimitMessage(rateLimits, event.createdAt);
                usageLimitError = {
                  ...runtimeEventBase(event, event.threadId),
                  type: "runtime.error",
                  payload: {
                    message: usageLimitMessage,
                    class: "provider_error",
                    ...(turnError.message ? { detail: turnError.message } : {}),
                  },
                };
              }
            }

            const mappedEvents = mapToRuntimeEvents(event, event.threadId, projectionState).map(
              (runtimeEvent) => {
                if (runtimeEvent.type === "turn.completed" && runtimeEvent.turnId) {
                  return {
                    ...runtimeEvent,
                    payload: {
                      ...runtimeEvent.payload,
                      ...(usageLimitMessage ? { errorMessage: usageLimitMessage } : {}),
                      tokenUsage: completeCodexTurnTokenUsage(
                        turnTokenUsage,
                        String(runtimeEvent.turnId),
                        runtimeEvent.payload.state === "completed",
                      ),
                    },
                  } satisfies ProviderRuntimeEvent;
                }
                if (runtimeEvent.type === "turn.aborted" && runtimeEvent.turnId) {
                  return {
                    ...runtimeEvent,
                    payload: {
                      ...runtimeEvent.payload,
                      tokenUsage: completeCodexTurnTokenUsage(
                        turnTokenUsage,
                        String(runtimeEvent.turnId),
                        false,
                      ),
                    },
                  } satisfies ProviderRuntimeEvent;
                }
                return runtimeEvent;
              },
            );
            const runtimeEvents = usageLimitError
              ? [usageLimitError, ...mappedEvents]
              : mappedEvents;
            if (runtimeEvents.length === 0) {
              yield* Effect.logDebug("ignoring unhandled Codex provider event", {
                method: event.method,
                threadId: event.threadId,
                turnId: event.turnId,
                itemId: event.itemId,
              });
              return;
            }
            yield* Queue.offerAll(runtimeEventQueue, runtimeEvents);
          }),
        ).pipe(Effect.forkIn(sessionScope));

        const started = yield* runtime.start().pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
          Effect.onError(() =>
            runtime.close.pipe(
              Effect.andThen(Effect.ignore(Scope.close(sessionScope, Exit.void))),
              Effect.andThen(Fiber.interrupt(eventFiber)),
              Effect.ignore,
            ),
          ),
        );

        bindings.set(input.threadId, {
          threadId: input.threadId,
          scope: sessionScope,
          runtime,
          eventFiber,
          turnTokenUsage,
          stopped: false,
        });
        sessionScopeTransferred = true;

        return started;
      }),
    );

  const resolveAttachment = Effect.fn("resolveAttachment")(function* (
    input: ProviderSendTurnInput,
    attachment: NonNullable<ProviderSendTurnInput["attachments"]>[number],
  ) {
    const attachmentPath = resolveAttachmentPath({
      attachmentsDir: serverConfig.attachmentsDir,
      attachment,
    });
    if (!attachmentPath) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "turn/start",
        detail: `Invalid attachment id '${attachment.id}'.`,
      });
    }
    return {
      type: "localImage" as const,
      path: attachmentPath,
    };
  });

  const sendTurn: CodexAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
    // Codex ingests images only. Anything else would be inlined as an image
    // and rejected or misread; generic files reach the agent through the path
    // line ProviderService puts in the prompt. Images are passed by path
    // instead of base64 so the turn/start request does not scale with file
    // size; the CLI reads the file itself.
    const codexAttachments = yield* Effect.forEach(
      (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
      (attachment) => resolveAttachment(input, attachment),
      { concurrency: 1 },
    );

    const session = yield* requireSession(input.threadId);
    const reasoningEffort =
      input.modelSelection?.instanceId === boundInstanceId
        ? getModelSelectionStringOptionValue(input.modelSelection, "reasoningEffort")
        : undefined;
    const serviceTier =
      input.modelSelection?.instanceId === boundInstanceId
        ? getCodexServiceTierOptionValue(input.modelSelection)
        : undefined;
    return yield* session.runtime
      .sendTurn({
        ...(input.clientUserMessageId ? { clientUserMessageId: input.clientUserMessageId } : {}),
        ...(input.input !== undefined ? { input: input.input } : {}),
        ...(input.modelSelection?.instanceId === boundInstanceId
          ? { model: input.modelSelection.model }
          : {}),
        ...(reasoningEffort
          ? {
              effort: reasoningEffort as EffectCodexSchema.V2TurnStartParams__ReasoningEffort,
            }
          : {}),
        ...(serviceTier ? { serviceTier } : {}),
        ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
        ...(codexAttachments.length > 0 ? { attachments: codexAttachments } : {}),
      })
      .pipe(Effect.mapError((cause) => mapCodexRuntimeError(input.threadId, "turn/start", cause)));
  });

  const requireSession = Effect.fn("requireSession")(function* (threadId: ThreadId) {
    const session = bindings.get(threadId);
    if (!session || session.stopped) {
      return yield* new ProviderAdapterSessionNotFoundError({
        provider: PROVIDER,
        threadId,
      });
    }
    return session;
  });

  const interruptTurn: CodexAdapterShape["interruptTurn"] = (threadId, turnId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.interruptTurn(turnId)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "turn/interrupt", cause),
      ),
    );

  const compactThread = Effect.fn("compactThread")(function* (threadId: ThreadId) {
    const session = yield* requireSession(threadId);
    yield* session.runtime.compactThread.pipe(
      Effect.mapError((cause) => mapCodexRuntimeError(threadId, "thread/compact/start", cause)),
    );
  });

  const readThread: CodexAdapterShape["readThread"] = (threadId) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.readThread),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/read", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );

  const rollbackThread: CodexAdapterShape["rollbackThread"] = (threadId, numTurns) => {
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      return Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "numTurns must be an integer >= 1.",
        }),
      );
    }

    return requireSession(threadId).pipe(
      Effect.flatMap((session) =>
        session.runtime.rollbackThread(numTurns).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              session.turnTokenUsage.baseline = undefined;
              session.turnTokenUsage.activeTurnId = undefined;
              session.turnTokenUsage.byTurnId.clear();
            }),
          ),
        ),
      ),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "thread/rollback", cause),
      ),
      Effect.map((snapshot) => ({
        threadId,
        turns: snapshot.turns,
      })),
    );
  };

  const uploadFeedback: CodexAdapterShape["uploadFeedback"] = (input) =>
    requireSession(input.threadId).pipe(
      Effect.flatMap((session) => session.runtime.uploadFeedback(input.reason)),
      Effect.map(({ threadId }) => ({ feedbackId: threadId })),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(input.threadId, "feedback/upload", cause),
      ),
    );

  const respondToRequest: CodexAdapterShape["respondToRequest"] = (threadId, requestId, decision) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToRequest(requestId, decision)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/requestApproval/decision", cause),
      ),
    );

  const respondToUserInput: CodexAdapterShape["respondToUserInput"] = (
    threadId,
    requestId,
    answers,
  ) =>
    requireSession(threadId).pipe(
      Effect.flatMap((session) => session.runtime.respondToUserInput(requestId, answers)),
      Effect.mapError((cause) =>
        cause._tag === "ProviderAdapterSessionNotFoundError"
          ? cause
          : mapCodexRuntimeError(threadId, "item/tool/requestUserInput", cause),
      ),
    );

  const writeNativeEvent = Effect.fnUntraced(function* (event: ProviderEvent) {
    if (!nativeEventLogger) {
      return;
    }
    yield* nativeEventLogger.write(event, event.threadId);
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    session: CodexAdapterSessionContext,
    options?: { readonly preserveNativeThread?: boolean },
  ) {
    if (session.stopped) {
      return;
    }
    session.stopped = true;
    bindings.delete(session.threadId);
    const closeRuntime =
      options?.preserveNativeThread === true
        ? (session.runtime.detach ?? session.runtime.close)
        : session.runtime.close;
    yield* closeRuntime.pipe(Effect.ignore);
    yield* Effect.ignore(Scope.close(session.scope, Exit.void));
    yield* Fiber.interrupt(session.eventFiber).pipe(Effect.ignore);
  });

  const stopSession: CodexAdapterShape["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      const session = bindings.get(threadId);
      if (!session) {
        return;
      }
      yield* stopSessionInternal(session);
    });

  const listSessions: CodexAdapterShape["listSessions"] = () =>
    Effect.forEach(
      Array.from(bindings.values()).filter((session) => !session.stopped),
      (session) =>
        Effect.gen(function* () {
          if (session.runtime.isConnected && !(yield* session.runtime.isConnected)) {
            return undefined;
          }
          return yield* session.runtime.getSession;
        }),
      { concurrency: 1 },
    ).pipe(Effect.map((sessions) => sessions.filter((session) => session !== undefined)));

  const hasSession: CodexAdapterShape["hasSession"] = (threadId) => {
    const session = bindings.get(threadId);
    if (!session || session.stopped) {
      return Effect.succeed(false);
    }
    return session.runtime.isConnected ?? Effect.succeed(true);
  };

  const stopAll: CodexAdapterShape["stopAll"] = () =>
    Effect.forEach(
      Array.from(bindings.values()),
      (session) => stopSessionInternal(session, { preserveNativeThread: true }),
      {
        concurrency: 1,
        discard: true,
      },
    ).pipe(Effect.asVoid);

  yield* Effect.acquireRelease(Effect.void, () =>
    stopAll().pipe(
      Effect.andThen(Queue.shutdown(runtimeEventQueue)),
      Effect.andThen(managedNativeEventLogger?.close() ?? Effect.void),
      Effect.ignore,
    ),
  );

  return {
    provider: PROVIDER,
    ...(storedThreadCatalog ? { storedThreadCatalog } : {}),
    capabilities: {
      sessionModelSwitch: "in-session",
      promptlessTurnContinuation: true,
    },
    startSession,
    sendTurn,
    compaction: { type: "native", start: compactThread },
    interruptTurn,
    readThread,
    rollbackThread,
    uploadFeedback,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    stopAll,
    get streamEvents() {
      return Stream.fromQueue(runtimeEventQueue);
    },
  } satisfies CodexAdapterShape;
});
