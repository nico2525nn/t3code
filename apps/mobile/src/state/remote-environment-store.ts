import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

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
}

export const remoteEnvironmentStore = createStore<RemoteEnvironmentStoreState>()((set) => ({
  isLoadingSavedConnection: true,
  connectionPairingUrl: "",
  pendingConnectionError: null,
  savedConnectionsById: {},
  environmentStateById: {},

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
}));

export function useRemoteEnvironmentStore<T>(
  selector: (state: RemoteEnvironmentStoreState) => T,
): T {
  return useStore(remoteEnvironmentStore, selector);
}
