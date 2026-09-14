// @effect-diagnostics nodeBuiltinImport:off
/**
 * Owns the lifecycle of one Codex App Server daemon.
 *
 * Codex owns threads, turns, and their durable history. T3 only owns the
 * connection used by a provider binding. The daemon already scopes
 * notifications to the connection that started or resumed a thread, so this
 * module deliberately does not maintain a second T3-side notification router.
 *
 * There can be many WebSocket connections to one daemon, but there is at most
 * one daemon process per provider instance. This is the important boundary:
 * the process is shared, while each runtime gets the normal App Server client
 * contract and lifecycle supplied by the upstream protocol.
 */
import { type ProviderInstanceId as ProviderInstanceIdType } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";
import * as CodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "./CodexProvider.ts";
import { makeCodexAppServerUnixWebSocketStdio } from "./CodexAppServerTransport.ts";
import { CODEX_HISTORY_PAGE_SIZE, readCodexAppServerThread } from "./CodexAppServerHistory.ts";
import { codexManagedAppServerArgs } from "./codexLaunchArgs.ts";
import { expandHomePath } from "../../pathExpansion.ts";

const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const MAX_PENDING_STDERR_CHUNKS = 64;

/** Sources that represent user-visible Codex conversations. */
export const CODEX_APP_SERVER_THREAD_SOURCE_KINDS = [
  "cli",
  "vscode",
  "exec",
  "appServer",
  "subAgent",
  "subAgentReview",
  "subAgentCompact",
  "subAgentThreadSpawn",
  "subAgentOther",
  "unknown",
] as const satisfies ReadonlyArray<CodexSchema.V2ThreadListParams__ThreadSourceKind>;

type CodexAppServerClientService = CodexClient.CodexAppServerClient["Service"];

export interface CodexAppServerManagerOptions {
  readonly instanceId: ProviderInstanceIdType;
  readonly binaryPath: string;
  readonly homePath?: string;
  /** Home whose canonical app-server-daemon socket should be reused. */
  readonly appServerHomePath?: string;
  readonly launchArgs?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  /** Explicit `unix://` socket path, primarily for tests and custom daemons. */
  readonly socketPath?: string;
  /** Attach to Codex's canonical daemon, starting a compatible daemon if absent. */
  readonly preferExistingDaemon?: boolean;
}

export interface CodexAppServerSession {
  readonly client: CodexAppServerClientService;
  /** Completes when this WebSocket or its daemon terminates. */
  readonly appServerExit: Effect.Effect<void>;
  readonly isConnected: Effect.Effect<boolean>;
  /** Stderr from a T3-owned fallback daemon. */
  readonly stderr: Stream.Stream<string, never>;
  readonly close: Effect.Effect<void>;
}

export interface CodexAppServerManagerShape {
  /** Thread identity belongs to each App Server request, not this connection. */
  readonly openSession: () => Effect.Effect<CodexAppServerSession, CodexErrors.CodexAppServerError>;
  readonly listThreads: (
    params?: CodexRpc.ClientRequestParamsByMethod["thread/list"],
  ) => Effect.Effect<
    ReadonlyArray<CodexSchema.V2ThreadListResponse__Thread>,
    CodexErrors.CodexAppServerError
  >;
  readonly readThread: (
    nativeThreadId: string,
    options?: {
      readonly maxTurns?: number;
      readonly userTurnLimit?: number;
      /** Read the page strictly older than this native turn. */
      readonly beforeTurnId?: string;
    },
  ) => Effect.Effect<CodexSchema.V2ThreadReadResponse__Thread, CodexErrors.CodexAppServerError>;
  readonly close: Effect.Effect<void>;
}

interface Daemon {
  readonly scope: Scope.Closeable;
  readonly socketPath: string;
  readonly ownsSocketPath: boolean;
  readonly tempDirectory: string | undefined;
  readonly stderrSubscribers: Set<Queue.Queue<string>>;
  readonly pendingStderr: string[];
  child: ChildProcessSpawner.ChildProcessHandle | undefined;
  terminated: boolean;
}

interface SessionConnection {
  readonly daemon: Daemon;
  readonly scope: Scope.Closeable;
  readonly stderr: Queue.Queue<string>;
  readonly appServerExit: Deferred.Deferred<void>;
  client: CodexAppServerClientService | undefined;
  closed: boolean;
}

function readSocketPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return expandHomePath(trimmed.startsWith("unix://") ? trimmed.slice("unix://".length) : trimmed);
}

/** Codex's canonical local control socket used by app-server-daemon. */
export function codexAppServerControlSocketPath(
  homePath?: string,
  environment?: NodeJS.ProcessEnv,
): string {
  const configuredHome = homePath?.trim() || environment?.CODEX_HOME?.trim();
  const codexHome = expandHomePath(
    configuredHome && configuredHome.length > 0
      ? configuredHome
      : NodePath.join(NodeOS.homedir(), ".codex"),
  );
  return NodePath.join(codexHome, "app-server-control", "app-server-control.sock");
}

function makeTransportError(message: string, cause?: unknown) {
  return new CodexErrors.CodexAppServerTransportError({
    operation: "read-input-stream",
    cause: new Error(message, cause === undefined ? undefined : { cause }),
  });
}

const isRetryableTransportError = (cause: CodexErrors.CodexAppServerError): boolean =>
  cause._tag === "CodexAppServerTransportError" ||
  cause._tag === "CodexAppServerProcessExitedError" ||
  cause._tag === "CodexAppServerInputStreamEndedError";

const waitForSocketReady = Effect.fn("CodexAppServerManager.waitForSocketReady")(function* (
  socketPath: string,
): Effect.fn.Return<void, CodexErrors.CodexAppServerError> {
  yield* Effect.callback<void, CodexErrors.CodexAppServerError>((resume, signal) => {
    let settled = false;
    let socket: NodeNet.Socket | undefined;
    const finish = (result: Effect.Effect<void, CodexErrors.CodexAppServerError>) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resume(result);
    };

    const attempt = () => {
      if (settled) return;
      socket = NodeNet.createConnection({ path: socketPath });
      socket.once("connect", () => finish(Effect.void));
      socket.once("error", () => {
        socket?.destroy();
        socket = undefined;
        void Effect.runFork(Effect.sleep("25 millis").pipe(Effect.andThen(Effect.sync(attempt))));
      });
    };
    signal.addEventListener("abort", () => finish(Effect.void), { once: true });
    attempt();
  });
});

export const makeCodexAppServerManager = Effect.fn("CodexAppServerManager.make")(function* (
  options: CodexAppServerManagerOptions,
): Effect.fn.Return<
  CodexAppServerManagerShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const initializationLock = yield* Semaphore.make(1);
  const closedRef = yield* Ref.make(false);
  const connections = new Set<SessionConnection>();
  let daemon: Daemon | undefined;

  const signalConnectionExit = (connection: SessionConnection) => {
    if (connection.closed) return;
    connection.closed = true;
    void Effect.runFork(Deferred.succeed(connection.appServerExit, undefined));
  };

  const signalDaemonExit = (current: Daemon) => {
    if (current.terminated) return;
    current.terminated = true;
    for (const connection of connections) {
      if (connection.daemon === current) signalConnectionExit(connection);
    }
  };

  const publishStderr = (current: Daemon, chunk: string) =>
    Effect.gen(function* () {
      const subscribers = [...current.stderrSubscribers];
      if (subscribers.length === 0) {
        if (current.pendingStderr.length < MAX_PENDING_STDERR_CHUNKS) {
          current.pendingStderr.push(chunk);
        }
        return;
      }
      yield* Effect.forEach(subscribers, (queue) => Queue.offer(queue, chunk), {
        concurrency: 1,
        discard: true,
      });
    });

  const closeConnection = (connection: SessionConnection) =>
    Effect.gen(function* () {
      if (!connections.delete(connection)) return;
      connection.daemon.stderrSubscribers.delete(connection.stderr);
      signalConnectionExit(connection);
      yield* Scope.close(connection.scope, Exit.void).pipe(Effect.ignore);
      void Effect.runFork(Queue.shutdown(connection.stderr));
    });

  const cleanupDaemon = Effect.fn("CodexAppServerManager.cleanupDaemon")(function* (
    target?: Daemon,
  ) {
    const current = daemon;
    if (!current || (target !== undefined && target !== current)) return;
    daemon = undefined;
    signalDaemonExit(current);
    yield* Effect.forEach(
      [...connections].filter((connection) => connection.daemon === current),
      closeConnection,
      { concurrency: 1, discard: true },
    );
    yield* Scope.close(current.scope, Exit.void).pipe(Effect.ignore);
    yield* Effect.sync(() => {
      if (current.tempDirectory) {
        NodeFS.rmSync(current.tempDirectory, { recursive: true, force: true });
      } else if (current.ownsSocketPath) {
        NodeFS.rmSync(current.socketPath, { force: true });
      }
    }).pipe(Effect.ignore);
  });

  const ensureDaemon = (): Effect.Effect<Daemon, CodexErrors.CodexAppServerError> =>
    Effect.suspend(() => {
      return Ref.get(closedRef).pipe(
        Effect.flatMap((closed) => {
          if (closed) return Effect.fail(makeTransportError("Codex app-server manager is closed."));
          if (daemon && !daemon.terminated) return Effect.succeed(daemon);

          return initializationLock
            .withPermits(1)(
              Effect.gen(function* () {
                if (yield* Ref.get(closedRef)) {
                  return yield* makeTransportError("Codex app-server manager is closed.");
                }
                if (daemon && !daemon.terminated) return daemon;
                if (daemon) yield* cleanupDaemon(daemon);

                const explicitSocket = readSocketPath(
                  options.socketPath ?? options.environment?.T3CODE_CODEX_APP_SERVER_SOCKET,
                );
                const canonicalSocket =
                  explicitSocket === undefined && options.preferExistingDaemon === true
                    ? codexAppServerControlSocketPath(
                        options.appServerHomePath,
                        options.environment,
                      )
                    : undefined;
                const configuredSocket = explicitSocket ?? canonicalSocket;
                const tempDirectory = configuredSocket
                  ? undefined
                  : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-app-server-"));
                const socketPath =
                  configuredSocket ?? NodePath.join(tempDirectory as string, "control.sock");
                const socketExists = NodeFS.existsSync(socketPath);
                const current: Daemon = {
                  scope: yield* Scope.make("sequential"),
                  socketPath,
                  ownsSocketPath: !socketExists,
                  tempDirectory,
                  stderrSubscribers: new Set(),
                  pendingStderr: [],
                  child: undefined,
                  terminated: false,
                };
                daemon = current;

                if (!socketExists) {
                  NodeFS.mkdirSync(NodePath.dirname(socketPath), { recursive: true });
                  const env = {
                    ...options.environment,
                    ...(options.homePath ? { CODEX_HOME: expandHomePath(options.homePath) } : {}),
                  };
                  current.child = yield* spawner
                    .spawn(
                      ChildProcess.make(
                        options.binaryPath,
                        [
                          ...codexManagedAppServerArgs(options.launchArgs),
                          "--listen",
                          `unix://${socketPath}`,
                        ],
                        {
                          cwd: options.cwd,
                          env,
                          extendEnv: options.environment === undefined,
                          forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
                          shell: false,
                        },
                      ),
                    )
                    .pipe(
                      Effect.provideService(Scope.Scope, current.scope),
                      Effect.mapError(
                        (cause) =>
                          new CodexErrors.CodexAppServerSpawnError({
                            command: `${options.binaryPath} app-server --listen unix://…`,
                            cause,
                          }),
                      ),
                    );
                  const child = current.child;
                  if (!child) {
                    return yield* makeTransportError(
                      `Codex app-server did not start at ${socketPath}.`,
                    );
                  }
                  yield* child.exitCode.pipe(
                    Effect.asVoid,
                    Effect.catch(() => Effect.void),
                    Effect.ensuring(Effect.sync(() => signalDaemonExit(current))),
                    Effect.forkIn(current.scope),
                  );
                  yield* Stream.runDrain(child.stdout).pipe(
                    Effect.ignore,
                    Effect.forkIn(current.scope),
                  );
                  yield* child.stderr.pipe(
                    Stream.decodeText(),
                    Stream.runForEach((chunk) => publishStderr(current, chunk)),
                    Effect.ignore,
                    Effect.forkIn(current.scope),
                  );
                  yield* Effect.raceFirst(
                    waitForSocketReady(socketPath),
                    child.exitCode.pipe(
                      Effect.mapError(
                        (cause) =>
                          new CodexErrors.CodexAppServerTransportError({
                            operation: "read-process-exit-status",
                            pid: Number(child.pid),
                            cause,
                          }),
                      ),
                      Effect.flatMap((code) =>
                        Effect.fail(
                          new CodexErrors.CodexAppServerProcessExitedError({
                            code: Number(code),
                            pid: Number(child.pid),
                          }),
                        ),
                      ),
                    ),
                  );
                }
                return current;
              }),
            )
            .pipe(Effect.onError(() => cleanupDaemon()));
        }),
      );
    });

  const connectionTerminationError = (current: Daemon) =>
    current.child
      ? Effect.match(current.child.exitCode, {
          onFailure: (cause) =>
            new CodexErrors.CodexAppServerTransportError({
              operation: "read-process-exit-status",
              pid: Number(current.child!.pid),
              cause,
            }),
          onSuccess: (code) =>
            new CodexErrors.CodexAppServerProcessExitedError({
              code: Number(code),
              pid: Number(current.child!.pid),
            }),
        })
      : Effect.succeed(
          makeTransportError(`Codex app-server WebSocket closed: ${current.socketPath}`),
        );

  const openSession = Effect.fn("CodexAppServerManager.openSession")(function* () {
    const openAttempt = Effect.gen(function* () {
      const current = yield* ensureDaemon();
      const connection: SessionConnection = {
        daemon: current,
        scope: yield* Scope.make("sequential"),
        stderr: yield* Queue.unbounded<string>(),
        appServerExit: yield* Deferred.make<void>(),
        client: undefined,
        closed: false,
      };
      connections.add(connection);
      current.stderrSubscribers.add(connection.stderr);
      yield* Effect.forEach(
        current.pendingStderr.splice(0),
        (chunk) => Queue.offer(connection.stderr, chunk),
        { concurrency: 1, discard: true },
      );

      const open = Effect.gen(function* () {
        const stdio = yield* makeCodexAppServerUnixWebSocketStdio(current.socketPath, {
          onClosed: () => signalConnectionExit(connection),
        }).pipe(Effect.provideService(Scope.Scope, connection.scope));
        const clientContext = yield* CodexClient.layerStdio(
          stdio,
          {},
          connectionTerminationError(current),
        ).pipe(Layer.build, Effect.provideService(Scope.Scope, connection.scope));
        const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
          Effect.provide(clientContext),
        );
        yield* client.request("initialize", buildCodexInitializeParams());
        yield* client.notify("initialized", undefined);
        connection.client = client;
        return client;
      });

      // The process may exit between a session observing its closed socket and
      // this new attempt. Invalidate that daemon and rebuild the whole attempt
      // so the next session never retries against a stale socket path.
      const client = yield* open.pipe(
        Effect.retry({
          times: 10,
          while: (cause) => cause._tag === "CodexAppServerTransportError",
        }),
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* closeConnection(connection);
            yield* cleanupDaemon(current);
          }),
        ),
      );
      return {
        client,
        appServerExit: Deferred.await(connection.appServerExit),
        isConnected: Effect.sync(() => !connection.closed && !current.terminated),
        stderr: Stream.fromQueue(connection.stderr),
        close: closeConnection(connection),
      } satisfies CodexAppServerSession;
    });

    return yield* openAttempt.pipe(Effect.retry({ times: 1, while: isRetryableTransportError }));
  });

  const retryCatalogRequest = <A>(
    request: () => Effect.Effect<A, CodexErrors.CodexAppServerError>,
  ): Effect.Effect<A, CodexErrors.CodexAppServerError> =>
    Effect.suspend(request).pipe(
      Effect.tapError((cause) =>
        isRetryableTransportError(cause) ? cleanupDaemon() : Effect.void,
      ),
      Effect.retry({
        times: 2,
        while: isRetryableTransportError,
      }),
    );

  const withCatalogClient = <A>(
    use: (client: CodexAppServerClientService) => Effect.Effect<A, CodexErrors.CodexAppServerError>,
  ): Effect.Effect<A, CodexErrors.CodexAppServerError> =>
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* openSession();
        return yield* use(session.client).pipe(Effect.ensuring(session.close));
      }),
    );

  const listThreads: CodexAppServerManagerShape["listThreads"] = (params = {}) =>
    retryCatalogRequest(() =>
      withCatalogClient((client) =>
        Effect.gen(function* () {
          const threads: Array<CodexSchema.V2ThreadListResponse__Thread> = [];
          let cursor = params.cursor ?? undefined;
          const seenCursors = new Set<string>();
          for (;;) {
            const page = yield* client.request("thread/list", {
              ...params,
              ...(cursor === undefined ? {} : { cursor }),
            });
            threads.push(...page.data);
            const nextCursor = page.nextCursor ?? undefined;
            if (nextCursor === undefined) break;
            if (seenCursors.has(nextCursor)) {
              return yield* makeTransportError(
                `Codex app-server returned a repeated thread/list cursor '${nextCursor}'.`,
              );
            }
            seenCursors.add(nextCursor);
            cursor = nextCursor;
          }

          // Codex can expose the same durable thread more than once when the
          // catalog spans multiple pages (and active/archived queries can do
          // the same). Keep the newest record at this boundary so callers
          // never let a stale row overwrite the canonical one.
          const newestById = new Map<string, CodexSchema.V2ThreadListResponse__Thread>();
          for (const thread of threads) {
            const previous = newestById.get(thread.id);
            if (previous === undefined || thread.updatedAt > previous.updatedAt) {
              newestById.set(thread.id, thread);
            }
          }
          return [...newestById.values()];
        }),
      ),
    );

  const readThread: CodexAppServerManagerShape["readThread"] = (nativeThreadId, options) =>
    retryCatalogRequest(() =>
      withCatalogClient((client) =>
        readCodexAppServerThread(client, nativeThreadId, {
          pageSize: CODEX_HISTORY_PAGE_SIZE,
          sortDirection: "desc",
          ...(options?.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
          ...(options?.userTurnLimit === undefined ? {} : { userTurnLimit: options.userTurnLimit }),
          ...(options?.beforeTurnId === undefined ? {} : { beforeTurnId: options.beforeTurnId }),
        }),
      ),
    );

  const close = Effect.gen(function* () {
    const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
    if (!alreadyClosed) yield* initializationLock.withPermits(1)(cleanupDaemon());
  });

  yield* Effect.addFinalizer(() => close);

  return {
    openSession,
    listThreads,
    readThread,
    close,
  } satisfies CodexAppServerManagerShape;
});
