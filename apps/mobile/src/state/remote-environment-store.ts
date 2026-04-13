import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { OrchestrationThread } from "@t3tools/contracts";
import type { SavedRemoteConnection } from "../lib/connection";
import {
  defaultEnvironmentRuntimeState,
  type EnvironmentRuntimeState,
} from "./remote-runtime-types";

export interface RemoteEnvironmentStoreState {
  readonly isLoadingSavedConnection: boolean;
  readonly connectionPairingUrl: string;
  readonly pendingConnectionError: string | null;
  readonly savedConnectionsById: Record<string, SavedRemoteConnection>;
  readonly environmentStateById: Record<string, EnvironmentRuntimeState>;
  /** Full thread detail keyed by `${environmentId}:${threadId}`. */
  readonly threadDetailByKey: Record<string, OrchestrationThread>;

  readonly setIsLoadingSavedConnection: (value: boolean) => void;
  readonly setConnectionPairingUrl: (pairingUrl: string) => void;
  readonly clearConnectionPairingUrl: () => void;
  readonly setPendingConnectionError: (message: string | null) => void;
  readonly clearPendingConnectionError: () => void;
  readonly replaceSavedConnections: (connections: Record<string, SavedRemoteConnection>) => void;
  readonly upsertSavedConnection: (connection: SavedRemoteConnection) => void;
  readonly removeSavedConnection: (environmentId: string) => void;
  readonly patchEnvironmentRuntimeState: (
    environmentId: string,
    updater: (current: EnvironmentRuntimeState) => EnvironmentRuntimeState,
  ) => void;
  readonly removeEnvironmentRuntimeState: (environmentId: string) => void;
  readonly setThreadDetail: (key: string, thread: OrchestrationThread) => void;
  readonly removeThreadDetail: (key: string) => void;
}

export const remoteEnvironmentStore = createStore<RemoteEnvironmentStoreState>()((set) => ({
  isLoadingSavedConnection: true,
  connectionPairingUrl: "",
  pendingConnectionError: null,
  savedConnectionsById: {},
  environmentStateById: {},
  threadDetailByKey: {},

  setIsLoadingSavedConnection: (value) => set({ isLoadingSavedConnection: value }),
  setConnectionPairingUrl: (pairingUrl) => set({ connectionPairingUrl: pairingUrl }),
  clearConnectionPairingUrl: () => set({ connectionPairingUrl: "" }),
  setPendingConnectionError: (message) => set({ pendingConnectionError: message }),
  clearPendingConnectionError: () => set({ pendingConnectionError: null }),
  replaceSavedConnections: (connections) => set({ savedConnectionsById: connections }),
  upsertSavedConnection: (connection) =>
    set((state) => ({
      savedConnectionsById: {
        ...state.savedConnectionsById,
        [connection.environmentId]: connection,
      },
    })),
  removeSavedConnection: (environmentId) =>
    set((state) => {
      const next = { ...state.savedConnectionsById };
      delete next[environmentId];
      return { savedConnectionsById: next };
    }),
  patchEnvironmentRuntimeState: (environmentId, updater) =>
    set((state) => ({
      environmentStateById: {
        ...state.environmentStateById,
        [environmentId]: updater(
          state.environmentStateById[environmentId] ?? defaultEnvironmentRuntimeState(),
        ),
      },
    })),
  removeEnvironmentRuntimeState: (environmentId) =>
    set((state) => {
      const next = { ...state.environmentStateById };
      delete next[environmentId];
      return { environmentStateById: next };
    }),
  setThreadDetail: (key, thread) =>
    set((state) => ({
      threadDetailByKey: { ...state.threadDetailByKey, [key]: thread },
    })),
  removeThreadDetail: (key) =>
    set((state) => {
      const next = { ...state.threadDetailByKey };
      delete next[key];
      return { threadDetailByKey: next };
    }),
}));

export function useRemoteEnvironmentStore<T>(
  selector: (state: RemoteEnvironmentStoreState) => T,
): T {
  return useStore(remoteEnvironmentStore, selector);
}
