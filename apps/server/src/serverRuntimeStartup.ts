import {
  CommandId,
  CheckpointRef,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  EventId,
  type ModelSelection,
  ProviderDriverKind,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import { resolveProjectAutoPull } from "@t3tools/shared/serverSettings";
import {
  findCodexHistoryAssistantItemMatches,
  isCodexHistoryMessageId,
  isDuplicateCodexHistoryMessageForExisting,
} from "@t3tools/shared/codexMessageReconciliation";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as OrchestrationReactor from "./orchestration/Services/OrchestrationReactor.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ProviderSessionReaper from "./provider/Services/ProviderSessionReaper.ts";
import type { ProviderStoredThread } from "./provider/Services/ProviderAdapter.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as CheckpointDiffBlobRepository from "./persistence/Services/CheckpointDiffBlobs.ts";
import { forkParked } from "./serverActivation.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import {
  formatHeadlessServeOutput,
  formatHostForUrl,
  isWildcardHost,
  issueHeadlessServeAccessInfo,
} from "./startupAccess.ts";

export class ServerRuntimeStartupError extends Schema.TaggedError<ServerRuntimeStartupError>()(
  "ServerRuntimeStartupError",
  {
    mode: ServerConfig.RuntimeMode,
    host: Schema.NullOr(Schema.String),
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Server runtime startup failed before command readiness.";
  }
}

export class ServerRuntimeStartup extends Context.Service<
  ServerRuntimeStartup,
  {
    readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
    readonly markHttpListening: Effect.Effect<void>;
    readonly markRunningProviderSessionsForContinuation: Effect.Effect<
      ReadonlyArray<ThreadId>,
      ServerUpdateThreadContinuationError
    >;
    readonly clearProviderSessionContinuationMarkers: (
      threadIds: ReadonlyArray<ThreadId>,
    ) => Effect.Effect<void, ServerUpdateThreadContinuationError>;
    readonly enqueueCommand: <A, E>(
      effect: Effect.Effect<A, E>,
    ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
  }
>()("t3/serverRuntimeStartup") {}

interface QueuedCommand {
  readonly run: Effect.Effect<void, never>;
}

type CommandReadinessState = "pending" | "ready" | ServerRuntimeStartupError;

interface CommandGate {
  readonly awaitCommandReady: Effect.Effect<void, ServerRuntimeStartupError>;
  readonly signalCommandReady: Effect.Effect<void>;
  readonly failCommandReady: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
  readonly enqueueCommand: <A, E>(
    effect: Effect.Effect<A, E>,
  ) => Effect.Effect<A, E | ServerRuntimeStartupError>;
}

const settleQueuedCommand = <A, E>(deferred: Deferred.Deferred<A, E>, exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit)
    ? Deferred.succeed(deferred, exit.value)
    : Deferred.failCause(deferred, exit.cause);

export const makeCommandGate = Effect.gen(function* () {
  const commandReady = yield* Deferred.make<void, ServerRuntimeStartupError>();
  const commandQueue = yield* Queue.unbounded<QueuedCommand>();
  const commandReadinessState = yield* Ref.make<CommandReadinessState>("pending");

  const commandWorker = Effect.forever(
    Queue.take(commandQueue).pipe(Effect.flatMap((command) => command.run)),
  );
  yield* Effect.forkScoped(commandWorker);

  return {
    awaitCommandReady: Deferred.await(commandReady),
    signalCommandReady: Effect.gen(function* () {
      yield* Ref.set(commandReadinessState, "ready");
      yield* Deferred.succeed(commandReady, undefined).pipe(Effect.orDie);
    }),
    failCommandReady: (error) =>
      Effect.gen(function* () {
        yield* Ref.set(commandReadinessState, error);
        yield* Deferred.fail(commandReady, error).pipe(Effect.orDie);
      }),
    enqueueCommand: <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const readinessState = yield* Ref.get(commandReadinessState);
        if (readinessState === "ready") {
          return yield* effect;
        }
        if (readinessState !== "pending") {
          return yield* readinessState;
        }

        const result = yield* Deferred.make<A, E | ServerRuntimeStartupError>();
        yield* Queue.offer(commandQueue, {
          run: Deferred.await(commandReady).pipe(
            Effect.flatMap(() => effect),
            Effect.exit,
            Effect.flatMap((exit) => settleQueuedCommand(result, exit)),
          ),
        });
        return yield* Deferred.await(result);
      }),
  } satisfies CommandGate;
});

const recordStartupHeartbeat = Effect.gen(function* () {
  const analytics = yield* AnalyticsService.AnalyticsService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const { threadCount, projectCount } = yield* projectionSnapshotQuery.getCounts().pipe(
    Effect.catch((cause) =>
      Effect.logWarning("failed to gather startup projection counts for telemetry", {
        cause,
      }).pipe(
        Effect.as({
          threadCount: 0,
          projectCount: 0,
        }),
      ),
    ),
  );

  yield* analytics.record("server.boot.heartbeat", {
    threadCount,
    projectCount,
  });
});

const getAutoBootstrapThreadModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

export const resolveWelcomeBase = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const segments = serverConfig.cwd.split(/[/\\]/).filter(Boolean);
  const projectName = segments[segments.length - 1] ?? "project";

  return {
    cwd: serverConfig.cwd,
    projectName,
  } as const;
});

export const resolveAutoBootstrapWelcomeTargets = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const path = yield* Path.Path;

  let bootstrapProjectId: ProjectId | undefined;
  let bootstrapThreadId: ThreadId | undefined;
  let bootstrapProjectCreated = false;
  let bootstrapThreadCreated = false;

  if (serverConfig.autoBootstrapProjectFromCwd) {
    const settings = yield* (yield* ServerSettings.ServerSettingsService).getSettings;
    const defaultModelSelection =
      settings.defaultModelSelection ?? getAutoBootstrapThreadModelSelection();
    yield* Effect.gen(function* () {
      const existingProject = yield* projectionReadModelQuery.getActiveProjectByWorkspaceRoot(
        serverConfig.cwd,
      );
      let nextProjectId: ProjectId;
      let nextThreadModelSelection: ModelSelection;

      if (Option.isNone(existingProject)) {
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        nextProjectId = ProjectId.make(yield* randomUUID);
        const bootstrapProjectTitle = path.basename(serverConfig.cwd) || "project";
        nextThreadModelSelection = defaultModelSelection;
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* randomUUID),
          projectId: nextProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: serverConfig.cwd,
          createdAt,
        });
        bootstrapProjectId = nextProjectId;
        bootstrapProjectCreated = true;
      } else {
        nextProjectId = existingProject.value.id;
        bootstrapProjectId = nextProjectId;
        nextThreadModelSelection =
          existingProject.value.defaultModelSelection ?? defaultModelSelection;
      }

      yield* Effect.gen(function* () {
        const existingThreadId =
          yield* projectionReadModelQuery.getFirstActiveThreadIdByProjectId(nextProjectId);
        if (Option.isNone(existingThreadId)) {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const createdThreadId = ThreadId.make(yield* randomUUID);
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* randomUUID),
            threadId: createdThreadId,
            projectId: nextProjectId,
            title: "New thread",
            modelSelection: nextThreadModelSelection,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            runtimeMode: "full-access",
            branch: null,
            worktreePath: null,
            createdAt,
          });
          bootstrapThreadId = createdThreadId;
          bootstrapThreadCreated = true;
        } else {
          bootstrapThreadId = existingThreadId.value;
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("startup thread auto-bootstrap failed", {
                bootstrapProjectId: nextProjectId,
                cause,
              }),
        ),
      );
    });
  }

  return {
    ...(bootstrapProjectId ? { bootstrapProjectId } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadId } : {}),
    ...(bootstrapProjectId ? { bootstrapProjectCreated } : {}),
    ...(bootstrapThreadId ? { bootstrapThreadCreated } : {}),
  } as const;
});

export const completeAutoBootstrapWelcome = <A extends object, E, R>(
  bootstrap: Effect.Effect<A, E, R>,
) =>
  bootstrap.pipe(
    Effect.matchCauseEffect({
      onFailure: (cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("startup auto-bootstrap failed", { cause }).pipe(
              Effect.as({ bootstrapStatus: "complete" as const }),
            ),
      onSuccess: (targets) =>
        Effect.succeed({
          ...targets,
          bootstrapStatus: "complete" as const,
        }),
    }),
  );

const resolveStartupBrowserTarget = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const localUrl = `http://localhost:${serverConfig.port}`;
  const bindUrl =
    serverConfig.host && !isWildcardHost(serverConfig.host)
      ? `http://${formatHostForUrl(serverConfig.host)}:${serverConfig.port}`
      : localUrl;
  const baseTarget = serverConfig.devUrl?.toString() ?? bindUrl;
  return yield* Effect.succeed(serverConfig.mode === "desktop" ? baseTarget : undefined).pipe(
    Effect.flatMap((target) =>
      target ? Effect.succeed(target) : serverAuth.issueStartupPairingUrl(baseTarget),
    ),
  );
});

const maybeOpenBrowser = (target: string) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    if (serverConfig.noBrowser) {
      return;
    }
    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    yield* externalLauncher.launchBrowser(target).pipe(
      Effect.catch(() =>
        Effect.logInfo("browser auto-open unavailable", {
          hint: `Open ${target} in your browser.`,
        }),
      ),
    );
  });

const runStartupPhase = <A, E, R>(phase: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.annotateSpans({ "startup.phase": phase }),
    Effect.withSpan(`server.startup.${phase}`),
  );

const ORPHANED_PROVIDER_SESSION_ERROR =
  "Provider session did not survive a server restart. Send a new message to continue.";
const SERVER_UPDATE_CONTINUATION_KEY = "continueAfterServerUpdate";
const SERVER_UPDATE_CONTINUATION_PROMPT = "Continue where you left off.";

class ProviderSessionContinuationError extends Schema.TaggedError<ProviderSessionContinuationError>()(
  "ProviderSessionContinuationError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Could not continue thread '${this.threadId}': the provider instance is missing.`;
  }
}

export class ServerUpdateThreadContinuationError extends Schema.TaggedError<ServerUpdateThreadContinuationError>()(
  "ServerUpdateThreadContinuationError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not prepare running threads to continue after the update.";
  }
}

function hasServerUpdateContinuationMarker(
  runtimePayload: unknown,
): runtimePayload is Record<string, unknown> {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    SERVER_UPDATE_CONTINUATION_KEY in runtimePayload
  );
}

function readRuntimePayload(runtimePayload: unknown): Record<string, unknown> {
  return runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload)
    ? (runtimePayload as Record<string, unknown>)
    : {};
}

const isServerUpdateThreadContinuationError = Schema.is(ServerUpdateThreadContinuationError);

function readServerUpdateContinuationTurnId(runtimePayload: unknown): TurnId | null {
  if (!hasServerUpdateContinuationMarker(runtimePayload)) {
    return null;
  }
  const value = runtimePayload[SERVER_UPDATE_CONTINUATION_KEY];
  return typeof value === "string" && value.length > 0 ? TurnId.make(value) : null;
}

const toServerUpdateThreadContinuationError = (cause: unknown) =>
  isServerUpdateThreadContinuationError(cause)
    ? cause
    : new ServerUpdateThreadContinuationError({ cause });

export const markRunningProviderSessionsForContinuation = Effect.gen(function* () {
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const { threads } = yield* query.getCommandReadModel();
  const running = threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.session?.status === "running" &&
      thread.session.activeTurnId !== null,
  );

  const marked: ThreadId[] = [];
  return yield* Effect.gen(function* () {
    for (const thread of running) {
      const activeTurnId = thread.session?.activeTurnId;
      if (activeTurnId === null || activeTurnId === undefined) {
        continue;
      }
      const binding = yield* directory.getBinding(thread.id);
      if (Option.isNone(binding)) {
        continue;
      }
      if (binding.value.resumeCursor === null || binding.value.resumeCursor === undefined) {
        continue;
      }
      yield* directory.upsert({
        ...binding.value,
        runtimePayload: {
          ...readRuntimePayload(binding.value.runtimePayload),
          [SERVER_UPDATE_CONTINUATION_KEY]: activeTurnId,
          continueAfterServerUpdatePrepared: null,
        },
      });
      marked.push(thread.id);
    }
    return marked;
  }).pipe(
    Effect.catchCause((cause) =>
      clearProviderSessionContinuationMarkers(marked).pipe(Effect.andThen(Effect.failCause(cause))),
    ),
  );
}).pipe(Effect.mapError(toServerUpdateThreadContinuationError));

const clearContinuationMarkers = (
  directory: ProviderSessionDirectory.ProviderSessionDirectory["Service"],
  threadIds: ReadonlyArray<ThreadId>,
) =>
  Effect.forEach(
    threadIds,
    (threadId) =>
      directory.getBinding(threadId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (binding) =>
              directory.upsert({
                ...binding,
                runtimePayload: {
                  ...readRuntimePayload(binding.runtimePayload),
                  [SERVER_UPDATE_CONTINUATION_KEY]: null,
                  continueAfterServerUpdatePrepared: null,
                },
              }),
          }),
        ),
      ),
    { concurrency: "unbounded", discard: true },
  );

const clearProviderSessionContinuationMarkers = (threadIds: ReadonlyArray<ThreadId>) =>
  Effect.gen(function* () {
    const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    yield* clearContinuationMarkers(directory, threadIds);
  }).pipe(Effect.mapError(toServerUpdateThreadContinuationError));

export const reconcileProviderSessions = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const providerService = yield* ProviderService.ProviderService;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settings = yield* ServerSettings.ServerSettingsService;
  const continueAfterRestart = yield* settings.getSettings.pipe(
    Effect.map((value) => value.continueThreadsAfterServerUpdate),
    Effect.catch((cause) =>
      Effect.logWarning("could not read restart continuation preference", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const { threads } = yield* query.getCommandReadModel();
  // Provider startup can report ready before the continuation is submitted.
  // Find those markers in one read rather than querying every idle thread.
  const preparedThreadIds = new Set(
    (yield* directory.listBindings().pipe(
      Effect.catch((cause) =>
        Effect.logWarning("failed to read prepared provider continuations", { cause }).pipe(
          Effect.andThen(
            Effect.forEach(
              threads.filter(
                (thread) => thread.session?.status === "ready" && !liveThreadIds.has(thread.id),
              ),
              (thread) =>
                directory.getBinding(thread.id).pipe(Effect.orElseSucceed(() => Option.none())),
            ),
          ),
          Effect.map((bindings) =>
            bindings.flatMap((binding) => (Option.isSome(binding) ? [binding.value] : [])),
          ),
        ),
      ),
    ))
      .filter(
        (binding) =>
          readServerUpdateContinuationTurnId(binding.runtimePayload) !== null &&
          readRuntimePayload(binding.runtimePayload).activeTurnId === null &&
          readRuntimePayload(binding.runtimePayload).continueAfterServerUpdatePrepared === true,
      )
      .map((binding) => binding.threadId),
  );
  const orphanedThreads = threads.filter(
    (thread) =>
      thread.session !== null &&
      (thread.session.status === "starting" ||
        thread.session.status === "running" ||
        thread.session.activeTurnId !== null ||
        (thread.session.status === "ready" && preparedThreadIds.has(thread.id))) &&
      !liveThreadIds.has(thread.id),
  );

  for (const thread of orphanedThreads) {
    const session = thread.session;
    if (session === null) {
      continue;
    }
    const binding = yield* directory.getBinding(thread.id).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("failed to read orphaned provider session directory binding", {
              threadId: thread.id,
              cause,
            }).pipe(Effect.as(Option.none())),
      ),
    );
    const continuationMarkerPresent =
      Option.isSome(binding) && hasServerUpdateContinuationMarker(binding.value.runtimePayload);
    const continuationTurnId = Option.isSome(binding)
      ? readServerUpdateContinuationTurnId(binding.value.runtimePayload)
      : null;
    const continuationMarked =
      continuationTurnId !== null &&
      (session.activeTurnId === null || continuationTurnId === session.activeTurnId) &&
      Option.isSome(binding) &&
      (session.activeTurnId !== null ||
        readRuntimePayload(binding.value.runtimePayload).activeTurnId == null ||
        readRuntimePayload(binding.value.runtimePayload).activeTurnId === continuationTurnId);
    const preparedWhileReady =
      session.status === "ready" &&
      session.activeTurnId === null &&
      continuationMarked &&
      Option.isSome(binding) &&
      readRuntimePayload(binding.value.runtimePayload).activeTurnId === null &&
      readRuntimePayload(binding.value.runtimePayload).continueAfterServerUpdatePrepared === true;
    // Runtime events advance the projection's turn, but not the directory's
    // last admitted turn. Use the projection to identify interrupted work.
    const interruptedByRestart =
      continueAfterRestart &&
      session.status === "running" &&
      session.activeTurnId !== null &&
      Option.isSome(binding) &&
      binding.value.status === "running" &&
      binding.value.resumeCursor != null;
    const settleAsError = (lastError: string) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          if (Option.isSome(binding)) {
            yield* directory.upsert({
              ...binding.value,
              status: "stopped",
              runtimePayload: {
                ...readRuntimePayload(binding.value.runtimePayload),
                activeTurnId: null,
                ...(continuationMarkerPresent || interruptedByRestart
                  ? {
                      [SERVER_UPDATE_CONTINUATION_KEY]: null,
                      continueAfterServerUpdatePrepared: null,
                    }
                  : {}),
              },
            });
          }
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning(
                  "failed to reconcile orphaned provider session directory binding",
                  { threadId: thread.id, cause },
                ),
          ),
        );

        yield* Effect.gen(function* () {
          const reconciledAt = DateTime.formatIso(yield* DateTime.now);
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId: thread.id,
            session: {
              ...session,
              status: "error",
              activeTurnId: null,
              lastError,
              updatedAt: reconciledAt,
            },
            createdAt: reconciledAt,
          });
        }).pipe(
          Effect.retry({ times: 1 }),
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("failed to settle orphaned provider session projection", {
                  threadId: thread.id,
                  cause,
                }),
          ),
        );
      });

    if (
      Option.isSome(binding) &&
      (continuationMarked || interruptedByRestart) &&
      (session.status === "running" || session.status === "starting" || preparedWhileReady) &&
      binding.value.resumeCursor != null &&
      thread.archivedAt === null &&
      thread.deletedAt === null
    ) {
      const prepared = yield* Effect.gen(function* () {
        yield* directory.upsert({
          ...binding.value,
          status: "starting",
          runtimePayload: {
            ...readRuntimePayload(binding.value.runtimePayload),
            // Keep recovery durable if this process also exits before sending.
            [SERVER_UPDATE_CONTINUATION_KEY]: session.activeTurnId ?? continuationTurnId,
            continueAfterServerUpdatePrepared: true,
            activeTurnId: null,
          },
        });
        const resumedAt = DateTime.formatIso(yield* DateTime.now);
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId: thread.id,
          session: {
            ...session,
            status: "starting",
            activeTurnId: null,
            lastError: null,
            updatedAt: resumedAt,
          },
          createdAt: resumedAt,
        });
      }).pipe(Effect.retry({ times: 1 }), Effect.exit);
      if (Exit.isFailure(prepared)) {
        if (Cause.hasInterrupts(prepared.cause)) {
          return yield* Effect.failCause(prepared.cause);
        }
        yield* Effect.logWarning("failed to prepare provider session continuation", {
          threadId: thread.id,
          cause: prepared.cause,
        });
        yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
        continue;
      }

      yield* forkParked(
        Effect.gen(function* () {
          const continuation = Effect.gen(function* () {
            const providerInstanceId = binding.value.providerInstanceId;
            if (providerInstanceId === undefined) {
              return yield* new ProviderSessionContinuationError({
                threadId: thread.id,
              });
            }
            const capabilities = yield* providerService.getCapabilities(providerInstanceId);
            yield* providerService.sendTurn({
              threadId: thread.id,
              ...(capabilities.promptlessTurnContinuation === true
                ? { continuation: true }
                : { input: SERVER_UPDATE_CONTINUATION_PROMPT }),
              interactionMode: thread.interactionMode,
            });
          });
          const continuationExit = yield* Effect.exit(continuation);
          if (Exit.isSuccess(continuationExit) || Cause.hasInterrupts(continuationExit.cause)) {
            if (Exit.isSuccess(continuationExit)) {
              yield* clearContinuationMarkers(directory, [thread.id]).pipe(
                Effect.uninterruptible,
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to clear completed provider session continuation", {
                    threadId: thread.id,
                    cause,
                  }),
                ),
              );
            }
            return;
          }
          yield* Effect.logWarning("failed to continue provider session after server restart", {
            threadId: thread.id,
            cause: continuationExit.cause,
          });
          yield* settleAsError(
            "Could not continue this thread after the server restart. Send a new message to continue.",
          ).pipe(Effect.ignoreCause);
        }),
      );
      continue;
    }

    yield* settleAsError(ORPHANED_PROVIDER_SESSION_ERROR);
  }
}).pipe(
  Effect.catchCause((cause) =>
    Cause.hasInterrupts(cause)
      ? Effect.failCause(cause)
      : Effect.logWarning("provider session startup reconciliation failed", { cause }),
  ),
);

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CODEX_APP_SERVER_THREAD_SYNC_INTERVAL = "5 seconds" as const;
// A binding written before the paginated App Server history bridge was
// deployed cannot tell startup reconciliation that its projection contains a
// complete native history.  Keep this marker in the provider runtime payload
// so the first post-deployment pass repairs existing projections once, while
// later catalog passes remain lightweight.
export const CODEX_NATIVE_HISTORY_SYNC_VERSION = "paginated-v8-native-item-repair" as const;
// The projection repair changes derived rows without appending a compensating
// domain event. A client that resumes from a pre-repair cursor would therefore
// keep its stale rows and replay the old live+history pair. Persist the
// authoritative event-store watermark alongside the marker so the thread
// subscription can send one clean snapshot to such clients.
export const CODEX_NATIVE_HISTORY_SYNC_SEQUENCE_KEY = "nativeHistorySyncSequence" as const;

export function readCodexNativeHistorySyncSequence(runtimePayload: unknown): number | undefined {
  const value = readRuntimePayload(runtimePayload)[CODEX_NATIVE_HISTORY_SYNC_SEQUENCE_KEY];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const isProviderDiffRef = (ref: CheckpointRef): boolean => String(ref).startsWith("provider-diff:");

interface CodexThreadSyncState {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  title: string;
  readonly modelSelection: OrchestrationThread["modelSelection"];
  readonly runtimeMode: OrchestrationThread["runtimeMode"];
  readonly interactionMode: OrchestrationThread["interactionMode"];
  readonly latestTurn: OrchestrationThread["latestTurn"];
  readonly session: OrchestrationThread["session"];
  archivedAt: OrchestrationThread["archivedAt"];
  readonly deletedAt: OrchestrationThread["deletedAt"];
  readonly messageIds: Set<string>;
}

interface CodexProjectSyncState {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

interface CodexNativeBinding {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId | undefined;
  readonly persisted: ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata;
}

function readCodexResumeThreadId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const threadId = (value as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId.trim() : undefined;
}

function hasCodexNativeSettingsMarker(runtimePayload: unknown): boolean {
  return readRuntimePayload(runtimePayload).preserveProviderSettingsOnResume === true;
}

function readCodexNativeUpdatedAt(runtimePayload: unknown): string | undefined {
  const value = readRuntimePayload(runtimePayload).nativeUpdatedAt;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function hasCodexNativeHistorySyncMarker(runtimePayload: unknown): boolean {
  return (
    readRuntimePayload(runtimePayload).nativeHistorySyncVersion ===
    CODEX_NATIVE_HISTORY_SYNC_VERSION
  );
}

function codexWorkspaceKey(workspaceRoot: string): string {
  return normalizeProjectPathForComparison(workspaceRoot);
}

function makeCodexThreadSyncState(thread: OrchestrationThread): CodexThreadSyncState {
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    latestTurn: thread.latestTurn,
    session: thread.session,
    archivedAt: thread.archivedAt,
    deletedAt: thread.deletedAt,
    messageIds: new Set(thread.messages.map((message) => String(message.id))),
  };
}

function codexProjectionThreadId(
  nativeThreadId: string,
  persistedBinding: CodexNativeBinding | undefined,
  threadsById: ReadonlyMap<ThreadId, CodexThreadSyncState>,
): ThreadId {
  if (persistedBinding !== undefined) {
    // The native id is the durable owner of a Codex session. Bindings written
    // by the first bridge could point at an arbitrary T3 UUID, which made the
    // compatibility projection show that stale shell instead of Codex's
    // canonical thread. Keep canonical ids stable and let the sync pass move
    // the old binding/shell below.
    return ThreadId.make(`codex:${nativeThreadId}`);
  }

  // Older versions of this bridge used the native id directly for imported
  // threads. Reuse that id only when the existing projection already looks
  // like a Codex import; otherwise namespace new ids so a UUID collision
  // cannot make a Codex catalog entry overwrite another provider's thread.
  const legacyThreadId = ThreadId.make(nativeThreadId);
  const legacyThread = threadsById.get(legacyThreadId);
  const hasLegacyCodexMessage =
    legacyThread !== undefined &&
    Array.from(legacyThread.messageIds).some((messageId) =>
      messageId.startsWith(`import:codex:${nativeThreadId}:`),
    );
  if (legacyThread?.session?.providerName === "codex" || hasLegacyCodexMessage) {
    return legacyThreadId;
  }

  return ThreadId.make(`codex:${nativeThreadId}`);
}

/**
 * Reconcile Codex's durable thread catalog into T3's compatibility projection.
 *
 * Codex owns the native thread and its durable history. T3 receives only the
 * normalized text history needed by existing clients; active native threads
 * are resumed through ProviderService so the normal provider event ingestion
 * path remains the single realtime projection writer.
 */
export const syncCodexAppServerThreads = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerService = yield* ProviderService.ProviderService;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const checkpointStore = yield* Effect.serviceOption(CheckpointStore.CheckpointStore);
  const providerDiffBlobRepository = yield* Effect.serviceOption(
    CheckpointDiffBlobRepository.CheckpointDiffBlobRepository,
  );

  const readModel = yield* query.getCommandReadModel();
  const serverSettings = yield* settings.getSettings;
  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => session.threadId),
  );
  const deletedThreadIds = new Set<ThreadId>();
  const threadsById = new Map<ThreadId, CodexThreadSyncState>();
  for (const thread of readModel.threads) {
    if (thread.deletedAt !== null) {
      deletedThreadIds.add(thread.id);
    } else {
      threadsById.set(thread.id, makeCodexThreadSyncState(thread));
    }
  }

  const hydratePersistedMessageIds = (thread: CodexThreadSyncState, force = false) => {
    const getThreadMessageIds = query.getThreadMessageIds;
    if (getThreadMessageIds === undefined || (!force && thread.messageIds.size > 0)) {
      return Effect.succeed(thread);
    }
    return getThreadMessageIds(thread.id).pipe(
      Effect.map((messageIds) => {
        if (messageIds.length === 0) {
          return thread;
        }
        const hydrated = {
          ...thread,
          messageIds: new Set(messageIds.map(String)),
        } satisfies CodexThreadSyncState;
        threadsById.set(thread.id, hydrated);
        return hydrated;
      }),
    );
  };

  const projectsByWorkspace = new Map<string, CodexProjectSyncState>();
  for (const project of readModel.projects) {
    if (project.deletedAt === null) {
      projectsByWorkspace.set(codexWorkspaceKey(project.workspaceRoot), {
        id: project.id,
        title: project.title,
        workspaceRoot: project.workspaceRoot,
      });
    }
  }

  const bindings = yield* directory.listBindings().pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.logWarning("could not read Codex thread bindings during catalog sync", {
            cause,
          }).pipe(Effect.as([])),
    ),
  );
  const nativeBindings = new Map<string, CodexNativeBinding>();
  for (const binding of bindings) {
    if (binding.provider !== CODEX_DRIVER) {
      continue;
    }
    const nativeThreadId = readCodexResumeThreadId(binding.resumeCursor);
    if (nativeThreadId === undefined) {
      continue;
    }
    const existing = nativeBindings.get(nativeThreadId);
    if (
      existing === undefined ||
      (existing.providerInstanceId === undefined && binding.providerInstanceId !== undefined)
    ) {
      nativeBindings.set(nativeThreadId, {
        threadId: binding.threadId,
        providerInstanceId: binding.providerInstanceId,
        persisted: binding,
      });
    }
  }

  const ensureProject = (workspaceRoot: string) => {
    const key = codexWorkspaceKey(workspaceRoot);
    const existing = projectsByWorkspace.get(key);
    if (existing !== undefined) {
      return Effect.succeed(existing);
    }

    return Effect.gen(function* () {
      const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
      const title = path.basename(workspaceRoot) || "Codex";
      yield* orchestrationEngine.dispatch({
        type: "project.create",
        commandId: CommandId.make(yield* crypto.randomUUIDv4),
        projectId,
        title,
        workspaceRoot,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      });
      const project = { id: projectId, title, workspaceRoot } satisfies CodexProjectSyncState;
      projectsByWorkspace.set(key, project);
      return project;
    });
  };

  const modelForInstance = (instanceId: ProviderInstanceId): ModelSelection =>
    serverSettings.defaultModelSelection?.instanceId === instanceId
      ? serverSettings.defaultModelSelection
      : { instanceId, model: DEFAULT_MODEL };

  const syncProviderTurnDiffs = (threadId: ThreadId, sourceThread: ProviderStoredThread) =>
    Effect.gen(function* () {
      if (Option.isNone(providerDiffBlobRepository) || sourceThread.turnDiffs === undefined) {
        return;
      }
      const getThreadCheckpointContext = query.getThreadCheckpointContext;
      if (typeof getThreadCheckpointContext !== "function") {
        return;
      }

      const checkpointContext = yield* getThreadCheckpointContext(threadId);
      const existingCheckpoints = Option.isSome(checkpointContext)
        ? checkpointContext.value.checkpoints
        : [];
      const hasNonReadyCheckpoint = existingCheckpoints.some(
        (checkpoint) => checkpoint.status !== "ready",
      );
      const checkpointsByTurnId = new Map(
        existingCheckpoints.map((checkpoint) => [checkpoint.turnId, checkpoint]),
      );
      const matchedCheckpointTurnIds = new Set<string>();
      let nextCheckpointTurnCount = existingCheckpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );

      for (const turnDiff of sourceThread.turnDiffs.toSorted((left, right) =>
        left.completedAt.localeCompare(right.completedAt),
      )) {
        const exact = checkpointsByTurnId.get(turnDiff.turnId);
        const nativeCompletedAt = Date.parse(turnDiff.completedAt);
        const timeCandidates = Number.isFinite(nativeCompletedAt)
          ? existingCheckpoints
              .filter((checkpoint) => !matchedCheckpointTurnIds.has(String(checkpoint.turnId)))
              .map((checkpoint) => ({
                checkpoint,
                distance: Math.abs(Date.parse(checkpoint.completedAt) - nativeCompletedAt),
              }))
              .filter(
                (candidate) =>
                  Number.isFinite(candidate.distance) && candidate.distance <= 15 * 60 * 1000,
              )
              .toSorted((left, right) => {
                if (left.distance !== right.distance) {
                  return left.distance - right.distance;
                }
                return (
                  Number(left.checkpoint.status === "ready") -
                  Number(right.checkpoint.status === "ready")
                );
              })
          : [];
        const closestTimeMatch =
          timeCandidates.length > 0 &&
          (timeCandidates.length === 1 || timeCandidates[0]!.distance < timeCandidates[1]!.distance)
            ? timeCandidates[0]!.checkpoint
            : undefined;
        const existing =
          (exact !== undefined && !matchedCheckpointTurnIds.has(String(exact.turnId))
            ? exact
            : undefined) ?? closestTimeMatch;
        if (existing !== undefined) {
          matchedCheckpointTurnIds.add(String(existing.turnId));
        }
        const checkpointTurnCount = existing?.checkpointTurnCount ?? ++nextCheckpointTurnCount;

        const completedAt = turnDiff.completedAt;
        const checkpointTurnId = existing?.turnId ?? turnDiff.turnId;
        const assistantMessageId = existing?.assistantMessageId ?? turnDiff.assistantMessageId;
        const existingAssistantMessageId = existing?.assistantMessageId ?? undefined;
        const checkpointStatus = turnDiff.status ?? "ready";
        const blobStatus = checkpointStatus === "missing" ? "preview" : "final";
        const fromTurnCount = Math.max(0, checkpointTurnCount - 1);
        const existingBlob = yield* providerDiffBlobRepository.value.get({
          threadId,
          fromTurnCount,
          toTurnCount: checkpointTurnCount,
        });
        const hasCurrentBlob =
          Option.isSome(existingBlob) &&
          existingBlob.value.status === blobStatus &&
          existingBlob.value.diff === turnDiff.diff;
        if (existing?.status === "ready") {
          // Keep real Git and already-repaired provider checkpoints
          // authoritative, but retain the native patch as a recovery source
          // for a later mixed Git/provider range.
          if (hasNonReadyCheckpoint && checkpointStatus === "ready" && !hasCurrentBlob) {
            yield* providerDiffBlobRepository.value.upsert({
              threadId,
              fromTurnCount,
              toTurnCount: checkpointTurnCount,
              diff: turnDiff.diff,
              createdAt: completedAt,
              status: blobStatus,
            });
          }
          continue;
        }
        if (
          existing !== undefined &&
          !isProviderDiffRef(existing.checkpointRef) &&
          hasCurrentBlob
        ) {
          continue;
        }
        const hasCurrentPreview =
          existing !== undefined &&
          existing.status === checkpointStatus &&
          existingAssistantMessageId === assistantMessageId &&
          hasCurrentBlob;
        if (hasCurrentPreview) {
          continue;
        }
        yield* providerDiffBlobRepository.value.upsert({
          threadId,
          fromTurnCount,
          toTurnCount: checkpointTurnCount,
          diff: turnDiff.diff,
          createdAt: completedAt,
          status: blobStatus,
        });
        if (existing !== undefined && !isProviderDiffRef(existing.checkpointRef)) {
          // Keep a real Git checkpoint ref and its existing projection row;
          // the provider blob is a read-only recovery source for missing or
          // errored rows, not permission to replace Git history.
          continue;
        }
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId,
          // Keep the projection's turn/message identity when repairing a
          // legacy placeholder whose native App Server turn id changed.
          turnId: checkpointTurnId,
          completedAt,
          checkpointRef: CheckpointRef.make(`provider-diff:${threadId}:${turnDiff.turnId}`),
          status: checkpointStatus,
          files: turnDiff.files,
          ...(assistantMessageId ? { assistantMessageId } : {}),
          checkpointTurnCount,
          createdAt: completedAt,
        });
      }
    });

  const deleteBinding = directory.deleteBinding;

  const claimedNativeThreadIds = new Map<string, ProviderInstanceId>();
  const availableInstances = yield* instances.listInstances;
  for (const instance of availableInstances) {
    if (instance.driverKind !== CODEX_DRIVER || !instance.enabled) {
      continue;
    }
    const catalog = instance.adapter.storedThreadCatalog;
    if (catalog === undefined) {
      continue;
    }

    const storedThreads = yield* catalog.listStoredThreads().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("could not list Codex App Server threads", {
              providerInstanceId: instance.instanceId,
              cause,
            }).pipe(Effect.as([])),
      ),
    );

    for (const listedThread of storedThreads) {
      const nativeThreadId = listedThread.nativeThreadId.trim();
      if (nativeThreadId.length === 0 || listedThread.ephemeral || listedThread.subAgent) {
        continue;
      }

      const persistedBinding = nativeBindings.get(nativeThreadId);
      if (
        persistedBinding?.providerInstanceId !== undefined &&
        persistedBinding.providerInstanceId !== instance.instanceId
      ) {
        continue;
      }
      const claimedBy = claimedNativeThreadIds.get(nativeThreadId);
      if (claimedBy !== undefined && claimedBy !== instance.instanceId) {
        continue;
      }
      claimedNativeThreadIds.set(nativeThreadId, instance.instanceId);

      yield* Effect.gen(function* () {
        // The command read model intentionally omits message bodies. Hydrate
        // ids only for an existing legacy-id candidate before resolving the
        // projection id, so old Codex imports remain addressable without
        // loading every thread history during the recurring catalog pass.
        const legacyThreadId = ThreadId.make(nativeThreadId);
        const legacyThread = threadsById.get(legacyThreadId);
        if (legacyThread !== undefined) {
          yield* hydratePersistedMessageIds(legacyThread);
        }

        const threadId = codexProjectionThreadId(nativeThreadId, persistedBinding, threadsById);
        const nativeUpdatedAtChanged =
          persistedBinding !== undefined &&
          readCodexNativeUpdatedAt(persistedBinding.persisted.runtimePayload) !==
            listedThread.updatedAt;
        const migratedFromThreadId =
          persistedBinding !== undefined && persistedBinding.threadId !== threadId
            ? persistedBinding.threadId
            : undefined;
        if (deletedThreadIds.has(threadId)) {
          return;
        }

        let thread = threadsById.get(threadId);
        // A shell that looks empty can still represent an existing thread
        // whose event-sourced state was replayed incompletely. Never send the
        // non-reconcile import to such a projection: the decider quite
        // correctly rejects it once it sees the durable thread history.
        const isNewProjectionThread = thread === undefined;
        if (thread !== undefined) {
          thread = yield* hydratePersistedMessageIds(thread, nativeUpdatedAtChanged);
        }
        const canSyncProviderDiffs =
          Option.isSome(providerDiffBlobRepository) &&
          Option.isSome(checkpointStore) &&
          (yield* checkpointStore.value.isGitRepository(listedThread.cwd));
        const checkpointContext =
          canSyncProviderDiffs &&
          thread !== undefined &&
          typeof query.getThreadCheckpointContext === "function"
            ? yield* query.getThreadCheckpointContext(threadId)
            : Option.none();
        const needsNativeDiffRead =
          canSyncProviderDiffs &&
          Option.isSome(checkpointContext) &&
          checkpointContext.value.checkpoints.some((checkpoint) => checkpoint.status !== "ready");
        const needsHistoryRead =
          thread === undefined ||
          persistedBinding === undefined ||
          (thread.messageIds.size === 0 && thread.latestTurn === null && thread.session === null) ||
          nativeUpdatedAtChanged ||
          !hasCodexNativeHistorySyncMarker(persistedBinding?.persisted.runtimePayload) ||
          needsNativeDiffRead;
        // A resumed app-server subscription does not replay turn/started. Read
        // the native thread once when it is active but not currently attached
        // so the runtime can restore the in-progress turn before the reaper
        // sees an apparently idle T3 session.
        const needsActiveTurnRead =
          listedThread.active && !listedThread.archived && !liveThreadIds.has(threadId);
        const storedThread =
          needsHistoryRead || needsActiveTurnRead
            ? yield* catalog.readStoredThread({
                nativeThreadId,
                archived: listedThread.archived,
              })
            : undefined;
        const sourceThread = storedThread ?? listedThread;

        // A server restart can leave the event-sourced projection carrying a
        // running/error session even though Codex reports the native thread
        // idle. Codex owns that status, so clear the orphaned T3 session
        // without asking the client to send a recovery message.
        const session = thread?.session;
        const shouldReconcileIdleSession =
          session !== null &&
          session !== undefined &&
          !liveThreadIds.has(threadId) &&
          sourceThread.activeTurnId === undefined &&
          (session.activeTurnId !== null ||
            session.status === "starting" ||
            session.status === "running" ||
            session.status === "error" ||
            session.lastError !== null);
        if (shouldReconcileIdleSession && session !== undefined && session !== null) {
          const reconciledAt = DateTime.formatIso(yield* DateTime.now);
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            session: {
              ...session,
              status: "stopped",
              activeTurnId: null,
              lastError: null,
              updatedAt: reconciledAt,
            },
            createdAt: reconciledAt,
          });
        }

        const projectedMessageSummaries =
          thread !== undefined &&
          needsHistoryRead &&
          typeof query.getThreadMessageSummaries === "function"
            ? yield* query.getThreadMessageSummaries(threadId)
            : [];
        const projectedMessageIdentities = projectedMessageSummaries.map((message) => ({
          messageId: String(message.id),
          role: message.role,
          text: message.text,
          createdAt: message.createdAt,
          turnId: message.turnId,
          phase: message.phase,
        }));
        const projectedMessagesById = new Map(
          projectedMessageIdentities.map((message) => [message.messageId, message]),
        );

        const projectedNativeActivityKeys =
          thread !== undefined &&
          needsHistoryRead &&
          sourceThread.activities !== undefined &&
          sourceThread.activities.length > 0
            ? typeof query.getThreadNativeActivityKeys === "function"
              ? yield* query.getThreadNativeActivityKeys(threadId)
              : yield* query.getThreadDetailById(threadId).pipe(
                  Effect.map((detail) =>
                    Option.isSome(detail)
                      ? detail.value.activities.map((activity) => {
                          const payload =
                            typeof activity.payload === "object" && activity.payload !== null
                              ? (activity.payload as { readonly toolCallId?: unknown })
                              : undefined;
                          return {
                            id: activity.id,
                            kind: activity.kind,
                            turnId: activity.turnId,
                            createdAt: activity.createdAt,
                            toolCallId:
                              typeof payload?.toolCallId === "string" ? payload.toolCallId : null,
                          };
                        })
                      : [],
                  ),
                )
            : [];

        if (thread === undefined) {
          const project = yield* ensureProject(sourceThread.cwd);
          const createdAt = sourceThread.createdAt;
          const modelSelection = modelForInstance(instance.instanceId);
          yield* orchestrationEngine.dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            projectId: project.id,
            title: sourceThread.title,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt,
            ...(sourceThread.messages.length > 0 ? { historyImport: true } : {}),
          });
          thread = {
            id: threadId,
            projectId: project.id,
            title: sourceThread.title,
            modelSelection,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            latestTurn: null,
            session: null,
            archivedAt: null,
            deletedAt: null,
            messageIds: new Set<string>(),
          };
          threadsById.set(threadId, thread);
        }

        if (
          sourceThread.activeTurnId !== undefined &&
          (thread.session?.status !== "running" ||
            thread.session?.activeTurnId !== sourceThread.activeTurnId)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            session: {
              threadId,
              status: "running",
              providerName: CODEX_DRIVER,
              providerInstanceId: instance.instanceId,
              runtimeMode: thread.runtimeMode,
              activeTurnId: sourceThread.activeTurnId,
              lastError: null,
              updatedAt: sourceThread.updatedAt,
            },
            createdAt: sourceThread.updatedAt,
          });
        }

        if (storedThread !== undefined && canSyncProviderDiffs) {
          yield* syncProviderTurnDiffs(threadId, storedThread);
        }

        const missingMessages = sourceThread.messages.filter((message) => {
          const existing = projectedMessagesById.get(message.messageId);
          const nativeAssistantMismatch =
            message.role === "assistant" &&
            findCodexHistoryAssistantItemMatches(message, projectedMessageIdentities).some(
              (live) =>
                live.text !== message.text ||
                live.createdAt !== message.createdAt ||
                (live.turnId ?? null) !== (message.turnId ?? null) ||
                (live.phase ?? null) !== (message.phase ?? null),
            );
          if (
            existing !== undefined &&
            isCodexHistoryMessageId(message.messageId) &&
            (existing.role !== message.role ||
              existing.text !== message.text ||
              existing.createdAt !== message.createdAt ||
              (existing.turnId ?? null) !== (message.turnId ?? null) ||
              (existing.phase ?? null) !== (message.phase ?? null) ||
              nativeAssistantMismatch)
          ) {
            // History rows are immutable identities, but their old bridge
            // import used the turn start for every message and could also
            // leave the native turn association unset. Reconcile the
            // canonical item timestamp and turn so tools and answers sort and
            // group together on every client instead of appearing duplicated
            // or after the answer.
            return true;
          }
          if (thread.messageIds.has(message.messageId)) {
            // A reconciliation migration can remove a derived history row
            // while the original message-sent event remains in the event
            // log. Re-dispatch only that native-history identity so the
            // projector can repair the live row and restore its native turn
            // association without recreating a duplicate.
            return existing === undefined && isCodexHistoryMessageId(message.messageId);
          }
          return !isDuplicateCodexHistoryMessageForExisting(message, projectedMessageIdentities);
        });
        const canImportEmptyHistory =
          thread.messageIds.size === 0 && thread.latestTurn === null && thread.session === null;
        if (
          sourceThread.messages.length > 0 &&
          needsHistoryRead &&
          canImportEmptyHistory &&
          isNewProjectionThread
        ) {
          const wasArchived = thread.archivedAt !== null;
          if (wasArchived) {
            yield* orchestrationEngine.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
              threadId,
            });
            thread.archivedAt = null;
          }
          yield* orchestrationEngine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            messages: sourceThread.messages.map((message) => ({
              messageId: MessageId.make(message.messageId),
              role: message.role,
              text: message.text,
              ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
              ...(message.phase !== undefined ? { phase: message.phase } : {}),
              createdAt: message.createdAt,
            })),
          });
          for (const message of sourceThread.messages) {
            thread.messageIds.add(message.messageId);
          }
          if (wasArchived && listedThread.archived) {
            yield* orchestrationEngine.dispatch({
              type: "thread.archive",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
              threadId,
            });
            thread.archivedAt = sourceThread.updatedAt;
          }
        } else if (
          missingMessages.length > 0 &&
          needsHistoryRead &&
          (!isNewProjectionThread || !canImportEmptyHistory)
        ) {
          yield* orchestrationEngine.dispatch({
            type: "thread.history.import",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            reconcile: true,
            messages: missingMessages.map((message) => ({
              messageId: MessageId.make(message.messageId),
              role: message.role,
              text: message.text,
              ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
              ...(message.phase !== undefined ? { phase: message.phase } : {}),
              createdAt: message.createdAt,
            })),
          });
          for (const message of missingMessages) {
            thread.messageIds.add(message.messageId);
          }
        }

        if (
          needsHistoryRead &&
          sourceThread.activities !== undefined &&
          sourceThread.activities.length > 0
        ) {
          const existingActivityIds = new Set(
            projectedNativeActivityKeys.map((activity) => String(activity.id)),
          );
          const existingCompletedToolIds = new Set<string>();
          const existingContextCompactions = new Set<string>();
          for (const activity of projectedNativeActivityKeys) {
            if (activity.kind === "tool.completed" && activity.toolCallId !== null) {
              existingCompletedToolIds.add(activity.toolCallId);
            }
            if (activity.kind === "context-compaction") {
              existingContextCompactions.add(
                `${String(activity.turnId ?? "")}:${activity.createdAt}`,
              );
            }
          }

          const missingNativeActivities = sourceThread.activities.filter((activity) => {
            if (existingActivityIds.has(activity.id)) {
              return false;
            }
            if (activity.kind === "tool.completed") {
              const payload =
                typeof activity.payload === "object" && activity.payload !== null
                  ? (activity.payload as { readonly toolCallId?: unknown })
                  : undefined;
              if (typeof payload?.toolCallId === "string") {
                return !existingCompletedToolIds.has(payload.toolCallId);
              }
            }
            if (activity.kind === "context-compaction") {
              return !existingContextCompactions.has(
                `${String(activity.turnId ?? "")}:${activity.createdAt}`,
              );
            }
            return true;
          });

          yield* Effect.forEach(
            missingNativeActivities,
            (activity) =>
              Effect.gen(function* () {
                return yield* orchestrationEngine.dispatch({
                  type: "thread.activity.append",
                  commandId: CommandId.make(yield* crypto.randomUUIDv4),
                  threadId,
                  activity: {
                    id: EventId.make(activity.id),
                    tone: activity.tone,
                    kind: activity.kind,
                    summary: activity.summary,
                    payload: activity.payload,
                    turnId: activity.turnId,
                    createdAt: activity.createdAt,
                  },
                  createdAt: activity.createdAt,
                });
              }),
            { concurrency: 1 },
          ).pipe(Effect.asVoid);
        }

        // Keep the native id even while the provider is idle. ProviderService
        // uses this stopped binding when the user sends the next message, so
        // the next turn resumes this Codex thread instead of creating a new
        // one. A live start below replaces the stopped status with its real
        // runtime state.
        if (
          persistedBinding === undefined ||
          persistedBinding.threadId !== threadId ||
          persistedBinding.providerInstanceId !== instance.instanceId ||
          !hasCodexNativeSettingsMarker(persistedBinding.persisted.runtimePayload) ||
          !hasCodexNativeHistorySyncMarker(persistedBinding.persisted.runtimePayload) ||
          readCodexNativeHistorySyncSequence(persistedBinding.persisted.runtimePayload) ===
            undefined ||
          readCodexNativeUpdatedAt(persistedBinding.persisted.runtimePayload) !==
            sourceThread.updatedAt
        ) {
          const persisted = persistedBinding?.persisted;
          yield* directory.upsert({
            threadId,
            provider: CODEX_DRIVER,
            providerInstanceId: instance.instanceId,
            status: persisted?.status ?? "stopped",
            runtimeMode: persisted?.runtimeMode ?? thread.runtimeMode,
            resumeCursor: { threadId: nativeThreadId },
            runtimePayload: {
              ...readRuntimePayload(persisted?.runtimePayload),
              cwd: sourceThread.cwd,
              modelSelection: thread.modelSelection,
              preserveProviderSettingsOnResume: true,
              nativeUpdatedAt: sourceThread.updatedAt,
              nativeHistorySyncVersion: CODEX_NATIVE_HISTORY_SYNC_VERSION,
              [CODEX_NATIVE_HISTORY_SYNC_SEQUENCE_KEY]: yield* orchestrationEngine.latestSequence,
            },
          });
        }

        if (migratedFromThreadId !== undefined) {
          if (liveThreadIds.has(migratedFromThreadId)) {
            yield* providerService.stopSession({ threadId: migratedFromThreadId }).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.failCause(cause)
                  : Effect.logWarning("could not stop stale Codex projection session", {
                      threadId: migratedFromThreadId,
                      cause,
                    }),
              ),
            );
            liveThreadIds.delete(migratedFromThreadId);
          }

          if (deleteBinding !== undefined) {
            yield* deleteBinding(migratedFromThreadId);
          } else {
            yield* Effect.logWarning("could not remove stale Codex projection binding", {
              threadId: migratedFromThreadId,
              nativeThreadId,
            });
          }

          const staleThread = threadsById.get(migratedFromThreadId);
          if (staleThread !== undefined && staleThread.archivedAt === null) {
            const archivedAt = DateTime.formatIso(yield* DateTime.now);
            yield* orchestrationEngine.dispatch({
              type: "thread.archive",
              commandId: CommandId.make(yield* crypto.randomUUIDv4),
              threadId: migratedFromThreadId,
            });
            staleThread.archivedAt = archivedAt;
          }
        }

        if (thread.title !== sourceThread.title) {
          yield* orchestrationEngine.dispatch({
            type: "thread.meta.update",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
            title: sourceThread.title,
          });
          thread.title = sourceThread.title;
        }

        if (listedThread.archived && thread.archivedAt === null) {
          yield* orchestrationEngine.dispatch({
            type: "thread.archive",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
          });
          thread.archivedAt = sourceThread.updatedAt;
        } else if (!listedThread.archived && thread.archivedAt !== null) {
          yield* orchestrationEngine.dispatch({
            type: "thread.unarchive",
            commandId: CommandId.make(yield* crypto.randomUUIDv4),
            threadId,
          });
          thread.archivedAt = null;
        }

        // Idle native threads are materialized but not needlessly resumed.
        // If they become active in Codex, the next catalog pass notices them;
        // active threads are resumed now so their event stream is live.
        if (
          listedThread.active &&
          !listedThread.archived &&
          thread.archivedAt === null &&
          !liveThreadIds.has(threadId)
        ) {
          const resumeCursor = { threadId: nativeThreadId };
          yield* providerService
            .startSession(threadId, {
              threadId,
              provider: CODEX_DRIVER,
              providerInstanceId: instance.instanceId,
              cwd: sourceThread.cwd,
              title: sourceThread.title,
              modelSelection:
                thread.modelSelection.instanceId === instance.instanceId
                  ? thread.modelSelection
                  : modelForInstance(instance.instanceId),
              resumeCursor,
              runtimeMode: thread.runtimeMode,
              preserveProviderSettingsOnResume: true,
              ...(sourceThread.activeTurnId ? { activeTurnId: sourceThread.activeTurnId } : {}),
            })
            .pipe(Effect.tap(() => Effect.sync(() => liveThreadIds.add(threadId))));
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("could not reconcile one Codex App Server thread", {
                providerInstanceId: instance.instanceId,
                nativeThreadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
  }
});

interface StartupOptions {
  readonly activate?: Effect.Effect<void>;
  readonly awaitAuxiliaryParked?: Effect.Effect<void>;
  readonly abort?: (error: ServerRuntimeStartupError) => Effect.Effect<void>;
}

export const autoPullProjects = Effect.fn("autoPullProjects")(function* (
  projects: ReadonlyArray<OrchestrationProjectShell>,
  settings: Pick<
    typeof DEFAULT_SERVER_SETTINGS,
    "defaultAutoPull" | "projectAutoPullOverrides"
  > = DEFAULT_SERVER_SETTINGS,
) {
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workspaceRoots = [
    ...new Set(
      projects
        .filter((project) => resolveProjectAutoPull(settings, project.id, project.autoPull))
        .map((project) => project.workspaceRoot),
    ),
  ];

  yield* Effect.forEach(
    workspaceRoots,
    (cwd) =>
      Effect.gen(function* () {
        const status = yield* git.statusDetails(cwd);
        if (
          !status.isRepo ||
          !status.isDefaultBranch ||
          !status.hasUpstream ||
          status.hasWorkingTreeChanges ||
          status.aheadCount > 0
        ) {
          yield* Effect.logDebug("Skipped automatic project pull", {
            cwd,
            reason: !status.isRepo
              ? "not-a-repository"
              : !status.isDefaultBranch
                ? "not-on-default-branch"
                : !status.hasUpstream
                  ? "no-upstream"
                  : status.hasWorkingTreeChanges
                    ? "working-tree-changes"
                    : "local-commits",
          });
          return;
        }

        if (status.behindCount <= 0) return;

        const result = yield* git.pullCurrentBranch(cwd);
        yield* Effect.logDebug("Automatic project pull completed", {
          cwd,
          status: result.status,
          refName: result.refName,
        });
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Automatic project pull failed", {
            cwd,
            cause,
          }),
        ),
      ),
    { concurrency: 4, discard: true },
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = (options?: StartupOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig.ServerConfig;
    const keybindings = yield* Keybindings.Keybindings;
    const orchestrationReactor = yield* OrchestrationReactor.OrchestrationReactor;
    const providerSessionReaper = yield* ProviderSessionReaper.ProviderSessionReaper;
    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
    const providerSessionDirectory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
    const crypto = yield* Crypto.Crypto;
    const launcher = yield* ServiceLauncherClient.ServiceLauncherClient;

    const commandGate = yield* makeCommandGate;
    const httpListening = yield* Deferred.make<void>();
    const reactorScope = yield* Scope.make("sequential");

    const syncAutoPullProjects = projectionSnapshotQuery.getShellSnapshot().pipe(
      Effect.flatMap((snapshot) =>
        serverSettings.getSettings.pipe(
          Effect.flatMap((settings) => autoPullProjects(snapshot.projects, settings)),
        ),
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to load projects for automatic pull", { cause }),
      ),
    );

    yield* Effect.addFinalizer(() => Scope.close(reactorScope, Exit.void));

    const startup = Effect.gen(function* () {
      yield* Effect.logDebug("startup phase: starting keybindings runtime");
      yield* runStartupPhase(
        "keybindings.start",
        keybindings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start keybindings runtime", {
              path: error.configPath,
              detail: error.detail,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: starting server settings runtime");
      yield* runStartupPhase(
        "settings.start",
        serverSettings.start.pipe(
          Effect.catch((error) =>
            Effect.logWarning("failed to start server settings runtime", {
              path: error.settingsPath,
              operation: error.operation,
              providerInstanceId: error.providerInstanceId,
              environmentVariable: error.environmentVariable,
              cause: error.cause,
            }),
          ),
        ),
      );

      yield* Effect.logDebug("startup phase: parking orchestration roots at activation");
      yield* runStartupPhase(
        "reactors.start",
        Effect.gen(function* () {
          yield* orchestrationReactor.start().pipe(Scope.provide(reactorScope));
          yield* providerSessionReaper.start().pipe(Scope.provide(reactorScope));
        }),
      );

      yield* runStartupPhase("provider-sessions.reconcile", reconcileProviderSessions);

      yield* Effect.logDebug("startup phase: attaching Codex App Server thread catalog");
      yield* forkParked(
        syncCodexAppServerThreads.pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.failCause(cause)
              : Effect.logWarning("Codex App Server thread catalog sync failed", { cause }),
          ),
          Effect.repeat(Schedule.spaced(CODEX_APP_SERVER_THREAD_SYNC_INTERVAL)),
          Effect.asVoid,
        ),
      );

      yield* Effect.logDebug("startup phase: syncing clean projects");
      yield* runStartupPhase("projects.auto-pull", syncAutoPullProjects);

      const welcomeBase = yield* resolveWelcomeBase;
      const environment = yield* serverEnvironment.getDescriptor;
      yield* Effect.logDebug("startup phase: preparing welcome payload");

      if (serverConfig.autoBootstrapProjectFromCwd) {
        yield* forkParked(
          runStartupPhase(
            "welcome.autobootstrap",
            Effect.gen(function* () {
              const bootstrapCompletion = yield* completeAutoBootstrapWelcome(
                resolveAutoBootstrapWelcomeTargets.pipe(
                  Effect.provideService(Crypto.Crypto, crypto),
                ),
              );

              yield* Effect.logDebug(
                "startup phase: publishing completed bootstrap welcome event",
                {
                  environmentId: environment.environmentId,
                  cwd: welcomeBase.cwd,
                  projectName: welcomeBase.projectName,
                  ...bootstrapCompletion,
                },
              );
              yield* lifecycleEvents.publish({
                version: 1,
                type: "welcome",
                payload: {
                  environment,
                  ...welcomeBase,
                  ...bootstrapCompletion,
                },
              });
            }).pipe(Effect.ignoreCause({ log: true })),
          ),
        );
      }

      yield* forkParked(
        Effect.gen(function* () {
          yield* Effect.logDebug("startup phase: recording startup heartbeat");
          yield* recordStartupHeartbeat.pipe(
            Effect.annotateSpans({ "startup.phase": "heartbeat.record" }),
            Effect.withSpan("server.startup.heartbeat.record"),
            Effect.ignoreCause({ log: true }),
          );
          if (serverConfig.startupPresentation === "headless") {
            const accessInfo = yield* issueHeadlessServeAccessInfo();
            yield* runStartupPhase(
              "headless.output",
              Console.log(formatHeadlessServeOutput(accessInfo)),
            );
          } else {
            const startupBrowserTarget = yield* resolveStartupBrowserTarget;
            if (serverConfig.mode !== "desktop") {
              yield* Effect.logInfo(
                "Authentication required. Open T3 Code using the pairing URL.",
              ).pipe(Effect.annotateLogs({ pairingUrl: startupBrowserTarget }));
            }
            yield* runStartupPhase("browser.open", maybeOpenBrowser(startupBrowserTarget));
          }
        }),
      );

      yield* Effect.logDebug("startup phase: waiting for http listener");
      yield* runStartupPhase("http.wait", Deferred.await(httpListening));
      yield* runStartupPhase(
        "auxiliary-roots.parked",
        options?.awaitAuxiliaryParked ?? Effect.void,
      );

      // This is the prepared boundary. Every dependency has been acquired and
      // every runtime root has confirmed that it is parked before this request.
      const updateOutcome = yield* launcher.prepareTrial;
      yield* runStartupPhase(
        "welcome.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "welcome",
          payload: {
            environment,
            ...welcomeBase,
            bootstrapStatus: serverConfig.autoBootstrapProjectFromCwd ? "pending" : "complete",
          },
        }),
      );
      yield* options?.activate ?? Effect.void;

      yield* Effect.logDebug("Accepting commands");
      yield* commandGate.signalCommandReady;
      yield* runStartupPhase(
        "ready.publish",
        lifecycleEvents.publish({
          version: 1,
          type: "ready",
          payload: {
            at: DateTime.formatIso(yield* DateTime.now),
            environment,
            ...(updateOutcome === undefined ? {} : { updateOutcome }),
          },
        }),
      );
      yield* Effect.logDebug("startup phase: complete");
    }).pipe(
      Effect.annotateSpans({
        "server.mode": serverConfig.mode,
        "server.port": serverConfig.port,
        "server.host": serverConfig.host ?? "default",
      }),
      Effect.withSpan("server.startup", { kind: "server", root: true }),
    );

    yield* Effect.forkScoped(
      Effect.exit(startup).pipe(
        Effect.flatMap((startupExit) => {
          if (Exit.isSuccess(startupExit)) return Effect.void;
          const error = new ServerRuntimeStartupError({
            mode: serverConfig.mode,
            host: serverConfig.host ?? null,
            port: serverConfig.port,
            cause: startupExit.cause,
          });
          return Effect.logError("server runtime startup failed", {
            cause: startupExit.cause,
          }).pipe(
            Effect.andThen(commandGate.failCommandReady(error)),
            Effect.andThen(options?.abort?.(error) ?? Effect.void),
          );
        }),
      ),
    );

    return {
      awaitCommandReady: commandGate.awaitCommandReady,
      markHttpListening: Deferred.succeed(httpListening, undefined),
      markRunningProviderSessionsForContinuation: markRunningProviderSessionsForContinuation.pipe(
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          projectionSnapshotQuery,
        ),
        Effect.provideService(
          ProviderSessionDirectory.ProviderSessionDirectory,
          providerSessionDirectory,
        ),
      ),
      clearProviderSessionContinuationMarkers: (threadIds) =>
        clearProviderSessionContinuationMarkers(threadIds).pipe(
          Effect.provideService(
            ProviderSessionDirectory.ProviderSessionDirectory,
            providerSessionDirectory,
          ),
        ),
      enqueueCommand: commandGate.enqueueCommand,
    } satisfies ServerRuntimeStartup["Service"];
  });

export const layerWithOptions = (options?: StartupOptions) =>
  Layer.effect(ServerRuntimeStartup, make(options));

export const layer = layerWithOptions();
