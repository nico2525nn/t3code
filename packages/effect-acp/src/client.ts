import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcServer from "effect/unstable/rpc/RpcServer";

import { makeStdioFromChildProcess } from "./child-process";
import * as AcpError from "./errors";
import * as AcpProtocol from "./protocol";
import * as AcpRpcs from "./rpc";
import * as AcpServer from "./server";
import * as AcpSchema from "./_generated/schema.gen";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export interface AcpClientHandlers {
  /**
   * Handles `session/request_permission`.
   * @see https://agentclientprotocol.com/protocol/schema#session/request_permission
   */
  readonly requestPermission?: (
    request: AcpSchema.RequestPermissionRequest,
  ) => Effect.Effect<AcpSchema.RequestPermissionResponse, AcpError.AcpError>;
  /**
   * Handles `session/elicitation`.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation
   */
  readonly elicitation?: (
    request: AcpSchema.ElicitationRequest,
  ) => Effect.Effect<AcpSchema.ElicitationResponse, AcpError.AcpError>;
  /**
   * Handles `fs/read_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/read_text_file
   */
  readonly readTextFile?: (
    request: AcpSchema.ReadTextFileRequest,
  ) => Effect.Effect<AcpSchema.ReadTextFileResponse, AcpError.AcpError>;
  /**
   * Handles `fs/write_text_file`.
   * @see https://agentclientprotocol.com/protocol/schema#fs/write_text_file
   */
  readonly writeTextFile?: (
    request: AcpSchema.WriteTextFileRequest,
  ) => Effect.Effect<AcpSchema.WriteTextFileResponse | void, AcpError.AcpError>;
  /**
   * Handles `terminal/create`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/create
   */
  readonly createTerminal?: (
    request: AcpSchema.CreateTerminalRequest,
  ) => Effect.Effect<AcpSchema.CreateTerminalResponse, AcpError.AcpError>;
  /**
   * Handles `terminal/output`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/output
   */
  readonly terminalOutput?: (
    request: AcpSchema.TerminalOutputRequest,
  ) => Effect.Effect<AcpSchema.TerminalOutputResponse, AcpError.AcpError>;
  /**
   * Handles `terminal/wait_for_exit`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/wait_for_exit
   */
  readonly terminalWaitForExit?: (
    request: AcpSchema.WaitForTerminalExitRequest,
  ) => Effect.Effect<AcpSchema.WaitForTerminalExitResponse, AcpError.AcpError>;
  /**
   * Handles `terminal/kill`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/kill
   */
  readonly terminalKill?: (
    request: AcpSchema.KillTerminalRequest,
  ) => Effect.Effect<AcpSchema.KillTerminalResponse | void, AcpError.AcpError>;
  /**
   * Handles `terminal/release`.
   * @see https://agentclientprotocol.com/protocol/schema#terminal/release
   */
  readonly terminalRelease?: (
    request: AcpSchema.ReleaseTerminalRequest,
  ) => Effect.Effect<AcpSchema.ReleaseTerminalResponse | void, AcpError.AcpError>;
  /**
   * Handles `session/update` notifications from the agent.
   * @see https://agentclientprotocol.com/protocol/schema#session/update
   */
  readonly sessionUpdate?: (
    notification: AcpSchema.SessionNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
  /**
   * Handles `session/elicitation/complete` notifications from the agent.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
   */
  readonly elicitationComplete?: (
    notification: AcpSchema.ElicitationCompleteNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
  /**
   * Handles extension requests outside the core ACP method set.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly extRequest?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError>;
  /**
   * Handles extension notifications outside the core ACP method set.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly extNotification?: (
    method: string,
    params: unknown,
  ) => Effect.Effect<void, AcpError.AcpError>;
}

export interface AcpClientConnectOptions {
  readonly command: ChildProcess.Command;
  readonly handlers?: AcpClientHandlers;
}

export interface AcpClientConnection {
  readonly process: ChildProcessSpawner.ChildProcessHandle;
  /**
   * Stream of inbound ACP notifications observed on the connection.
   * @see https://agentclientprotocol.com/protocol/schema#session/update
   */
  readonly updates: Stream.Stream<AcpProtocol.AcpIncomingNotification>;
  readonly server: AcpServer.AcpServerConnection;
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
  /** Loads a previously saved ACP session.
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
  readonly extRequest: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError>;
  /**
   * Sends an ACP extension notification.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly extNotification: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, AcpError.AcpError>;
}

export const fromChildProcess = Effect.fnUntraced(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  options: {
    readonly handlers?: AcpClientHandlers;
  } = {},
): Effect.fn.Return<AcpClientConnection, never, Scope.Scope> {
  const handlers = options.handlers ?? {};
  const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
    stdio: makeStdioFromChildProcess(handle),
    serverRequestMethods: new Set(AcpRpcs.ClientRpcs.requests.keys()),
    onNotification: (notification) => {
      switch (notification._tag) {
        case "SessionUpdate":
          return handlers.sessionUpdate ? handlers.sessionUpdate(notification.params) : Effect.void;
        case "ElicitationComplete":
          return handlers.elicitationComplete
            ? handlers.elicitationComplete(notification.params)
            : Effect.void;
        case "ExtNotification":
          return handlers.extNotification
            ? handlers.extNotification(notification.method, notification.params)
            : Effect.void;
        case "SessionCancel":
          return handlers.extNotification
            ? handlers.extNotification(notification.method, notification.params)
            : Effect.void;
      }
    },
    ...(handlers.extRequest ? { onExtRequest: handlers.extRequest } : {}),
  });

  const clientHandlerLayer = AcpRpcs.ClientRpcs.toLayer(
    AcpRpcs.ClientRpcs.of({
      [CLIENT_METHODS.session_request_permission]: (payload) =>
        runHandler(handlers.requestPermission, payload, CLIENT_METHODS.session_request_permission),
      [CLIENT_METHODS.session_elicitation]: (payload) =>
        runHandler(handlers.elicitation, payload, CLIENT_METHODS.session_elicitation),
      [CLIENT_METHODS.fs_read_text_file]: (payload) =>
        runHandler(handlers.readTextFile, payload, CLIENT_METHODS.fs_read_text_file),
      [CLIENT_METHODS.fs_write_text_file]: (payload) =>
        runHandler(handlers.writeTextFile, payload, CLIENT_METHODS.fs_write_text_file).pipe(
          Effect.map((result) => result ?? {}),
        ),
      [CLIENT_METHODS.terminal_create]: (payload) =>
        runHandler(handlers.createTerminal, payload, CLIENT_METHODS.terminal_create),
      [CLIENT_METHODS.terminal_output]: (payload) =>
        runHandler(handlers.terminalOutput, payload, CLIENT_METHODS.terminal_output),
      [CLIENT_METHODS.terminal_wait_for_exit]: (payload) =>
        runHandler(handlers.terminalWaitForExit, payload, CLIENT_METHODS.terminal_wait_for_exit),
      [CLIENT_METHODS.terminal_kill]: (payload) =>
        runHandler(handlers.terminalKill, payload, CLIENT_METHODS.terminal_kill).pipe(
          Effect.map((result) => result ?? {}),
        ),
      [CLIENT_METHODS.terminal_release]: (payload) =>
        runHandler(handlers.terminalRelease, payload, CLIENT_METHODS.terminal_release).pipe(
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

  const callRpc = <A, E>(effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError(AcpError.normalizeAcpError));

  const server = AcpServer.makeAcpServerConnection(transport);

  return {
    process: handle,
    updates: transport.notifications.incoming,
    server,
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
    cancel: (payload) => transport.notifications.sendSessionCancel(payload),
    extRequest: transport.sendRequest,
    extNotification: transport.notifications.sendExtNotification,
  } satisfies AcpClientConnection;
});

const runHandler = Effect.fnUntraced(function* <A, B>(
  handler: ((payload: A) => Effect.Effect<B, AcpError.AcpError>) | undefined,
  payload: A,
  method: string,
) {
  if (!handler) {
    return yield* AcpError.AcpRequestError.methodNotFound(method);
  }
  return yield* handler(payload).pipe(
    Effect.mapError((error) => {
      const normalized = AcpError.normalizeAcpError(error);
      return Schema.is(AcpError.AcpRequestError)(normalized)
        ? normalized.toProtocolError()
        : AcpError.AcpRequestError.internalError(normalized.message).toProtocolError();
    }),
  );
});
