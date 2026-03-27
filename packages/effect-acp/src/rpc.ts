import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import * as AcpSchema from "./_generated/schema.gen";
import { AGENT_METHODS, CLIENT_METHODS } from "./_generated/meta.gen";

function makeAcpRpc<
  const Tag extends string,
  Payload extends Schema.Top | Schema.Struct.Fields,
  Success extends Schema.Top,
>(tag: Tag, options: { readonly payload: Payload; readonly success: Success }) {
  return Rpc.make(tag, {
    payload: options.payload,
    success: options.success,
    error: AcpSchema.Error,
  });
}

export const InitializeRpc = makeAcpRpc(AGENT_METHODS.initialize, {
  payload: AcpSchema.InitializeRequest,
  success: AcpSchema.InitializeResponse,
});

export const AuthenticateRpc = makeAcpRpc(AGENT_METHODS.authenticate, {
  payload: AcpSchema.AuthenticateRequest,
  success: AcpSchema.AuthenticateResponse,
});

export const LogoutRpc = makeAcpRpc(AGENT_METHODS.logout, {
  payload: AcpSchema.LogoutRequest,
  success: AcpSchema.LogoutResponse,
});

export const NewSessionRpc = makeAcpRpc(AGENT_METHODS.session_new, {
  payload: AcpSchema.NewSessionRequest,
  success: AcpSchema.NewSessionResponse,
});

export const LoadSessionRpc = makeAcpRpc(AGENT_METHODS.session_load, {
  payload: AcpSchema.LoadSessionRequest,
  success: AcpSchema.LoadSessionResponse,
});

export const ListSessionsRpc = makeAcpRpc(AGENT_METHODS.session_list, {
  payload: AcpSchema.ListSessionsRequest,
  success: AcpSchema.ListSessionsResponse,
});

export const ForkSessionRpc = makeAcpRpc(AGENT_METHODS.session_fork, {
  payload: AcpSchema.ForkSessionRequest,
  success: AcpSchema.ForkSessionResponse,
});

export const ResumeSessionRpc = makeAcpRpc(AGENT_METHODS.session_resume, {
  payload: AcpSchema.ResumeSessionRequest,
  success: AcpSchema.ResumeSessionResponse,
});

export const CloseSessionRpc = makeAcpRpc(AGENT_METHODS.session_close, {
  payload: AcpSchema.CloseSessionRequest,
  success: AcpSchema.CloseSessionResponse,
});

export const SetSessionModeRpc = makeAcpRpc(AGENT_METHODS.session_set_mode, {
  payload: AcpSchema.SetSessionModeRequest,
  success: AcpSchema.SetSessionModeResponse,
});

export const PromptRpc = makeAcpRpc(AGENT_METHODS.session_prompt, {
  payload: AcpSchema.PromptRequest,
  success: AcpSchema.PromptResponse,
});

export const SetSessionModelRpc = makeAcpRpc(AGENT_METHODS.session_set_model, {
  payload: AcpSchema.SetSessionModelRequest,
  success: AcpSchema.SetSessionModelResponse,
});

export const SetSessionConfigOptionRpc = makeAcpRpc(AGENT_METHODS.session_set_config_option, {
  payload: AcpSchema.SetSessionConfigOptionRequest,
  success: AcpSchema.SetSessionConfigOptionResponse,
});

export const ReadTextFileRpc = makeAcpRpc(CLIENT_METHODS.fs_read_text_file, {
  payload: AcpSchema.ReadTextFileRequest,
  success: AcpSchema.ReadTextFileResponse,
});

export const WriteTextFileRpc = makeAcpRpc(CLIENT_METHODS.fs_write_text_file, {
  payload: AcpSchema.WriteTextFileRequest,
  success: AcpSchema.WriteTextFileResponse,
});

export const RequestPermissionRpc = makeAcpRpc(CLIENT_METHODS.session_request_permission, {
  payload: AcpSchema.RequestPermissionRequest,
  success: AcpSchema.RequestPermissionResponse,
});

export const ElicitationRpc = makeAcpRpc(CLIENT_METHODS.session_elicitation, {
  payload: AcpSchema.ElicitationRequest,
  success: AcpSchema.ElicitationResponse,
});

export const CreateTerminalRpc = makeAcpRpc(CLIENT_METHODS.terminal_create, {
  payload: AcpSchema.CreateTerminalRequest,
  success: AcpSchema.CreateTerminalResponse,
});

export const TerminalOutputRpc = makeAcpRpc(CLIENT_METHODS.terminal_output, {
  payload: AcpSchema.TerminalOutputRequest,
  success: AcpSchema.TerminalOutputResponse,
});

export const ReleaseTerminalRpc = makeAcpRpc(CLIENT_METHODS.terminal_release, {
  payload: AcpSchema.ReleaseTerminalRequest,
  success: AcpSchema.ReleaseTerminalResponse,
});

export const WaitForTerminalExitRpc = makeAcpRpc(CLIENT_METHODS.terminal_wait_for_exit, {
  payload: AcpSchema.WaitForTerminalExitRequest,
  success: AcpSchema.WaitForTerminalExitResponse,
});

export const KillTerminalRpc = makeAcpRpc(CLIENT_METHODS.terminal_kill, {
  payload: AcpSchema.KillTerminalRequest,
  success: AcpSchema.KillTerminalResponse,
});

export const AgentRpcs = RpcGroup.make(
  InitializeRpc,
  AuthenticateRpc,
  LogoutRpc,
  NewSessionRpc,
  LoadSessionRpc,
  ListSessionsRpc,
  ForkSessionRpc,
  ResumeSessionRpc,
  CloseSessionRpc,
  SetSessionModeRpc,
  PromptRpc,
  SetSessionModelRpc,
  SetSessionConfigOptionRpc,
);

export const ClientRpcs = RpcGroup.make(
  ReadTextFileRpc,
  WriteTextFileRpc,
  RequestPermissionRpc,
  ElicitationRpc,
  CreateTerminalRpc,
  TerminalOutputRpc,
  ReleaseTerminalRpc,
  WaitForTerminalExitRpc,
  KillTerminalRpc,
);

export const ClientRequestMethodSet = new Set(ClientRpcs.requests.keys());
export const AgentRequestMethodSet = new Set(AgentRpcs.requests.keys());
