import type {
  OrchestrationShellSnapshot,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import type { EnvironmentConnection, WsRpcClient } from "@t3tools/client-runtime";

export type RemoteClientConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "disconnected";

export interface ConnectedEnvironmentSummary {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
}

export interface SelectedThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface EnvironmentRuntimeState {
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly snapshot: OrchestrationShellSnapshot | null;
  readonly serverConfig: T3ServerConfig | null;
}

export interface EnvironmentSession {
  readonly client: WsRpcClient;
  readonly connection: EnvironmentConnection;
}

export type GetEnvironmentClient = (environmentId: string) => WsRpcClient | null;

export function defaultEnvironmentRuntimeState(): EnvironmentRuntimeState {
  return {
    connectionState: "idle",
    connectionError: null,
    snapshot: null,
    serverConfig: null,
  };
}

export function firstNonNull<T>(values: ReadonlyArray<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

export function deriveThreadTitleFromPrompt(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "New thread";
  }

  const compact = trimmed.replace(/\s+/g, " ");
  return compact.length <= 72 ? compact : `${compact.slice(0, 69).trimEnd()}...`;
}

export function deriveOverallConnectionState(
  environments: ReadonlyArray<ConnectedEnvironmentSummary>,
): RemoteClientConnectionState {
  if (environments.length === 0) {
    return "idle";
  }
  if (environments.some((environment) => environment.connectionState === "ready")) {
    return "ready";
  }
  if (environments.some((environment) => environment.connectionState === "reconnecting")) {
    return "reconnecting";
  }
  if (environments.some((environment) => environment.connectionState === "connecting")) {
    return "connecting";
  }
  return "disconnected";
}
