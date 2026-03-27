import * as Effect from "effect/Effect";

import * as AcpSchema from "./_generated/schema.gen";
import { CLIENT_METHODS } from "./_generated/meta.gen";
import type * as AcpError from "./errors";
import type * as AcpProtocol from "./protocol";
import * as AcpTerminal from "./terminal";

export interface AcpServerConnection {
  /**
   * Sends a `session/update` notification to the client.
   * @see https://agentclientprotocol.com/protocol/schema#session/update
   */
  readonly sessionUpdate: (
    payload: AcpSchema.SessionNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
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
   * Sends an ACP extension request.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly extRequest: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, AcpError.AcpError>;
  /**
   * Sends a `session/elicitation/complete` notification to the client.
   * @see https://agentclientprotocol.com/protocol/schema#session/elicitation/complete
   */
  readonly elicitationComplete: (
    payload: AcpSchema.ElicitationCompleteNotification,
  ) => Effect.Effect<void, AcpError.AcpError>;
  /**
   * Sends an ACP extension notification.
   * @see https://agentclientprotocol.com/protocol/extensibility
   */
  readonly extNotification: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, AcpError.AcpError>;
}

export const makeAcpServerConnection = (
  transport: AcpProtocol.AcpPatchedProtocol,
): AcpServerConnection => {
  const request = <A>(method: string, payload: unknown) =>
    transport.sendRequest(method, payload).pipe(Effect.map((value) => value as A));

  return {
    sessionUpdate: (payload) =>
      transport.notifications.sendExtNotification(CLIENT_METHODS.session_update, payload),
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
    extRequest: transport.sendRequest,
    elicitationComplete: (payload) =>
      transport.notifications.sendExtNotification(
        CLIENT_METHODS.session_elicitation_complete,
        payload,
      ),
    extNotification: transport.notifications.sendExtNotification,
  };
};
