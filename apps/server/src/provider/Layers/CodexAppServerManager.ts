// @effect-diagnostics nodeBuiltinImport:off
/**
 * Owns one Codex app-server connection for one provider instance.
 *
 * The old adapter started one `codex app-server` child process per T3 thread.
 * This manager reverses that ownership: the provider instance owns one
 * daemon/transport, while each T3 thread is only a binding to a native Codex
 * thread id. Notifications and approval requests are demultiplexed by the
 * native id supplied by Codex.
 */
import { ThreadId, type ProviderInstanceId as ProviderInstanceIdType } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
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
import { readCodexRolloutTurns } from "./CodexRolloutHistory.ts";
import { codexManagedAppServerArgs } from "./codexLaunchArgs.ts";
import { expandHomePath } from "../../pathExpansion.ts";

const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds" as const;
const MAX_SESSION_RAW_MESSAGES = 32;
// Full Codex items can include large command outputs. Keep each paginated
// response comfortably below ws's default 100 MiB frame limit while allowing
// a single unusually large turn through the transport's explicit cap.
export const CODEX_HISTORY_PAGE_SIZE = 10;

/**
 * Sources that represent user-visible Codex conversations. Sub-agent source
 * kinds are included so the caller can make one complete catalog request, but
 * the T3 adapter deliberately keeps those child threads behind their parent
 * collaboration item instead of duplicating them in the sidebar.
 */
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
type ServerRequestHandler = (
  payload: unknown,
) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>;
type ServerNotificationHandler = (
  payload: unknown,
) => Effect.Effect<void, CodexErrors.CodexAppServerError>;
type CodexAppServerIncomingNotification = {
  readonly method: string;
  readonly params?: unknown;
};
type CodexAppServerIncomingRequest = {
  readonly id: string | number;
  readonly method: string;
  readonly params?: unknown;
};

export interface CodexAppServerManagerOptions {
  readonly instanceId: ProviderInstanceIdType;
  readonly binaryPath: string;
  readonly homePath?: string;
  /**
   * The Codex home that owns the shared app-server daemon control socket.
   * This is separate from `homePath` because an auth-overlay instance can
   * execute with a shadow home while its sessions and daemon live in the
   * shared home.
   */
  readonly appServerHomePath?: string;
  readonly launchArgs?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly cwd: string;
  /**
   * Attach to an already-running `codex app-server --listen unix://…` when
   * supplied. If the path does not exist yet, the manager starts the daemon
   * there and owns that process for the provider instance.
   */
  readonly socketPath?: string;
  /**
   * When true and no explicit socket was configured, use Codex's canonical
   * app-server-daemon control socket. If it is absent, start the managed
   * compatibility server at that path.
   */
  readonly preferExistingDaemon?: boolean;
}

export interface CodexAppServerSessionOptions {
  readonly threadId: ThreadId;
  readonly resumeThreadId?: string;
}

export interface CodexAppServerSession {
  readonly client: CodexAppServerClientService;
  /** Completes when the shared daemon or its socket connection terminates. */
  readonly appServerExit: Effect.Effect<void>;
  /** False after the manager removes this binding because the connection died. */
  readonly isConnected: Effect.Effect<boolean>;
  /** Decoded daemon stderr shared with this T3 session. */
  readonly stderr: Stream.Stream<string, never>;
  readonly close: Effect.Effect<void>;
}

export interface CodexAppServerManagerShape {
  readonly openSession: (
    options: CodexAppServerSessionOptions,
  ) => Effect.Effect<CodexAppServerSession, CodexErrors.CodexAppServerError>;
  readonly closeSession: (threadId: ThreadId) => Effect.Effect<void>;
  /** Enumerate every persisted Codex thread, following all app-server pages. */
  readonly listThreads: (
    params?: CodexRpc.ClientRequestParamsByMethod["thread/list"],
  ) => Effect.Effect<
    ReadonlyArray<CodexSchema.V2ThreadListResponse__Thread>,
    CodexErrors.CodexAppServerError
  >;
  /** Read one persisted Codex thread, including its native turn items. */
  readonly readThread: (
    nativeThreadId: string,
  ) => Effect.Effect<CodexSchema.V2ThreadReadResponse__Thread, CodexErrors.CodexAppServerError>;
  readonly close: Effect.Effect<void>;
}

interface NativeSession {
  readonly threadId: ThreadId;
  connection: ActiveConnection | undefined;
  readonly nativeThreadIds: Set<string>;
  readonly rawNotifications: Queue.Queue<CodexAppServerIncomingNotification>;
  readonly rawRequests: Queue.Queue<CodexAppServerIncomingRequest>;
  readonly stderr: Queue.Queue<string>;
  pendingNotifications: Array<{ readonly method: string; readonly payload: unknown }>;
  readonly requestHandlers: Map<string, ServerRequestHandler>;
  readonly notificationHandlers: Map<string, Array<ServerNotificationHandler>>;
  unknownRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, CodexErrors.CodexAppServerError>)
    | undefined;
  unknownNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, CodexErrors.CodexAppServerError>)
    | undefined;
  closed: boolean;
}

interface ActiveConnection {
  readonly scope: Scope.Closeable;
  readonly appServerExit: Deferred.Deferred<void>;
  readonly socketPath: string;
  readonly ownsSocketPath: boolean;
  readonly pendingNotifications: Array<{ readonly method: string; readonly payload: unknown }>;
  readonly pendingRawNotifications: CodexAppServerIncomingNotification[];
  readonly pendingRawRequests: CodexAppServerIncomingRequest[];
  readonly pendingStderr: string[];
  client: CodexAppServerClientService | undefined;
  child: ChildProcessSpawner.ChildProcessHandle | undefined;
  tempDirectory: string | undefined;
  terminated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNativeThreadId(method: string, payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  if (method === "thread/started" && isRecord(payload.thread)) {
    return readString(payload.thread.id);
  }
  return readString(payload.threadId) ?? readString(payload.conversationId);
}

function readParentThreadId(method: string, payload: unknown): string | undefined {
  if (method !== "thread/started" || !isRecord(payload) || !isRecord(payload.thread)) {
    return undefined;
  }
  return readString(payload.thread.parentThreadId);
}

function readSocketPath(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  const path = trimmed.startsWith("unix://") ? trimmed.slice("unix://".length) : trimmed;
  return path ? expandHomePath(path) : undefined;
}

/**
 * Codex app-server-daemon's default WebSocket control socket. Keep this in
 * one place so the driver, tests, and diagnostics agree with the upstream
 * daemon layout instead of inventing a T3-specific socket location.
 */
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

const CodexPaginatedThreadPage = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});

type CodexPaginatedThreadPage = Schema.Schema.Type<typeof CodexPaginatedThreadPage>;

const decodeCodexPaginatedThreadPage = (method: string, payload: unknown) =>
  Schema.decodeUnknownEffect(CodexPaginatedThreadPage)(payload).pipe(
    Effect.mapError((cause) =>
      makeTransportError(`Codex app-server returned an invalid ${method} page.`, cause),
    ),
  );

const isPaginationUnavailable = (cause: CodexErrors.CodexAppServerError): boolean =>
  cause._tag === "CodexAppServerRequestError" &&
  (cause.code === -32601 ||
    (cause.code === -32602 &&
      /thread\/(?:turns|items)\/list|paginated|history/i.test(cause.errorMessage)));

/**
 * Hydrate paginated Codex history into the chronological shape used by the
 * adapter. The app-server returns descending pages for backward hydration;
 * each turn's items remain in their native chronological order.
 */
const readPaginatedCodexTurns = (
  client: CodexAppServerClientService,
  nativeThreadId: string,
): Effect.Effect<
  ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn>,
  CodexErrors.CodexAppServerError
> =>
  Effect.gen(function* () {
    const turns: Array<CodexSchema.V2ThreadReadResponse__Turn> = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();

    for (;;) {
      const pageParams = {
        threadId: nativeThreadId,
        limit: CODEX_HISTORY_PAGE_SIZE,
        sortDirection: "desc" as const,
        itemsView: "full" as const,
        ...(cursor === undefined ? {} : { cursor }),
      };
      const rawPage = yield* client.raw.request("thread/turns/list", pageParams);
      const page: CodexPaginatedThreadPage = yield* decodeCodexPaginatedThreadPage(
        "thread/turns/list",
        rawPage,
      );
      const decodedTurns = yield* Effect.forEach(
        page.data,
        (turn) =>
          Schema.decodeUnknownEffect(CodexSchema.V2ThreadReadResponse__Turn)(turn).pipe(
            Effect.mapError((cause) =>
              makeTransportError("Codex app-server returned an invalid thread turn.", cause),
            ),
          ),
        { concurrency: 1 },
      );
      turns.push(...decodedTurns);

      const nextCursor = page.nextCursor ?? undefined;
      if (nextCursor === undefined) {
        return turns.reverse();
      }
      if (seenCursors.has(nextCursor)) {
        return yield* makeTransportError(
          `Codex app-server returned a repeated thread/turns/list cursor '${nextCursor}'.`,
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  });

const readFiniteNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const mergeCodexTurns = (
  indexedTurns: ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn>,
  rolloutTurns: ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn>,
): ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn> => {
  const byId = new Map(indexedTurns.map((turn) => [turn.id, turn]));
  for (const rolloutTurn of rolloutTurns) {
    const indexedTurn = byId.get(rolloutTurn.id);
    if (indexedTurn === undefined) {
      byId.set(rolloutTurn.id, rolloutTurn);
      continue;
    }
    const rolloutItemIds = new Set(rolloutTurn.items.map((item) => item.id));
    // The append-only rollout is the source of chronological item order. The
    // paginated projection can stop in the middle of a turn, so appending its
    // missing items to the indexed array makes commands/reasoning appear after
    // later messages. Keep indexed-only items as a compatibility tail for old
    // app-server item kinds the rollout decoder does not know yet.
    const mergedItems = [
      ...rolloutTurn.items,
      ...indexedTurn.items.filter((item) => !rolloutItemIds.has(item.id)),
    ];
    byId.set(rolloutTurn.id, {
      ...indexedTurn,
      ...rolloutTurn,
      items: mergedItems,
    });
  }
  return [...byId.values()].toSorted(
    (left, right) =>
      (left.startedAt ?? Number.MAX_SAFE_INTEGER) - (right.startedAt ?? Number.MAX_SAFE_INTEGER) ||
      left.id.localeCompare(right.id),
  );
};

const waitForSocketPath = Effect.fn("CodexAppServerManager.waitForSocketPath")(function* (
  socketPath: string,
): Effect.fn.Return<void, CodexErrors.CodexAppServerError> {
  if (NodeFS.existsSync(socketPath)) {
    return;
  }

  yield* Effect.callback<void, CodexErrors.CodexAppServerError>((resume, signal) => {
    let settled = false;
    let watcher: NodeFS.FSWatcher | undefined;

    const finish = (result: Effect.Effect<void, CodexErrors.CodexAppServerError>) => {
      if (settled) {
        return;
      }
      settled = true;
      watcher?.close();
      resume(result);
    };

    const check = () => {
      if (NodeFS.existsSync(socketPath)) {
        finish(Effect.void);
      }
    };

    try {
      watcher = NodeFS.watch(
        NodePath.dirname(socketPath),
        { persistent: false },
        (_event, name) => {
          if (name === null || name.toString() === NodePath.basename(socketPath)) {
            check();
          }
        },
      );
      watcher.once("error", (cause) =>
        finish(
          Effect.fail(
            makeTransportError(`Could not watch for Codex app-server socket ${socketPath}.`, cause),
          ),
        ),
      );
      signal.addEventListener(
        "abort",
        () => {
          settled = true;
          watcher?.close();
        },
        { once: true },
      );
      check();
    } catch (cause) {
      finish(
        Effect.fail(
          makeTransportError(`Could not watch for Codex app-server socket ${socketPath}.`, cause),
        ),
      );
    }
  });
});

export const makeCodexAppServerManager = Effect.fn("CodexAppServerManager.make")(function* (
  options: CodexAppServerManagerOptions,
): Effect.fn.Return<
  CodexAppServerManagerShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const managerScope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const initializationLock = yield* Semaphore.make(1);
  const closedRef = yield* Ref.make(false);
  const sessions = new Set<NativeSession>();
  const nativeThreadOwners = new Map<string, NativeSession>();
  let pendingThreadStart: NativeSession | undefined;
  let lastRequestOwner: NativeSession | undefined;
  let activeConnection: ActiveConnection | undefined;
  const rolloutHistoryCache = new Map<
    string,
    {
      readonly size: number;
      readonly mtimeMs: number;
      readonly turns: ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn>;
    }
  >();

  const signalAppServerExit = (connection: ActiveConnection) => {
    connection.terminated = true;
    void Effect.runFork(Deferred.succeed(connection.appServerExit, undefined));
  };

  const removeSession = (session: NativeSession) => {
    if (session.closed) {
      return;
    }
    session.closed = true;
    sessions.delete(session);
    for (const nativeThreadId of session.nativeThreadIds) {
      if (nativeThreadOwners.get(nativeThreadId) === session) {
        nativeThreadOwners.delete(nativeThreadId);
      }
    }
    if (pendingThreadStart === session) {
      pendingThreadStart = undefined;
    }
    if (lastRequestOwner === session) {
      lastRequestOwner = [...sessions].find((candidate) => !candidate.closed);
    }
    session.connection = undefined;
    session.nativeThreadIds.clear();
    session.pendingNotifications.length = 0;
    session.requestHandlers.clear();
    session.notificationHandlers.clear();
    void Effect.runFork(Queue.shutdown(session.rawNotifications));
    void Effect.runFork(Queue.shutdown(session.rawRequests));
    void Effect.runFork(Queue.shutdown(session.stderr));
  };

  const bindNativeThread = (session: NativeSession, nativeThreadId: string) => {
    const previous = nativeThreadOwners.get(nativeThreadId);
    if (previous && previous !== session) {
      previous.nativeThreadIds.delete(nativeThreadId);
    }
    nativeThreadOwners.set(nativeThreadId, session);
    session.nativeThreadIds.add(nativeThreadId);
  };

  const activeFallbackSession = (): NativeSession | undefined => {
    const active = [...sessions].filter((session) => !session.closed);
    return active.length === 1 ? active[0] : undefined;
  };

  const findAddressedSession = (method: string, payload: unknown): NativeSession | undefined => {
    const nativeThreadId = readNativeThreadId(method, payload);
    if (nativeThreadId) {
      const direct = nativeThreadOwners.get(nativeThreadId);
      if (direct && !direct.closed) {
        return direct;
      }
    }

    const parentThreadId = readParentThreadId(method, payload);
    if (parentThreadId) {
      const parent = nativeThreadOwners.get(parentThreadId);
      if (parent && !parent.closed) {
        if (nativeThreadId) {
          bindNativeThread(parent, nativeThreadId);
        }
        return parent;
      }
    }

    if (
      method === "thread/started" &&
      !parentThreadId &&
      pendingThreadStart &&
      !pendingThreadStart.closed
    ) {
      if (nativeThreadId) {
        bindNativeThread(pendingThreadStart, nativeThreadId);
      }
      return pendingThreadStart;
    }

    // A message with an explicit native id must never fall through to an
    // unrelated T3 session. This matters for a shared daemon: it may still
    // emit notifications for threads opened by another client.
    if (nativeThreadId || parentThreadId) {
      return undefined;
    }

    return undefined;
  };

  const findSessionForRequest = (method: string, payload: unknown): NativeSession | undefined => {
    const addressed = findAddressedSession(method, payload);
    if (addressed) {
      return addressed;
    }

    // An explicitly addressed request belongs to exactly one native thread.
    // Never let an unknown id fall through to the last request owner: doing so
    // would answer another T3 thread's approval or user-input request.
    if (readNativeThreadId(method, payload) || readParentThreadId(method, payload)) {
      return undefined;
    }

    return lastRequestOwner && !lastRequestOwner.closed
      ? lastRequestOwner
      : activeFallbackSession();
  };

  const dispatchNotificationToSession = (
    session: NativeSession,
    method: string,
    payload: unknown,
  ) => {
    if (session.closed) {
      return Effect.void;
    }
    const handlers = session.notificationHandlers.get(method) ?? [];
    if (handlers.length > 0) {
      return Effect.forEach([...handlers], (handler) => handler(payload), {
        concurrency: 1,
        discard: true,
      });
    }
    if (session.unknownNotificationHandler) {
      return session.unknownNotificationHandler(method, payload);
    }
    // A runtime registers its handlers immediately after the binding is
    // opened, but the daemon can emit an early notification during that
    // window. Retain it until the matching handler is installed so the shared
    // path has the same startup behavior as the old per-thread client.
    if (session.pendingNotifications.length < 64) {
      session.pendingNotifications.push({ method, payload });
    }
    return Effect.void;
  };

  const replayPendingNotifications = (
    session: NativeSession,
    predicate: (method: string) => boolean,
    handler: (
      method: string,
      payload: unknown,
    ) => Effect.Effect<void, CodexErrors.CodexAppServerError>,
  ) => {
    const replay = session.pendingNotifications.filter(({ method }) => predicate(method));
    if (replay.length === 0) {
      return Effect.void;
    }
    session.pendingNotifications = session.pendingNotifications.filter(
      ({ method }) => !predicate(method),
    );
    return Effect.forEach(replay, ({ method, payload }) => handler(method, payload), {
      concurrency: 1,
      discard: true,
    });
  };

  const dispatchNotification = (method: string, payload: unknown) => {
    const addressed = findAddressedSession(method, payload);
    if (addressed) {
      return dispatchNotificationToSession(addressed, method, payload);
    }
    if (readNativeThreadId(method, payload) || readParentThreadId(method, payload)) {
      return Effect.void;
    }
    const connection = activeConnection;
    if (connection && sessions.size === 0 && connection.pendingNotifications.length < 64) {
      connection.pendingNotifications.push({ method, payload });
      return Effect.void;
    }
    // Notifications such as account/rate-limit updates and warnings may be
    // process-wide. The old one-process-per-thread architecture delivered a
    // copy to every runtime, so preserve that observable behavior when one
    // daemon is shared.
    return Effect.forEach(
      [...sessions].filter((session) => !session.closed),
      (session) => dispatchNotificationToSession(session, method, payload),
      { concurrency: 1, discard: true },
    );
  };

  const dispatchRawNotification = (
    connection: ActiveConnection,
    notification: CodexAppServerIncomingNotification,
  ): Effect.Effect<void> => {
    const addressed = findAddressedSession(notification.method, notification.params);
    if (addressed) {
      return Queue.offer(addressed.rawNotifications, notification).pipe(Effect.asVoid);
    }
    if (readNativeThreadId(notification.method, notification.params)) {
      return Effect.void;
    }

    const activeSessions = [...sessions].filter((session) => !session.closed);
    if (activeSessions.length === 0) {
      if (connection.pendingRawNotifications.length < MAX_SESSION_RAW_MESSAGES) {
        connection.pendingRawNotifications.push(notification);
      }
      return Effect.void;
    }
    return Effect.forEach(
      activeSessions,
      (session) => Queue.offer(session.rawNotifications, notification),
      { concurrency: 1, discard: true },
    ).pipe(Effect.asVoid);
  };

  const dispatchRawRequest = (
    connection: ActiveConnection,
    request: CodexAppServerIncomingRequest,
  ): Effect.Effect<void> => {
    const session = findSessionForRequest(request.method, request.params);
    if (session) {
      return Queue.offer(session.rawRequests, request).pipe(Effect.asVoid);
    }
    if (readNativeThreadId(request.method, request.params)) {
      return Effect.void;
    }
    if (sessions.size === 0 && connection.pendingRawRequests.length < MAX_SESSION_RAW_MESSAGES) {
      connection.pendingRawRequests.push(request);
    }
    return Effect.void;
  };

  const dispatchRequest = (
    method: string,
    payload: unknown,
  ): Effect.Effect<unknown, CodexErrors.CodexAppServerError> => {
    const session = findSessionForRequest(method, payload);
    if (!session) {
      return Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method));
    }
    const handler = session.requestHandlers.get(method);
    if (handler) {
      return handler(payload);
    }
    if (session.unknownRequestHandler) {
      return session.unknownRequestHandler(method, payload);
    }
    return Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound(method));
  };

  const registerGlobalHandlers = Effect.fn("CodexAppServerManager.registerGlobalHandlers")(
    function* (client: CodexAppServerClientService) {
      yield* Effect.forEach(
        Object.values(
          CodexRpc.SERVER_REQUEST_METHODS,
        ) as ReadonlyArray<CodexRpc.ServerRequestMethod>,
        (method) =>
          client.handleServerRequest(method, ((payload: unknown) =>
            dispatchRequest(method, payload)) as never),
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(
        Object.values(
          CodexRpc.SERVER_NOTIFICATION_METHODS,
        ) as ReadonlyArray<CodexRpc.ServerNotificationMethod>,
        (method) =>
          client.handleServerNotification(method, ((payload: unknown) =>
            dispatchNotification(method, payload)) as never),
        { concurrency: 1, discard: true },
      );
      yield* client.handleUnknownServerRequest((method, payload) =>
        dispatchRequest(method, payload),
      );
      yield* client.handleUnknownServerNotification((method, payload) =>
        dispatchNotification(method, payload),
      );
    },
  );

  const cleanupConnection = Effect.fn("CodexAppServerManager.cleanupConnection")(function* (
    target?: ActiveConnection,
  ) {
    const connection = activeConnection;
    if (!connection || (target !== undefined && target !== connection)) {
      return;
    }
    activeConnection = undefined;
    signalAppServerExit(connection);
    for (const session of [...sessions]) {
      removeSession(session);
    }
    yield* Scope.close(connection.scope, Exit.void).pipe(Effect.ignore);
    const tempDirectory = connection.tempDirectory;
    if (tempDirectory) {
      yield* Effect.sync(() => NodeFS.rmSync(tempDirectory, { recursive: true, force: true })).pipe(
        Effect.ignore,
      );
    } else if (connection.ownsSocketPath) {
      yield* Effect.sync(() => NodeFS.unlinkSync(connection.socketPath)).pipe(Effect.ignore);
    }
  });

  const ensureClient = Effect.fn("CodexAppServerManager.ensureClient")(function* () {
    if (yield* Ref.get(closedRef)) {
      return yield* makeTransportError("Codex app-server manager is closed.");
    }
    if (activeConnection?.client && !activeConnection.terminated) {
      return activeConnection.client;
    }

    return yield* initializationLock
      .withPermits(1)(
        Effect.gen(function* () {
          if (yield* Ref.get(closedRef)) {
            return yield* makeTransportError("Codex app-server manager is closed.");
          }
          if (activeConnection?.client && !activeConnection.terminated) {
            return activeConnection.client;
          }
          if (activeConnection) {
            yield* cleanupConnection(activeConnection);
          }

          const explicitlyConfiguredSocketPath = readSocketPath(
            options.socketPath ?? options.environment?.T3CODE_CODEX_APP_SERVER_SOCKET,
          );
          const daemonSocketPath =
            explicitlyConfiguredSocketPath === undefined && options.preferExistingDaemon === true
              ? codexAppServerControlSocketPath(options.appServerHomePath, options.environment)
              : undefined;
          const configuredSocketPath = explicitlyConfiguredSocketPath ?? daemonSocketPath;
          const tempDirectory = configuredSocketPath
            ? undefined
            : NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-codex-app-server-"));
          const socketPath =
            configuredSocketPath ?? NodePath.join(tempDirectory as string, "control.sock");
          const socketExists = NodeFS.existsSync(socketPath);
          const connection: ActiveConnection = {
            scope: yield* Scope.make("sequential"),
            appServerExit: yield* Deferred.make<void>(),
            socketPath,
            ownsSocketPath: !socketExists,
            pendingNotifications: [],
            pendingRawNotifications: [],
            pendingRawRequests: [],
            pendingStderr: [],
            client: undefined,
            child: undefined,
            tempDirectory,
            terminated: false,
          };
          activeConnection = connection;

          const env = {
            ...options.environment,
            ...(options.homePath ? { CODEX_HOME: expandHomePath(options.homePath) } : {}),
          };
          const extendEnv = options.environment === undefined;

          if (!socketExists) {
            NodeFS.mkdirSync(NodePath.dirname(socketPath), { recursive: true });
            const spawnCommand = {
              command: options.binaryPath,
              args: [
                ...codexManagedAppServerArgs(options.launchArgs),
                "--listen",
                `unix://${socketPath}`,
              ],
              shell: false,
            } as const;
            connection.child = yield* spawner
              .spawn(
                ChildProcess.make(spawnCommand.command, spawnCommand.args, {
                  cwd: options.cwd,
                  env,
                  extendEnv,
                  forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
                  shell: spawnCommand.shell,
                }),
              )
              .pipe(
                Effect.provideService(Scope.Scope, connection.scope),
                Effect.mapError(
                  (cause) =>
                    new CodexErrors.CodexAppServerSpawnError({
                      command: `${options.binaryPath} app-server --listen unix://…`,
                      cause,
                    }),
                ),
              );
            const child = connection.child;
            if (!child) {
              return yield* makeTransportError(
                `Codex app-server process was not created for ${socketPath}.`,
              );
            }
            yield* child.exitCode.pipe(
              Effect.asVoid,
              Effect.catch(() => Effect.void),
              Effect.ensuring(Effect.sync(() => signalAppServerExit(connection))),
              Effect.forkIn(connection.scope),
            );
            yield* Stream.runDrain(child.stdout).pipe(
              Effect.ignore,
              Effect.forkIn(connection.scope),
            );
            yield* child.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  const activeSessions = [...sessions].filter((session) => !session.closed);
                  if (activeSessions.length === 0) {
                    if (connection.pendingStderr.length < 64) {
                      connection.pendingStderr.push(chunk);
                    }
                    return;
                  }
                  yield* Effect.forEach(
                    activeSessions,
                    (session) => Queue.offer(session.stderr, chunk),
                    { concurrency: 1, discard: true },
                  );
                }),
              ),
              Effect.ignore,
              Effect.forkIn(connection.scope),
            );
          }

          if (!socketExists) {
            const child = connection.child;
            if (!child) {
              return yield* makeTransportError(
                `Codex app-server process was not created for ${socketPath}.`,
              );
            }
            yield* Effect.raceFirst(
              waitForSocketPath(socketPath),
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
          const stdio = yield* makeCodexAppServerUnixWebSocketStdio(socketPath, {
            onClosed: () => signalAppServerExit(connection),
          }).pipe(Effect.provideService(Scope.Scope, connection.scope));
          const child = connection.child;
          const terminationError = child
            ? Effect.match(child.exitCode, {
                onFailure: (cause) =>
                  new CodexErrors.CodexAppServerTransportError({
                    operation: "read-process-exit-status",
                    pid: Number(child.pid),
                    cause,
                  }),
                onSuccess: (code) =>
                  new CodexErrors.CodexAppServerProcessExitedError({
                    code: Number(code),
                    pid: Number(child.pid),
                  }),
              })
            : Effect.succeed(
                makeTransportError(`Codex app-server WebSocket closed: ${socketPath}`),
              );
          const clientContext = yield* CodexClient.layerStdio(stdio, {}, terminationError).pipe(
            Layer.build,
            Effect.provideService(Scope.Scope, connection.scope),
          );
          const client = yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(clientContext),
          );

          yield* client.raw.notifications.pipe(
            Stream.runForEach((notification) => dispatchRawNotification(connection, notification)),
            Effect.ignore,
            Effect.forkIn(connection.scope),
          );
          yield* client.raw.requests.pipe(
            Stream.runForEach((request) => dispatchRawRequest(connection, request)),
            Effect.ignore,
            Effect.forkIn(connection.scope),
          );
          yield* registerGlobalHandlers(client);
          yield* client.request("initialize", buildCodexInitializeParams());
          yield* client.notify("initialized", undefined);
          if (yield* Ref.get(closedRef)) {
            return yield* makeTransportError("Codex app-server manager is closed.");
          }
          connection.client = client;
          yield* Deferred.await(connection.appServerExit).pipe(
            Effect.andThen(initializationLock.withPermits(1)(cleanupConnection(connection))),
            Effect.catch(() => Effect.void),
            Effect.forkIn(managerScope),
          );
          return client;
        }),
      )
      .pipe(Effect.onError(() => cleanupConnection()));
  });

  const requestWithSessionRouting = (
    session: NativeSession,
    method: string,
    payload: unknown,
    request: () => Effect.Effect<unknown, CodexErrors.CodexAppServerError>,
  ): Effect.Effect<unknown, CodexErrors.CodexAppServerError> => {
    if (session.closed || !session.connection || session.connection.terminated) {
      return Effect.fail(makeTransportError("Codex app-server session is closed."));
    }
    lastRequestOwner = session;
    if (method === "thread/start" || method === "thread/resume") {
      return initializationLock.withPermits(1)(
        Effect.gen(function* () {
          if (method === "thread/start") {
            pendingThreadStart = session;
          } else if (isRecord(payload)) {
            const nativeThreadId = readString(payload.threadId);
            if (nativeThreadId) {
              bindNativeThread(session, nativeThreadId);
            }
          }
          try {
            const response = yield* request();
            if (method === "thread/start" && isRecord(response) && isRecord(response.thread)) {
              const nativeThreadId = readString(response.thread.id);
              if (nativeThreadId) {
                bindNativeThread(session, nativeThreadId);
              }
            }
            return response;
          } finally {
            if (pendingThreadStart === session) {
              pendingThreadStart = undefined;
            }
          }
        }),
      );
    }
    return request();
  };

  const requestFromSession = (
    session: NativeSession,
    method: CodexRpc.ClientRequestMethod,
    payload: unknown,
  ): Effect.Effect<unknown, CodexErrors.CodexAppServerError> =>
    Effect.suspend(() => {
      if (session.closed || !session.connection || session.connection.terminated) {
        return Effect.fail(makeTransportError("Codex app-server session is closed."));
      }
      return ensureClient().pipe(
        Effect.flatMap((client) =>
          requestWithSessionRouting(session, method, payload, () =>
            client.request(method as never, payload as never),
          ),
        ),
      );
    });

  const rawRequestFromSession = (
    session: NativeSession,
    method: string,
    payload?: unknown,
  ): Effect.Effect<unknown, CodexErrors.CodexAppServerError> =>
    Effect.suspend(() => {
      if (session.closed || !session.connection || session.connection.terminated) {
        return Effect.fail(makeTransportError("Codex app-server session is closed."));
      }
      return ensureClient().pipe(
        Effect.flatMap((client) =>
          requestWithSessionRouting(session, method, payload, () =>
            client.raw.request(method, payload),
          ),
        ),
      );
    });

  const listThreads: CodexAppServerManagerShape["listThreads"] = (params = {}) =>
    Effect.gen(function* () {
      const client = yield* ensureClient();
      const threads: Array<CodexSchema.V2ThreadListResponse__Thread> = [];
      let cursor = params.cursor ?? undefined;
      const seenCursors = new Set<string>();

      for (;;) {
        const pageParams =
          cursor === undefined
            ? params
            : {
                ...params,
                cursor,
              };
        const page = yield* client.request("thread/list", pageParams);
        threads.push(...page.data);
        const nextCursor = page.nextCursor ?? undefined;
        if (nextCursor === undefined) {
          return threads;
        }
        if (seenCursors.has(nextCursor)) {
          return yield* makeTransportError(
            `Codex app-server returned a repeated thread/list cursor '${nextCursor}'.`,
          );
        }
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
    });

  const readThread: CodexAppServerManagerShape["readThread"] = (nativeThreadId) =>
    ensureClient().pipe(
      Effect.flatMap((client) =>
        client
          .request("thread/read", {
            threadId: nativeThreadId,
            includeTurns: false,
          })
          .pipe(
            Effect.flatMap((metadataResponse) =>
              readPaginatedCodexTurns(client, nativeThreadId).pipe(
                Effect.flatMap((turns) => {
                  const nativeUpdatedAt = readFiniteNumber(metadataResponse.thread.updatedAt);
                  const latestIndexedTurnAt = turns.reduce(
                    (latest, turn) =>
                      Math.max(
                        latest,
                        turn.completedAt ?? turn.startedAt ?? Number.MIN_SAFE_INTEGER,
                      ),
                    Number.MIN_SAFE_INTEGER,
                  );
                  const rolloutPath = readString(metadataResponse.thread.path);
                  const historyLooksStale =
                    rolloutPath !== undefined &&
                    (turns.length === 0 ||
                      (nativeUpdatedAt !== undefined && nativeUpdatedAt > latestIndexedTurnAt + 1));
                  if (!historyLooksStale) {
                    return Effect.succeed({
                      ...metadataResponse.thread,
                      turns,
                    });
                  }

                  return Effect.gen(function* () {
                    const stat = yield* Effect.try({
                      try: () => NodeFS.statSync(rolloutPath),
                      catch: () => undefined,
                    });
                    if (stat === undefined || !stat.isFile()) {
                      return {
                        ...metadataResponse.thread,
                        turns,
                      };
                    }

                    const cached = rolloutHistoryCache.get(rolloutPath);
                    const rolloutTurns =
                      cached?.size === stat.size && cached.mtimeMs === stat.mtimeMs
                        ? cached.turns
                        : yield* Effect.tryPromise({
                            try: () => readCodexRolloutTurns(rolloutPath),
                            catch: (cause) =>
                              makeTransportError(
                                `Could not recover Codex rollout history from ${rolloutPath}.`,
                                cause,
                              ),
                          });
                    rolloutHistoryCache.set(rolloutPath, {
                      size: stat.size,
                      mtimeMs: stat.mtimeMs,
                      turns: rolloutTurns,
                    });
                    return {
                      ...metadataResponse.thread,
                      turns: mergeCodexTurns(turns, rolloutTurns),
                    };
                  }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("could not recover stale Codex rollout history", {
                        nativeThreadId,
                        rolloutPath,
                        cause,
                      }).pipe(
                        Effect.as({
                          ...metadataResponse.thread,
                          turns,
                        }),
                      ),
                    ),
                  );
                }),
                // Older app-server versions predate the paginated history
                // methods. Keep those installations usable with their legacy
                // full-history response until they are upgraded.
                Effect.catchIf(isPaginationUnavailable, () =>
                  client
                    .request("thread/read", {
                      threadId: nativeThreadId,
                      includeTurns: true,
                    })
                    .pipe(Effect.map((response) => response.thread)),
                ),
              ),
            ),
          ),
      ),
    );

  const openSession = Effect.fn("CodexAppServerManager.openSession")(function* (
    input: CodexAppServerSessionOptions,
  ) {
    const session: NativeSession = {
      threadId: input.threadId,
      connection: undefined,
      rawNotifications:
        yield* Queue.sliding<CodexAppServerIncomingNotification>(MAX_SESSION_RAW_MESSAGES),
      rawRequests: yield* Queue.sliding<CodexAppServerIncomingRequest>(MAX_SESSION_RAW_MESSAGES),
      stderr: yield* Queue.unbounded<string>(),
      pendingNotifications: [],
      nativeThreadIds: new Set(),
      requestHandlers: new Map(),
      notificationHandlers: new Map(),
      unknownRequestHandler: undefined,
      unknownNotificationHandler: undefined,
      closed: false,
    };
    if (input.resumeThreadId) {
      bindNativeThread(session, input.resumeThreadId);
    }

    const client = yield* ensureClient().pipe(
      Effect.tapError(() => Effect.sync(() => removeSession(session))),
    );
    const connection = activeConnection;
    if (!connection || connection.client !== client || connection.terminated) {
      removeSession(session);
      return yield* makeTransportError("Codex app-server connection closed during session setup.");
    }
    // Publish the binding before draining connection-level buffers. The raw
    // and typed dispatchers can receive a message as soon as ensureClient
    // yields, and it must not be left behind for a later session.
    session.connection = connection;
    sessions.add(session);
    lastRequestOwner = session;
    session.pendingNotifications.push(...connection.pendingNotifications.splice(0));
    const pendingRawNotifications = connection.pendingRawNotifications.splice(0);
    const pendingRawRequests = connection.pendingRawRequests.splice(0);
    const pendingStderr = connection.pendingStderr.splice(0);
    yield* Effect.forEach(
      pendingRawNotifications,
      (notification) => Queue.offer(session.rawNotifications, notification),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(
      pendingRawRequests,
      (request) => Queue.offer(session.rawRequests, request),
      { concurrency: 1, discard: true },
    );
    yield* Effect.forEach(pendingStderr, (chunk) => Queue.offer(session.stderr, chunk), {
      concurrency: 1,
      discard: true,
    });
    const sessionClient = CodexClient.CodexAppServerClient.of({
      raw: {
        notifications: Stream.fromQueue(session.rawNotifications),
        requests: Stream.fromQueue(session.rawRequests),
        request: (method, payload) => rawRequestFromSession(session, method, payload),
        notify: (method, payload) =>
          Effect.suspend(() => {
            if (session.closed || !session.connection || session.connection.terminated) {
              return Effect.fail(makeTransportError("Codex app-server session is closed."));
            }
            return ensureClient().pipe(
              Effect.flatMap((current) => current.raw.notify(method, payload)),
            );
          }),
        respond: (requestId, result) =>
          Effect.suspend(() => {
            if (session.closed || !session.connection || session.connection.terminated) {
              return Effect.fail(makeTransportError("Codex app-server session is closed."));
            }
            return ensureClient().pipe(
              Effect.flatMap((current) => current.raw.respond(requestId, result)),
            );
          }),
        respondError: (requestId, error) =>
          Effect.suspend(() => {
            if (session.closed || !session.connection || session.connection.terminated) {
              return Effect.fail(makeTransportError("Codex app-server session is closed."));
            }
            return ensureClient().pipe(
              Effect.flatMap((current) => current.raw.respondError(requestId, error)),
            );
          }),
      },
      request: (method, payload) => requestFromSession(session, method, payload) as never,
      notify: (method, payload) =>
        Effect.suspend(() => {
          if (session.closed || !session.connection || session.connection.terminated) {
            return Effect.fail(makeTransportError("Codex app-server session is closed."));
          }
          return ensureClient().pipe(Effect.flatMap((current) => current.notify(method, payload)));
        }),
      handleServerRequest: (method, handler) =>
        Effect.sync(() => {
          session.requestHandlers.set(method, handler as ServerRequestHandler);
        }),
      handleServerNotification: (method, handler) =>
        Effect.gen(function* () {
          const typedHandler = handler as ServerNotificationHandler;
          const handlers = session.notificationHandlers.get(method) ?? [];
          handlers.push(typedHandler);
          session.notificationHandlers.set(method, handlers);
          yield* replayPendingNotifications(
            session,
            (pendingMethod) => pendingMethod === method,
            (_pendingMethod, payload) => typedHandler(payload),
          ).pipe(Effect.ignore);
        }),
      handleUnknownServerRequest: (handler) =>
        Effect.sync(() => {
          session.unknownRequestHandler = handler;
        }),
      handleUnknownServerNotification: (handler) =>
        Effect.gen(function* () {
          const unknownHandler = handler;
          session.unknownNotificationHandler = unknownHandler;
          yield* replayPendingNotifications(
            session,
            (pendingMethod) => !session.notificationHandlers.has(pendingMethod),
            unknownHandler,
          ).pipe(Effect.ignore);
        }),
    });
    return {
      client: sessionClient,
      appServerExit: Deferred.await(connection.appServerExit),
      isConnected: Effect.sync(
        () => !session.closed && session.connection === connection && !connection.terminated,
      ),
      stderr: Stream.fromQueue(session.stderr),
      close: Effect.sync(() => removeSession(session)),
    } satisfies CodexAppServerSession;
  });

  const closeSession = (threadId: ThreadId) =>
    Effect.sync(() => {
      for (const session of sessions) {
        if (session.threadId === threadId) {
          removeSession(session);
        }
      }
    });

  const close = Effect.gen(function* () {
    const alreadyClosed = yield* Ref.getAndSet(closedRef, true);
    if (alreadyClosed) {
      return;
    }
    yield* initializationLock.withPermits(1)(cleanupConnection());
  });

  yield* Effect.addFinalizer(() => close);

  return {
    openSession,
    closeSession,
    listThreads,
    readThread,
    close,
  } satisfies CodexAppServerManagerShape;
});
