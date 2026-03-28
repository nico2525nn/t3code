import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { ChildProcessSpawner } from "effect/unstable/process";
import { RpcClientError } from "effect/unstable/rpc";

import * as AcpError from "./errors";
import * as AcpProtocol from "./protocol";
import * as AcpRpcs from "./rpc";
import * as AcpSchema from "./_generated/schema.gen";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen";
import * as AcpTerminal from "./terminal";

export interface AcpConnectionOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: AcpProtocol.AcpProtocolLogEvent) => Effect.Effect<void, never>;
}

export interface AcpConnectionShape {
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  /**
   * Stream of inbound ACP notifications observed on the connection.
   * @see https://agentclientprotocol.com/protocol/schema#session/update
   */
  readonly notifications: Stream.Stream<AcpProtocol.AcpIncomingNotification>;
  /**
   * Registers a handler for `session/request_permission`.
   * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
   */
  readonly handleRequestPermission: (
    handler: (
      request: AcpSchema.RequestPermissionRequest,
    ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `session/elicitation`.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
   */
  readonly handleElicitation: (
    handler: (
      request: AcpSchema.ElicitationRequest,
    ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `fs/read_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
   */
  readonly handleReadTextFile: (
    handler: (
      request: AcpSchema.ReadTextFileRequest,
    ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `fs/write_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
   */
  readonly handleWriteTextFile: (
    handler: (
      request: AcpSchema.WriteTextFileRequest,
    ) => Effect.Effect<AcpSchema.WriteTextFileResponse | void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/create`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/create
   */
  readonly handleCreateTerminal: (
    handler: (
      request: AcpSchema.CreateTerminalRequest,
    ) => Effect.Effect<AcpSchema.CreateTerminalResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/output`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/output
   */
  readonly handleTerminalOutput: (
    handler: (
      request: AcpSchema.TerminalOutputRequest,
    ) => Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/wait_for_exit`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
   */
  readonly handleTerminalWaitForExit: (
    handler: (
      request: AcpSchema.WaitForTerminalExitRequest,
    ) => Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/kill`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
   */
  readonly handleTerminalKill: (
    handler: (
      request: AcpSchema.KillTerminalRequest,
    ) => Effect.Effect<AcpSchema.KillTerminalResponse | void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `terminal/release`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/release
   */
  readonly handleTerminalRelease: (
    handler: (
      request: AcpSchema.ReleaseTerminalRequest,
    ) => Effect.Effect<AcpSchema.ReleaseTerminalResponse | void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `session/update`.
   * @see https://agentclientprotocol.com/protocol/schema#session/update
   */
  readonly handleSessionUpdate: (
    handler: (
      notification: AcpSchema.SessionNotification,
    ) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a handler for `session/elicitation/complete`.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
   */
  readonly handleElicitationComplete: (
    handler: (
      notification: AcpSchema.ElicitationCompleteNotification,
    ) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a fallback extension request handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleUnknownExtRequest: (
    handler: (method: string, params: unknown) => Effect.Effect<unknown, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a fallback extension notification handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleUnknownExtNotification: (
    handler: (method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a typed extension request handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleExtRequest: <A, I>(
    method: string,
    payload: Schema.Codec<A, I>,
    handler: (payload: A) => Effect.Effect<unknown, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Registers a typed extension notification handler.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly handleExtNotification: <A, I>(
    method: string,
    payload: Schema.Codec<A, I>,
    handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
  ) => Effect.Effect<void>;
  /**
   * Initializes the ACP session and negotiates capabilities.
   * @see https://agentclientprotocol.com/protocol/schema#initialize
   */
  readonly initialize: (
    payload: AcpSchema.InitializeRequest,
  ) => Effect.Effect<AcpSchema.InitializeResponse, AcpError.AcpError>;
  /**
   * Performs ACP authentication when the agent requires it.
   * @see https://agentclientprotocol.com/protocol/schema#authenticate
   */
  readonly authenticate: (
    payload: AcpSchema.AuthenticateRequest,
  ) => Effect.Effect<AcpSchema.AuthenticateResponse, AcpError.AcpError>;
  /**
   * Logs out the current ACP identity.
   * @see https://agentclientprotocol.com/protocol/schema#logout
   */
  readonly logout: (
    payload: AcpSchema.LogoutRequest,
  ) => Effect.Effect<AcpSchema.LogoutResponse, AcpError.AcpError>;
  /**
   * Starts a new ACP session.
   * @see https://agentclientprotocol.com/protocol/schema#session/new
   */
  readonly createSession: (
    payload: AcpSchema.NewSessionRequest,
  ) => Effect.Effect<AcpSchema.NewSessionResponse, AcpError.AcpError>;
  /**
   * Loads a previously saved ACP session.
   * @see https://agentclientprotocol.com/protocol/schema#session/load
   */
  readonly loadSession: (
    payload: AcpSchema.LoadSessionRequest,
  ) => Effect.Effect<AcpSchema.LoadSessionResponse, AcpError.AcpError>;
  /**
   * Lists available ACP sessions.
   * @see https://agentclientprotocol.com/protocol/schema#session/list
   */
  readonly listSessions: (
    payload: AcpSchema.ListSessionsRequest,
  ) => Effect.Effect<AcpSchema.ListSessionsResponse, AcpError.AcpError>;
  /**
   * Forks an ACP session.
   * @see https://agentclientprotocol.com/protocol/schema#session/fork
   */
  readonly forkSession: (
    payload: AcpSchema.ForkSessionRequest,
  ) => Effect.Effect<AcpSchema.ForkSessionResponse, AcpError.AcpError>;
  /**
   * Resumes an ACP session.
   * @see https://agentclientprotocol.com/protocol/schema#session/resume
   */
  readonly resumeSession: (
    payload: AcpSchema.ResumeSessionRequest,
  ) => Effect.Effect<AcpSchema.ResumeSessionResponse, AcpError.AcpError>;
  /**
   * Closes an ACP session.
   * @see https://agentclientprotocol.com/protocol/schema#session/close
   */
  readonly closeSession: (
    payload: AcpSchema.CloseSessionRequest,
  ) => Effect.Effect<AcpSchema.CloseSessionResponse, AcpError.AcpError>;
  /**
   * Changes the current session mode.
   * @see https://agentclientprotocol.com/protocol/schema#session/set_mode
   */
  readonly setSessionMode: (
    payload: AcpSchema.SetSessionModeRequest,
  ) => Effect.Effect<AcpSchema.SetSessionModeResponse, AcpError.AcpError>;
  /**
   * Selects the active model for a session.
   * @see https://agentclientprotocol.com/protocol/schema#session/set_model
   */
  readonly setSessionModel: (
    payload: AcpSchema.SetSessionModelRequest,
  ) => Effect.Effect<AcpSchema.SetSessionModelResponse, AcpError.AcpError>;
  /**
   * Updates a session configuration option.
   * @see https://agentclientprotocol.com/protocol/schema#session/set_config_option
   */
  readonly setSessionConfigOption: (
    payload: AcpSchema.SetSessionConfigOptionRequest,
  ) => Effect.Effect<AcpSchema.SetSessionConfigOptionResponse, AcpError.AcpError>;
  /**
   * Sends a prompt turn to the agent.
   * @see https://agentclientprotocol.com/protocol/schema#session/prompt
   */
  readonly prompt: (
    payload: AcpSchema.PromptRequest,
  ) => Effect.Effect<AcpSchema.PromptResponse, AcpError.AcpError>;
  /**
   * Sends a real ACP `session/cancel` notification.
   * @see https://agentclientprotocol.com/protocol/schema#session/cancel
   */
  readonly cancel: (
    payload: AcpSchema.CancelNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
  /**
   * Sends an ACP extension request.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly request: (method: string, payload: unknown) => Effect.Effect<unknown, AcpError.AcpError>;
  /**
   * Sends an ACP extension notification.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly notify: (method: string, payload: unknown) => Effect.Effect<void, AcpError.AcpError>;
  /**
   * Requests client permission for an operation.
   * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
   */
  readonly requestPermission: (
    payload: AcpSchema.RequestPermissionRequest,
  ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>;
  /**
   * Requests structured user input from the client.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
   */
  readonly elicit: (
    payload: AcpSchema.ElicitationRequest,
  ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>;
  /**
   * Requests file contents from the client.
   * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
   */
  readonly readTextFile: (
    payload: AcpSchema.ReadTextFileRequest,
  ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>;
  /**
   * Writes a text file through the client.
   * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
   */
  readonly writeTextFile: (
    payload: AcpSchema.WriteTextFileRequest,
  ) => Effect.Effect<AcpSchema.WriteTextFileResponse, AcpError.AcpError>;
  /**
   * Creates a terminal on the client side.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/create
   */
  readonly createTerminal: (
    payload: AcpSchema.CreateTerminalRequest,
  ) => Effect.Effect<AcpTerminal.AcpTerminal, AcpError.AcpError>;
  /**
   * Sends a `session/update` notification to the client.
   * @see https://agentclientprotocol.com/protocol/schema#session/update
   */
  readonly sessionUpdate: (
    payload: AcpSchema.SessionNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
  /**
   * Sends a `session/elicitation/complete` notification to the client.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
   */
  readonly elicitationComplete: (
    payload: AcpSchema.ElicitationCompleteNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
}

export class AcpConnection extends ServiceMap.Service<AcpConnection, AcpConnectionShape>()(
  "effect-acp/AcpConnection",
) {}

interface AcpCoreRequestHandlers {
  /**
   * Handles `session/request_permission`.
   * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
   */
  requestPermission?: (
    request: AcpSchema.RequestPermissionRequest,
  ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>;
  /**
   * Handles `session/elicitation`.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
   */
  elicitation?: (
    request: AcpSchema.ElicitationRequest,
  ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>;
  /**
   * Handles `fs/read_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
   */
  readTextFile?: (
    request: AcpSchema.ReadTextFileRequest,
  ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>;
  /**
   * Handles `fs/write_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
   */
  writeTextFile?: (
    request: AcpSchema.WriteTextFileRequest,
  ) => Effect.Effect<AcpSchema.WriteTextFileResponse | void, AcpError.AcpError>;
  /**
   * Handles `terminal/create`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/create
   */
  createTerminal?: (
    request: AcpSchema.CreateTerminalRequest,
  ) => Effect.Effect<AcpSchema.CreateTerminalResponse, AcpError.AcpError>;
  /**
   * Handles `terminal/output`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/output
   */
  terminalOutput?: (
    request: AcpSchema.TerminalOutputRequest,
  ) => Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>;
  /**
   * Handles `terminal/wait_for_exit`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
   */
  terminalWaitForExit?: (
    request: AcpSchema.WaitForTerminalExitRequest,
  ) => Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>;
  /**
   * Handles `terminal/kill`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
   */
  terminalKill?: (
    request: AcpSchema.KillTerminalRequest,
  ) => Effect.Effect<AcpSchema.KillTerminalResponse | void, AcpError.AcpError>;
  /**
   * Handles `terminal/release`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/release
   */
  terminalRelease?: (
    request: AcpSchema.ReleaseTerminalRequest,
  ) => Effect.Effect<AcpSchema.ReleaseTerminalResponse | void, AcpError.AcpError>;
}

interface AcpNotificationHandlers {
  readonly sessionUpdate: Array<
    (notification: AcpSchema.SessionNotification) => Effect.Effect<void, AcpError.AcpError>
  >;
  readonly elicitationComplete: Array<
    (
      notification: AcpSchema.ElicitationCompleteNotification,
    ) => Effect.Effect<void, AcpError.AcpError>
  >;
}

const formatSchemaIssue = SchemaIssue.makeFormatterDefault();
const textEncoder = new TextEncoder();

export const makeFromChildProcessHandle = Effect.fn("makeFromChildProcessHandle")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: AcpConnectionOptions = {},
): Effect.fn.Return<AcpConnectionShape, never, Scope.Scope> {
  const coreHandlers: AcpCoreRequestHandlers = {};
  const notificationHandlers: AcpNotificationHandlers = {
    sessionUpdate: [],
    elicitationComplete: [],
  };
  const extRequestHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<unknown, AcpError.AcpError>
  >();
  const extNotificationHandlers = new Map<
    string,
    (params: unknown) => Effect.Effect<void, AcpError.AcpError>
  >();
  let unknownExtRequestHandler:
    | ((method: string, params: unknown) => Effect.Effect<unknown, AcpError.AcpError>)
    | undefined;
  let unknownExtNotificationHandler:
    | ((method: string, params: unknown) => Effect.Effect<void, AcpError.AcpError>)
    | undefined;

  const dispatchNotification = (notification: AcpProtocol.AcpIncomingNotification) => {
    switch (notification._tag) {
      case "SessionUpdate":
        return Effect.forEach(
          notificationHandlers.sessionUpdate,
          (handler) => handler(notification.params),
          { discard: true },
        );
      case "ElicitationComplete":
        return Effect.forEach(
          notificationHandlers.elicitationComplete,
          (handler) => handler(notification.params),
          { discard: true },
        );
      case "ExtNotification": {
        const handler = extNotificationHandlers.get(notification.method);
        if (handler) {
          return handler(notification.params);
        }
        return unknownExtNotificationHandler
          ? unknownExtNotificationHandler(notification.method, notification.params)
          : Effect.void;
      }
    }
  };

  const dispatchExtRequest = (method: string, params: unknown) => {
    const handler = extRequestHandlers.get(method);
    if (handler) {
      return handler(params);
    }
    return unknownExtRequestHandler
      ? unknownExtRequestHandler(method, params)
      : Effect.fail(AcpError.AcpRequestError.methodNotFound(method));
  };

  const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
    stdio: makeStdioFromChildProcess(handle),
    serverRequestMethods: new Set(AcpRpcs.ClientRpcs.requests.keys()),
    ...(options.logIncoming !== undefined ? { logIncoming: options.logIncoming } : {}),
    ...(options.logOutgoing !== undefined ? { logOutgoing: options.logOutgoing } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    onNotification: dispatchNotification,
    onExtRequest: dispatchExtRequest,
  });

  const clientHandlerLayer = AcpRpcs.ClientRpcs.toLayer(
    AcpRpcs.ClientRpcs.of({
      [CLIENT_METHODS.session_request_permission]: (payload) =>
        runHandler(
          coreHandlers.requestPermission,
          payload,
          CLIENT_METHODS.session_request_permission,
        ),
      [CLIENT_METHODS.session_elicitation]: (payload) =>
        runHandler(coreHandlers.elicitation, payload, CLIENT_METHODS.session_elicitation),
      [CLIENT_METHODS.fs_read_text_file]: (payload) =>
        runHandler(coreHandlers.readTextFile, payload, CLIENT_METHODS.fs_read_text_file),
      [CLIENT_METHODS.fs_write_text_file]: (payload) =>
        runHandler(coreHandlers.writeTextFile, payload, CLIENT_METHODS.fs_write_text_file).pipe(
          Effect.map((result) => result ?? {}),
        ),
      [CLIENT_METHODS.terminal_create]: (payload) =>
        runHandler(coreHandlers.createTerminal, payload, CLIENT_METHODS.terminal_create),
      [CLIENT_METHODS.terminal_output]: (payload) =>
        runHandler(coreHandlers.terminalOutput, payload, CLIENT_METHODS.terminal_output),
      [CLIENT_METHODS.terminal_wait_for_exit]: (payload) =>
        runHandler(
          coreHandlers.terminalWaitForExit,
          payload,
          CLIENT_METHODS.terminal_wait_for_exit,
        ),
      [CLIENT_METHODS.terminal_kill]: (payload) =>
        runHandler(coreHandlers.terminalKill, payload, CLIENT_METHODS.terminal_kill).pipe(
          Effect.map((result) => result ?? {}),
        ),
      [CLIENT_METHODS.terminal_release]: (payload) =>
        runHandler(coreHandlers.terminalRelease, payload, CLIENT_METHODS.terminal_release).pipe(
          Effect.map((result) => result ?? {}),
        ),
    }),
  );

  yield* RpcServer.make(AcpRpcs.ClientRpcs).pipe(
    Effect.provideService(RpcServer.Protocol, transport.serverProtocol),
    Effect.provide(clientHandlerLayer),
    Effect.forkScoped,
  );

  const rpc = yield* RpcClient.make(AcpRpcs.AgentRpcs).pipe(
    Effect.provideService(RpcClient.Protocol, transport.clientProtocol),
  );

  const callRpc = <A>(effect: Effect.Effect<A, RpcClientError.RpcClientError | AcpSchema.Error>) =>
    effect.pipe(
      Effect.catchTag("RpcClientError", (error) =>
        Effect.fail(
          new AcpError.AcpTransportError({
            detail: error.message,
            cause: error,
          }),
        ),
      ),
      Effect.catchIf(Schema.is(AcpSchema.Error), (error) =>
        Effect.fail(AcpError.AcpRequestError.fromProtocolError(error)),
      ),
    );

  const request = <A>(method: string, payload: unknown) =>
    transport.request(method, payload).pipe(Effect.map((value) => value as A));

  return AcpConnection.of({
    process: handle,
    notifications: transport.incoming,
    handleRequestPermission: (handler) =>
      Effect.suspend(() => {
        coreHandlers.requestPermission = handler;
        return Effect.void;
      }),
    handleElicitation: (handler) =>
      Effect.suspend(() => {
        coreHandlers.elicitation = handler;
        return Effect.void;
      }),
    handleReadTextFile: (handler) =>
      Effect.suspend(() => {
        coreHandlers.readTextFile = handler;
        return Effect.void;
      }),
    handleWriteTextFile: (handler) =>
      Effect.suspend(() => {
        coreHandlers.writeTextFile = handler;
        return Effect.void;
      }),
    handleCreateTerminal: (handler) =>
      Effect.suspend(() => {
        coreHandlers.createTerminal = handler;
        return Effect.void;
      }),
    handleTerminalOutput: (handler) =>
      Effect.suspend(() => {
        coreHandlers.terminalOutput = handler;
        return Effect.void;
      }),
    handleTerminalWaitForExit: (handler) =>
      Effect.suspend(() => {
        coreHandlers.terminalWaitForExit = handler;
        return Effect.void;
      }),
    handleTerminalKill: (handler) =>
      Effect.suspend(() => {
        coreHandlers.terminalKill = handler;
        return Effect.void;
      }),
    handleTerminalRelease: (handler) =>
      Effect.suspend(() => {
        coreHandlers.terminalRelease = handler;
        return Effect.void;
      }),
    handleSessionUpdate: (handler) =>
      Effect.suspend(() => {
        notificationHandlers.sessionUpdate.push(handler);
        return Effect.void;
      }),
    handleElicitationComplete: (handler) =>
      Effect.suspend(() => {
        notificationHandlers.elicitationComplete.push(handler);
        return Effect.void;
      }),
    handleUnknownExtRequest: (handler) =>
      Effect.suspend(() => {
        unknownExtRequestHandler = handler;
        return Effect.void;
      }),
    handleUnknownExtNotification: (handler) =>
      Effect.suspend(() => {
        unknownExtNotificationHandler = handler;
        return Effect.void;
      }),
    handleExtRequest: (method, payload, handler) =>
      Effect.suspend(() => {
        extRequestHandlers.set(method, decodeExtRequestRegistration(method, payload, handler));
        return Effect.void;
      }),
    handleExtNotification: (method, payload, handler) =>
      Effect.suspend(() => {
        extNotificationHandlers.set(
          method,
          decodeExtNotificationRegistration(method, payload, handler),
        );
        return Effect.void;
      }),
    initialize: (payload) => callRpc(rpc[AGENT_METHODS.initialize](payload)),
    authenticate: (payload) => callRpc(rpc[AGENT_METHODS.authenticate](payload)),
    logout: (payload) => callRpc(rpc[AGENT_METHODS.logout](payload)),
    createSession: (payload) => callRpc(rpc[AGENT_METHODS.session_new](payload)),
    loadSession: (payload) => callRpc(rpc[AGENT_METHODS.session_load](payload)),
    listSessions: (payload) => callRpc(rpc[AGENT_METHODS.session_list](payload)),
    forkSession: (payload) => callRpc(rpc[AGENT_METHODS.session_fork](payload)),
    resumeSession: (payload) => callRpc(rpc[AGENT_METHODS.session_resume](payload)),
    closeSession: (payload) => callRpc(rpc[AGENT_METHODS.session_close](payload)),
    setSessionMode: (payload) => callRpc(rpc[AGENT_METHODS.session_set_mode](payload)),
    setSessionModel: (payload) => callRpc(rpc[AGENT_METHODS.session_set_model](payload)),
    setSessionConfigOption: (payload) =>
      callRpc(rpc[AGENT_METHODS.session_set_config_option](payload)),
    prompt: (payload) => callRpc(rpc[AGENT_METHODS.session_prompt](payload)),
    cancel: (payload) => transport.notify("session/cancel", payload),
    request: transport.request,
    notify: transport.notify,
    requestPermission: (payload) =>
      request<AcpSchema.RequestPermissionResponse>(
        CLIENT_METHODS.session_request_permission,
        payload,
      ),
    elicit: (payload) =>
      request<AcpSchema.ElicitationResponse>(CLIENT_METHODS.session_elicitation, payload),
    readTextFile: (payload) =>
      request<AcpSchema.ReadTextFileResponse>(CLIENT_METHODS.fs_read_text_file, payload),
    writeTextFile: (payload) =>
      request<AcpSchema.WriteTextFileResponse>(CLIENT_METHODS.fs_write_text_file, payload).pipe(
        Effect.map((response) => response ?? {}),
      ),
    createTerminal: (payload) =>
      request<AcpSchema.CreateTerminalResponse>(CLIENT_METHODS.terminal_create, payload).pipe(
        Effect.map((response) =>
          AcpTerminal.makeTerminal({
            sessionId: payload.sessionId,
            terminalId: response.terminalId,
            output: request<AcpSchema.TerminalOutputResponse>(CLIENT_METHODS.terminal_output, {
              sessionId: payload.sessionId,
              terminalId: response.terminalId,
            }),
            waitForExit: request<AcpSchema.WaitForTerminalExitResponse>(
              CLIENT_METHODS.terminal_wait_for_exit,
              {
                sessionId: payload.sessionId,
                terminalId: response.terminalId,
              },
            ),
            kill: request<AcpSchema.KillTerminalResponse>(CLIENT_METHODS.terminal_kill, {
              sessionId: payload.sessionId,
              terminalId: response.terminalId,
            }).pipe(Effect.map((result) => result ?? {})),
            release: request<AcpSchema.ReleaseTerminalResponse>(CLIENT_METHODS.terminal_release, {
              sessionId: payload.sessionId,
              terminalId: response.terminalId,
            }).pipe(Effect.map((result) => result ?? {})),
          }),
        ),
      ),
    sessionUpdate: (payload) => transport.notify(CLIENT_METHODS.session_update, payload),
    elicitationComplete: (payload) =>
      transport.notify(CLIENT_METHODS.session_elicitation_complete, payload),
  } satisfies AcpConnectionShape);
});

export const layerFromChildProcessHandle = (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: AcpConnectionOptions = {},
): Layer.Layer<AcpConnection> =>
  Layer.effect(AcpConnection, makeFromChildProcessHandle(handle, options));

const runHandler = Effect.fnUntraced(function* <A, B>(
  handler: ((payload: A) => Effect.Effect<B, AcpError.AcpError>) | undefined,
  payload: A,
  method: string,
) {
  if (!handler) {
    return yield* AcpError.AcpRequestError.methodNotFound(method);
  }
  return yield* handler(payload).pipe(
    Effect.mapError((error) =>
      Schema.is(AcpError.AcpRequestError)(error)
        ? error.toProtocolError()
        : AcpError.AcpRequestError.internalError(error.message).toProtocolError(),
    ),
  );
});

function decodeExtRequestRegistration<A, I>(
  method: string,
  payload: Schema.Codec<A, I>,
  handler: (payload: A) => Effect.Effect<unknown, AcpError.AcpError>,
) {
  return (params: unknown): Effect.Effect<unknown, AcpError.AcpError> =>
    Schema.decodeUnknownEffect(payload)(params).pipe(
      Effect.mapError((error) =>
        AcpError.AcpRequestError.invalidParams(
          `Invalid ${method} payload: ${formatSchemaIssue(error.issue)}`,
          { issue: error.issue },
        ),
      ),
      Effect.flatMap((decoded) => handler(decoded)),
    );
}

function decodeExtNotificationRegistration<A, I>(
  method: string,
  payload: Schema.Codec<A, I>,
  handler: (payload: A) => Effect.Effect<void, AcpError.AcpError>,
) {
  return (params: unknown): Effect.Effect<void, AcpError.AcpError> =>
    Schema.decodeUnknownEffect(payload)(params).pipe(
      Effect.mapError(
        (error) =>
          new AcpError.AcpProtocolParseError({
            detail: `Invalid ${method} notification payload: ${formatSchemaIssue(error.issue)}`,
            cause: error,
          }),
      ),
      Effect.flatMap((decoded) => handler(decoded)),
    );
}

function makeStdioFromChildProcess(handle: ChildProcessSpawner.ChildProcessHandle): Stdio.Stdio {
  return Stdio.make({
    args: Effect.succeed([]),
    stdin: handle.stdout,
    stdout: () =>
      Sink.mapInput(handle.stdin, (chunk: string | Uint8Array) =>
        typeof chunk === "string" ? textEncoder.encode(chunk) : chunk,
      ),
    stderr: () => Sink.drain,
  });
}
