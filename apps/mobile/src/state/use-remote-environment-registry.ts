import { useCallback, useEffect, useMemo } from "react";
import { Alert } from "react-native";

import {
  applyShellStreamEvent,
  createEnvironmentConnection,
  createKnownEnvironment,
  createWsRpcClient,
  WsTransport,
} from "@t3tools/client-runtime";
import { EnvironmentId } from "@t3tools/contracts";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/shared/remote";
import { useShallow } from "zustand/react/shallow";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { type SavedRemoteConnection, bootstrapRemoteConnection } from "../lib/connection";
import { clearSavedConnection, loadSavedConnections, saveConnection } from "../lib/storage";
import {
  firstNonNull,
  type ConnectedEnvironmentSummary,
  type EnvironmentSession,
  type RemoteClientConnectionState,
} from "./remote-runtime-types";
import { remoteEnvironmentStore, useRemoteEnvironmentStore } from "./remote-environment-store";
import { useThreadSelectionStore } from "./thread-selection-store";

const environmentSessions = new Map<string, EnvironmentSession>();
const environmentConnectionListeners = new Set<() => void>();

function notifyEnvironmentConnectionListeners() {
  for (const listener of environmentConnectionListeners) listener();
}

/**
 * Subscribe to environment-connection changes (connect / disconnect / reconnect).
 * Returns an unsubscribe function.
 */
export function subscribeEnvironmentConnections(listener: () => void): () => void {
  environmentConnectionListeners.add(listener);
  return () => {
    environmentConnectionListeners.delete(listener);
  };
}

function setEnvironmentConnectionStatus(
  environmentId: string,
  state: ConnectedEnvironmentSummary["connectionState"],
  error?: string | null,
) {
  remoteEnvironmentStore.getState().patchEnvironmentRuntimeState(environmentId, (current) => ({
    ...current,
    connectionState: state,
    connectionError: error === undefined ? current.connectionError : error,
  }));
}

export function getEnvironmentClient(environmentId: string) {
  return environmentSessions.get(environmentId)?.client ?? null;
}

export async function disconnectEnvironment(
  environmentId: string,
  options?: { readonly removeSaved?: boolean },
) {
  const session = environmentSessions.get(environmentId);
  environmentSessions.delete(environmentId);
  notifyEnvironmentConnectionListeners();
  await session?.connection.dispose();
  remoteEnvironmentStore.getState().removeEnvironmentRuntimeState(environmentId);

  if (options?.removeSaved) {
    await clearSavedConnection(environmentId);
    remoteEnvironmentStore.getState().removeSavedConnection(environmentId);
  }
}

export async function connectSavedEnvironment(
  connection: SavedRemoteConnection,
  options?: { readonly persist?: boolean },
) {
  await disconnectEnvironment(connection.environmentId);

  if (options?.persist !== false) {
    await saveConnection(connection);
  }

  const store = remoteEnvironmentStore.getState();
  store.upsertSavedConnection(connection);
  setEnvironmentConnectionStatus(connection.environmentId, "connecting", null);

  const transport = new WsTransport(
    () =>
      resolveRemoteWebSocketConnectionUrl({
        wsBaseUrl: connection.wsBaseUrl,
        httpBaseUrl: connection.httpBaseUrl,
        bearerToken: connection.bearerToken,
      }),
    {
      onAttempt: () => {
        remoteEnvironmentStore
          .getState()
          .patchEnvironmentRuntimeState(connection.environmentId, (previous) => {
            const nextState =
              previous.connectionState === "ready" ||
              previous.connectionState === "reconnecting" ||
              previous.connectionState === "disconnected"
                ? "reconnecting"
                : "connecting";
            return {
              ...previous,
              connectionState: nextState,
              connectionError: null,
            };
          });
      },
      onError: (message) => {
        setEnvironmentConnectionStatus(connection.environmentId, "disconnected", message);
      },
      onClose: (details) => {
        const reason =
          details.reason.trim().length > 0
            ? details.reason
            : details.code === 1000
              ? null
              : `Remote connection closed (${details.code}).`;
        setEnvironmentConnectionStatus(connection.environmentId, "disconnected", reason);
      },
    },
  );

  const client = createWsRpcClient(transport);
  const environmentConnection = createEnvironmentConnection({
    kind: "saved",
    knownEnvironment: {
      ...createKnownEnvironment({
        id: connection.environmentId,
        label: connection.environmentLabel,
        source: "manual",
        target: {
          httpBaseUrl: connection.httpBaseUrl,
          wsBaseUrl: connection.wsBaseUrl,
        },
      }),
      environmentId: EnvironmentId.make(connection.environmentId),
    },
    client,
    applyShellEvent: (event, environmentId) => {
      remoteEnvironmentStore.getState().patchEnvironmentRuntimeState(environmentId, (runtime) => {
        if (!runtime.snapshot) {
          return runtime;
        }

        return {
          ...runtime,
          snapshot: applyShellStreamEvent(runtime.snapshot, event),
        };
      });
    },
    syncShellSnapshot: (snapshot, environmentId) => {
      remoteEnvironmentStore.getState().patchEnvironmentRuntimeState(environmentId, (runtime) => ({
        ...runtime,
        snapshot,
        connectionState: "ready",
        connectionError: null,
      }));
    },
    applyTerminalEvent: () => undefined,
    onConfigSnapshot: (serverConfig) => {
      remoteEnvironmentStore
        .getState()
        .patchEnvironmentRuntimeState(connection.environmentId, (runtime) => ({
          ...runtime,
          serverConfig,
        }));
    },
  });

  environmentSessions.set(connection.environmentId, {
    client,
    connection: environmentConnection,
  });
  notifyEnvironmentConnectionListeners();

  try {
    await environmentConnection.ensureBootstrapped();
  } catch (error) {
    setEnvironmentConnectionStatus(
      connection.environmentId,
      "disconnected",
      error instanceof Error ? error.message : "Failed to bootstrap remote connection.",
    );
  }
}

const environmentsSortOrder = Order.make<ConnectedEnvironmentSummary>(
  (left, right) => left.environmentLabel.localeCompare(right.environmentLabel) as -1 | 0 | 1,
);

function deriveConnectedEnvironments(
  savedConnectionsById: Record<string, SavedRemoteConnection>,
  environmentStateById: ReturnType<typeof remoteEnvironmentStore.getState>["environmentStateById"],
): ReadonlyArray<ConnectedEnvironmentSummary> {
  return Arr.sort(
    Object.values(savedConnectionsById).map((connection) => {
      const runtime = environmentStateById[connection.environmentId];
      return {
        environmentId: connection.environmentId,
        environmentLabel: connection.environmentLabel,
        displayUrl: connection.displayUrl,
        connectionState: runtime?.connectionState ?? "idle",
        connectionError: runtime?.connectionError ?? null,
      };
    }),
    environmentsSortOrder,
  );
}

export function useRemoteEnvironmentBootstrap() {
  const setIsLoadingSavedConnection = useRemoteEnvironmentStore(
    (state) => state.setIsLoadingSavedConnection,
  );
  const replaceSavedConnections = useRemoteEnvironmentStore(
    (state) => state.replaceSavedConnections,
  );

  useEffect(() => {
    let cancelled = false;

    void loadSavedConnections()
      .then((connections) => {
        if (cancelled) {
          return;
        }

        replaceSavedConnections(
          Object.fromEntries(
            connections.map((connection) => [connection.environmentId, connection]),
          ),
        );

        setIsLoadingSavedConnection(false);

        void Promise.all(
          connections.map((connection) =>
            connectSavedEnvironment(connection, {
              persist: false,
            }),
          ),
        );
      })
      .catch(() => {
        if (!cancelled) {
          setIsLoadingSavedConnection(false);
        }
      });

    return () => {
      cancelled = true;
      for (const session of environmentSessions.values()) {
        void session.connection.dispose();
      }
      environmentSessions.clear();
      notifyEnvironmentConnectionListeners();
    };
  }, [replaceSavedConnections, setIsLoadingSavedConnection]);
}

export function useRemoteEnvironmentState() {
  return useRemoteEnvironmentStore(
    useShallow((state) => ({
      isLoadingSavedConnection: state.isLoadingSavedConnection,
      connectionPairingUrl: state.connectionPairingUrl,
      pendingConnectionError: state.pendingConnectionError,
      savedConnectionsById: state.savedConnectionsById,
      environmentStateById: state.environmentStateById,
    })),
  );
}

export function useRemoteConnectionStatus() {
  const { environmentStateById, pendingConnectionError, savedConnectionsById } =
    useRemoteEnvironmentState();
  const selectedThreadRef = useThreadSelectionStore((state) => state.selectedThreadRef);

  const connectedEnvironments = useMemo(
    () => deriveConnectedEnvironments(savedConnectionsById, environmentStateById),
    [environmentStateById, savedConnectionsById],
  );

  const connectionState = useMemo<RemoteClientConnectionState>(() => {
    if (connectedEnvironments.length === 0) {
      return "idle";
    }
    if (connectedEnvironments.some((environment) => environment.connectionState === "ready")) {
      return "ready";
    }
    if (
      connectedEnvironments.some((environment) => environment.connectionState === "reconnecting")
    ) {
      return "reconnecting";
    }
    if (connectedEnvironments.some((environment) => environment.connectionState === "connecting")) {
      return "connecting";
    }
    return "disconnected";
  }, [connectedEnvironments]);

  const connectionError = useMemo(
    () =>
      firstNonNull([
        pendingConnectionError,
        selectedThreadRef
          ? environmentStateById[selectedThreadRef.environmentId]?.connectionError
          : null,
        ...connectedEnvironments.map((environment) => environment.connectionError),
      ]),
    [connectedEnvironments, environmentStateById, pendingConnectionError, selectedThreadRef],
  );

  return {
    connectedEnvironments,
    connectionState,
    connectionError,
  };
}

export function useRemoteConnections() {
  const { connectionPairingUrl } = useRemoteEnvironmentState();
  const { connectedEnvironments, connectionError, connectionState } = useRemoteConnectionStatus();
  const setConnectionPairingUrl = useRemoteEnvironmentStore(
    (state) => state.setConnectionPairingUrl,
  );
  const clearConnectionPairingUrl = useRemoteEnvironmentStore(
    (state) => state.clearConnectionPairingUrl,
  );

  const onConnectPress = useCallback(
    async (pairingUrl?: string) => {
      try {
        const nextPairingUrl = pairingUrl ?? connectionPairingUrl;
        const connection = await bootstrapRemoteConnection({ pairingUrl: nextPairingUrl });
        remoteEnvironmentStore.getState().clearPendingConnectionError();
        await connectSavedEnvironment(connection);
        clearConnectionPairingUrl();
      } catch (error) {
        remoteEnvironmentStore
          .getState()
          .setPendingConnectionError(
            error instanceof Error ? error.message : "Failed to pair with the environment.",
          );
        throw error;
      }
    },
    [clearConnectionPairingUrl, connectionPairingUrl],
  );

  const onUpdateEnvironment = useCallback(
    async (
      environmentId: string,
      updates: { readonly label: string; readonly displayUrl: string },
    ) => {
      const connection = remoteEnvironmentStore.getState().savedConnectionsById[environmentId];
      if (!connection) {
        return;
      }

      const updated: SavedRemoteConnection = {
        ...connection,
        environmentLabel: updates.label.trim() || connection.environmentLabel,
        displayUrl: updates.displayUrl.trim() || connection.displayUrl,
      };

      await saveConnection(updated);
      remoteEnvironmentStore.getState().upsertSavedConnection(updated);
    },
    [],
  );

  const onReconnectEnvironment = useCallback((environmentId: string) => {
    const connection = remoteEnvironmentStore.getState().savedConnectionsById[environmentId];
    if (!connection) {
      return;
    }
    void connectSavedEnvironment(connection, { persist: false });
  }, []);

  const onRemoveEnvironmentPress = useCallback((environmentId: string) => {
    const connection = remoteEnvironmentStore.getState().savedConnectionsById[environmentId];
    if (!connection) {
      return;
    }

    Alert.alert(
      "Remove environment?",
      `Disconnect and forget ${connection.environmentLabel} on this device.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            void disconnectEnvironment(environmentId, { removeSaved: true });
          },
        },
      ],
    );
  }, []);

  return {
    connectionPairingUrl,
    connectionState,
    connectionError,
    connectedEnvironments,
    connectedEnvironmentCount: connectedEnvironments.length,
    onChangeConnectionPairingUrl: setConnectionPairingUrl,
    onConnectPress,
    onReconnectEnvironment,
    onUpdateEnvironment,
    onRemoveEnvironmentPress,
  };
}
