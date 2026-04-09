import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import {
  ApprovalRequestId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  type OrchestrationReadModel,
  type ProviderApprovalDecision,
  type ServerConfig as T3ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { deriveActiveWorkStartedAt, formatElapsed } from "@t3tools/shared/orchestrationTiming";

import { connectionTone } from "../features/connection/connectionTone";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { pasteComposerClipboard, pickComposerImages } from "../lib/composerImages";
import {
  bootstrapRemoteConnection,
  type RemoteConnectionInput,
  type SavedRemoteConnection,
} from "../lib/connection";
import {
  applyOptimisticUserMessage,
  applyRealtimeEvent,
  requiresSnapshotRefresh,
} from "../lib/orchestration";
import { type RemoteClientConnectionState, RemoteClient } from "../lib/remoteClient";
import {
  type ScopedMobileProject,
  type ScopedMobileThread,
  scopedRequestKey,
  scopedThreadKey,
} from "../lib/scopedEntities";
import { clearSavedConnection, loadSavedConnections, saveConnection } from "../lib/storage";
import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  derivePendingApprovals,
  derivePendingUserInputs,
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
  type QueuedThreadMessage,
} from "../lib/threadActivity";
import { sortCopy } from "../lib/arrayCompat";
import { newClientId } from "../lib/clientId";

export interface ConnectedEnvironmentSummary {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly displayUrl: string;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
}

export interface RemoteAppModel {
  readonly isLoadingSavedConnection: boolean;
  readonly reconnectingScreenVisible: boolean;
  readonly connectionSheetRequired: boolean;
  readonly connectionInput: RemoteConnectionInput;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly connectedEnvironments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly connectedEnvironmentCount: number;
  readonly serverConfig: T3ServerConfig | null;
  readonly projects: ReadonlyArray<ScopedMobileProject>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly selectedThread: ScopedMobileThread | null;
  readonly selectedThreadFeed: ReturnType<typeof buildThreadFeed>;
  readonly selectedThreadQueueCount: number;
  readonly activeWorkDurationLabel: string | null;
  readonly activePendingApproval: ReturnType<typeof derivePendingApprovals>[number] | null;
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly activePendingUserInput: ReturnType<typeof derivePendingUserInputs>[number] | null;
  readonly activePendingUserInputDrafts: Record<string, PendingUserInputDraftAnswer>;
  readonly activePendingUserInputAnswers: Record<string, string> | null;
  readonly respondingUserInputId: ApprovalRequestId | null;
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
  readonly screenTone: ReturnType<typeof connectionTone>;
  readonly activeThreadBusy: boolean;
  readonly hasRemoteActivity: boolean;
  readonly selectedEnvironmentBaseUrl: string | null;
  readonly selectedEnvironmentBearerToken: string | null;
  readonly hasClient: boolean;
  readonly heroTitle: string;
  readonly showBrandWordmark: boolean;
  readonly onOpenConnectionEditor: () => void;
  readonly onCloseConnectionEditor: () => void;
  readonly onRequestCloseConnectionEditor: () => void;
  readonly onChangeConnectionPairingUrl: (pairingUrl: string) => void;
  readonly onConnectPress: () => void;
  readonly onRemoveEnvironmentPress: (environmentId: string) => void;
  readonly onRefresh: () => Promise<void>;
  readonly onCreateThread: (project: ScopedMobileProject) => Promise<void>;
  readonly onSelectThread: (thread: ScopedMobileThread) => void;
  readonly onBackFromThread: () => void;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftImages: () => Promise<void>;
  readonly onPasteIntoDraft: () => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onSendMessage: () => void;
  readonly onRenameThread: (title: string) => Promise<void>;
  readonly onStopThread: () => Promise<void>;
  readonly onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<void>;
  readonly onSelectUserInputOption: (requestId: string, questionId: string, label: string) => void;
  readonly onChangeUserInputCustomAnswer: (
    requestId: string,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmitUserInput: () => Promise<void>;
}

interface EnvironmentRuntimeState {
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly snapshot: OrchestrationReadModel | null;
  readonly serverConfig: T3ServerConfig | null;
}

type SelectedThreadRef = {
  readonly environmentId: string;
  readonly threadId: string;
};

function defaultEnvironmentRuntimeState(): EnvironmentRuntimeState {
  return {
    connectionState: "idle",
    connectionError: null,
    snapshot: null,
    serverConfig: null,
  };
}

function firstNonNull<T>(values: ReadonlyArray<T | null | undefined>): T | null {
  for (const value of values) {
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function deriveOverallConnectionState(
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

function useWorkDurationTicker(
  activeWorkStartedAt: string | null,
  setNowTick: (tick: number) => void,
) {
  useEffect(() => {
    if (!activeWorkStartedAt) {
      return;
    }

    setNowTick(Date.now());
    const timer = setInterval(() => {
      setNowTick(Date.now());
    }, 1_000);

    return () => clearInterval(timer);
  }, [activeWorkStartedAt, setNowTick]);
}

function useQueueDrain(input: {
  readonly dispatchingQueuedMessageId: string | null;
  readonly queuedMessagesByThreadKey: Record<string, ReadonlyArray<QueuedThreadMessage>>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly environments: ReadonlyArray<ConnectedEnvironmentSummary>;
  readonly sendQueuedMessage: (message: QueuedThreadMessage) => Promise<void>;
}) {
  const {
    dispatchingQueuedMessageId,
    environments,
    queuedMessagesByThreadKey,
    sendQueuedMessage,
    threads,
  } = input;

  useEffect(() => {
    if (dispatchingQueuedMessageId !== null) {
      return;
    }

    for (const [threadKey, queuedMessages] of Object.entries(queuedMessagesByThreadKey)) {
      const nextQueuedMessage = queuedMessages[0];
      if (!nextQueuedMessage) {
        continue;
      }

      const thread = threads.find(
        (candidate) => scopedThreadKey(candidate.environmentId, candidate.id) === threadKey,
      );
      if (!thread) {
        continue;
      }

      const environment = environments.find(
        (candidate) => candidate.environmentId === nextQueuedMessage.environmentId,
      );
      if (!environment || environment.connectionState !== "ready") {
        continue;
      }

      const threadStatus = thread.session?.status;
      if (threadStatus === "running" || threadStatus === "starting") {
        continue;
      }

      void sendQueuedMessage(nextQueuedMessage);
      return;
    }
  }, [
    dispatchingQueuedMessageId,
    environments,
    queuedMessagesByThreadKey,
    sendQueuedMessage,
    threads,
  ]);
}

export function useRemoteAppState(): RemoteAppModel {
  const clientsRef = useRef(new Map<string, RemoteClient>());
  const unsubscribesRef = useRef(new Map<string, () => void>());
  const [isLoadingSavedConnection, setIsLoadingSavedConnection] = useState(true);
  const [connectionEditorVisible, setConnectionEditorVisible] = useState(false);
  const [connectionInput, setConnectionInput] = useState<RemoteConnectionInput>({
    pairingUrl: "",
  });
  const [pendingConnectionError, setPendingConnectionError] = useState<string | null>(null);
  const [savedConnectionsById, setSavedConnectionsById] = useState<
    Record<string, SavedRemoteConnection>
  >({});
  const [environmentStateById, setEnvironmentStateById] = useState<
    Record<string, EnvironmentRuntimeState>
  >({});
  const [selectedThreadRef, setSelectedThreadRef] = useState<SelectedThreadRef | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const [draftMessageByThreadKey, setDraftMessageByThreadKey] = useState<Record<string, string>>(
    {},
  );
  const [draftAttachmentsByThreadKey, setDraftAttachmentsByThreadKey] = useState<
    Record<string, ReadonlyArray<DraftComposerImageAttachment>>
  >({});
  const [respondingApprovalId, setRespondingApprovalId] = useState<ApprovalRequestId | null>(null);
  const [respondingUserInputId, setRespondingUserInputId] = useState<ApprovalRequestId | null>(
    null,
  );
  const [dispatchingQueuedMessageId, setDispatchingQueuedMessageId] = useState<string | null>(null);
  const [queuedMessagesByThreadKey, setQueuedMessagesByThreadKey] = useState<
    Record<string, ReadonlyArray<QueuedThreadMessage>>
  >({});
  const [userInputDraftsByRequestKey, setUserInputDraftsByRequestKey] = useState<
    Record<string, Record<string, PendingUserInputDraftAnswer>>
  >({});

  const disconnectEnvironment = useCallback(
    async (environmentId: string, options?: { readonly removeSaved?: boolean }) => {
      unsubscribesRef.current.get(environmentId)?.();
      unsubscribesRef.current.delete(environmentId);
      clientsRef.current.get(environmentId)?.disconnect();
      clientsRef.current.delete(environmentId);

      setEnvironmentStateById((current) => {
        const next = { ...current };
        delete next[environmentId];
        return next;
      });

      if (options?.removeSaved) {
        await clearSavedConnection(environmentId);
        setSavedConnectionsById((current) => {
          const next = { ...current };
          delete next[environmentId];
          return next;
        });
        setSelectedThreadRef((current) =>
          current?.environmentId === environmentId ? null : current,
        );
      }
    },
    [],
  );

  const connectSavedEnvironment = useCallback(
    async (connection: SavedRemoteConnection, options?: { readonly persist?: boolean }) => {
      await disconnectEnvironment(connection.environmentId);

      if (options?.persist !== false) {
        await saveConnection(connection);
      }

      setSavedConnectionsById((current) => ({
        ...current,
        [connection.environmentId]: connection,
      }));
      setEnvironmentStateById((current) => ({
        ...current,
        [connection.environmentId]: {
          ...(current[connection.environmentId] ?? defaultEnvironmentRuntimeState()),
          connectionState: "connecting",
          connectionError: null,
        },
      }));

      const client = new RemoteClient(connection);
      clientsRef.current.set(connection.environmentId, client);
      const unsubscribe = client.addListener((event) => {
        switch (event.type) {
          case "status":
            setEnvironmentStateById((current) => ({
              ...current,
              [connection.environmentId]: {
                ...(current[connection.environmentId] ?? defaultEnvironmentRuntimeState()),
                connectionState: event.state,
                connectionError: event.error ?? null,
              },
            }));
            return;
          case "server-config":
            setEnvironmentStateById((current) => ({
              ...current,
              [connection.environmentId]: {
                ...(current[connection.environmentId] ?? defaultEnvironmentRuntimeState()),
                serverConfig: event.config,
              },
            }));
            return;
          case "snapshot":
            setEnvironmentStateById((current) => ({
              ...current,
              [connection.environmentId]: {
                ...(current[connection.environmentId] ?? defaultEnvironmentRuntimeState()),
                snapshot: event.snapshot,
              },
            }));
            return;
          case "domain-event":
            setEnvironmentStateById((current) => {
              const runtime = current[connection.environmentId];
              if (!runtime?.snapshot) {
                return current;
              }

              return {
                ...current,
                [connection.environmentId]: {
                  ...runtime,
                  snapshot: applyRealtimeEvent(runtime.snapshot, event.event),
                },
              };
            });
            if (requiresSnapshotRefresh(event.event)) {
              void clientsRef.current
                .get(connection.environmentId)
                ?.refreshSnapshot()
                .then((snapshot) => {
                  setEnvironmentStateById((current) => ({
                    ...current,
                    [connection.environmentId]: {
                      ...(current[connection.environmentId] ?? defaultEnvironmentRuntimeState()),
                      snapshot,
                    },
                  }));
                })
                .catch(() => undefined);
            }
        }
      });

      unsubscribesRef.current.set(connection.environmentId, unsubscribe);
      client.connect();
    },
    [disconnectEnvironment],
  );

  useEffect(() => {
    let cancelled = false;
    const unsubscribes = unsubscribesRef.current;
    const clients = clientsRef.current;

    void loadSavedConnections()
      .then(async (connections) => {
        if (cancelled) {
          return;
        }

        if (connections.length === 0) {
          setConnectionEditorVisible(true);
          return;
        }

        await Promise.all(
          connections.map((connection) =>
            connectSavedEnvironment(connection, {
              persist: false,
            }),
          ),
        );
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingSavedConnection(false);
        }
      });

    return () => {
      cancelled = true;
      for (const unsubscribe of unsubscribes.values()) {
        unsubscribe();
      }
      unsubscribes.clear();
      for (const client of clients.values()) {
        client.disconnect();
      }
      clients.clear();
    };
  }, [connectSavedEnvironment]);

  const connectedEnvironments = useMemo<ReadonlyArray<ConnectedEnvironmentSummary>>(
    () =>
      sortCopy(
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
        (left, right) => left.environmentLabel.localeCompare(right.environmentLabel),
      ),
    [environmentStateById, savedConnectionsById],
  );

  const projects = useMemo<ReadonlyArray<ScopedMobileProject>>(
    () =>
      sortCopy(
        Object.values(savedConnectionsById).flatMap((connection) =>
          (environmentStateById[connection.environmentId]?.snapshot?.projects ?? [])
            .filter((project) => project.deletedAt === null)
            .map((project) =>
              Object.assign({}, project, {
                environmentId: connection.environmentId,
                environmentLabel: connection.environmentLabel,
              }),
            ),
        ),
        (left, right) =>
          left.title.localeCompare(right.title) ||
          left.environmentLabel.localeCompare(right.environmentLabel),
      ),
    [environmentStateById, savedConnectionsById],
  );

  const threads = useMemo<ReadonlyArray<ScopedMobileThread>>(
    () =>
      sortCopy(
        Object.values(savedConnectionsById).flatMap((connection) =>
          (environmentStateById[connection.environmentId]?.snapshot?.threads ?? [])
            .filter((thread) => thread.deletedAt === null)
            .map((thread) =>
              Object.assign({}, thread, {
                environmentId: connection.environmentId,
                environmentLabel: connection.environmentLabel,
              }),
            ),
        ),
        (left, right) =>
          new Date(right.updatedAt ?? right.createdAt).getTime() -
            new Date(left.updatedAt ?? left.createdAt).getTime() ||
          right.environmentLabel.localeCompare(left.environmentLabel),
      ),
    [environmentStateById, savedConnectionsById],
  );

  const selectedThread = useMemo(
    () =>
      selectedThreadRef
        ? (threads.find(
            (thread) =>
              thread.environmentId === selectedThreadRef.environmentId &&
              thread.id === selectedThreadRef.threadId,
          ) ?? null)
        : null,
    [selectedThreadRef, threads],
  );

  useEffect(() => {
    if (!selectedThreadRef || selectedThread) {
      return;
    }
    setSelectedThreadRef(null);
  }, [selectedThread, selectedThreadRef]);

  const selectedThreadKey = selectedThread
    ? scopedThreadKey(selectedThread.environmentId, selectedThread.id)
    : null;
  const selectedRequestKey = selectedThread
    ? (requestId: ApprovalRequestId) => scopedRequestKey(selectedThread.environmentId, requestId)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );

  const selectedThreadFeed = useMemo(
    () =>
      selectedThread
        ? buildThreadFeed(selectedThread, selectedThreadQueuedMessages, dispatchingQueuedMessageId)
        : [],
    [dispatchingQueuedMessageId, selectedThread, selectedThreadQueuedMessages],
  );

  const draftMessage = selectedThreadKey ? (draftMessageByThreadKey[selectedThreadKey] ?? "") : "";
  const draftAttachments = selectedThreadKey
    ? (draftAttachmentsByThreadKey[selectedThreadKey] ?? [])
    : [];
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;

  const selectedThreadSessionActivity = useMemo(() => {
    if (!selectedThread?.session) {
      return null;
    }
    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThread]);

  const queuedSendStartedAt = selectedThreadQueuedMessages[0]?.createdAt ?? null;
  const activeWorkStartedAt = useMemo(() => {
    if (!selectedThread) {
      return null;
    }
    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      queuedSendStartedAt,
    );
  }, [queuedSendStartedAt, selectedThread, selectedThreadSessionActivity]);

  const activeWorkDurationLabel = useMemo(
    () =>
      activeWorkStartedAt
        ? formatElapsed(activeWorkStartedAt, new Date(nowTick).toISOString())
        : null,
    [activeWorkStartedAt, nowTick],
  );
  useWorkDurationTicker(activeWorkStartedAt, setNowTick);

  const activePendingApprovals = useMemo(
    () => (selectedThread ? derivePendingApprovals(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingApproval = activePendingApprovals[0] ?? null;

  const activePendingUserInputs = useMemo(
    () => (selectedThread ? derivePendingUserInputs(selectedThread.activities) : []),
    [selectedThread],
  );
  const activePendingUserInput = activePendingUserInputs[0] ?? null;
  const activePendingUserInputDrafts =
    activePendingUserInput && selectedRequestKey
      ? (userInputDraftsByRequestKey[selectedRequestKey(activePendingUserInput.requestId)] ?? {})
      : {};
  const activePendingUserInputAnswers = activePendingUserInput
    ? buildPendingUserInputAnswers(activePendingUserInput.questions, activePendingUserInputDrafts)
    : null;

  const screenTone = connectionTone(deriveOverallConnectionState(connectedEnvironments));
  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");
  const hasRemoteActivity = threads.some(
    (thread) => thread.session?.status === "running" || thread.session?.status === "starting",
  );

  const enqueueThreadMessage = useCallback((queuedMessage: QueuedThreadMessage) => {
    const threadKey = scopedThreadKey(queuedMessage.environmentId, queuedMessage.threadId);
    setQueuedMessagesByThreadKey((current) => ({
      ...current,
      [threadKey]: [...(current[threadKey] ?? []), queuedMessage],
    }));
  }, []);

  const removeQueuedMessage = useCallback(
    (environmentId: string, threadId: ThreadId, queuedMessageId: string) => {
      const threadKey = scopedThreadKey(environmentId, threadId);
      setQueuedMessagesByThreadKey((current) => {
        const existing = current[threadKey];
        if (!existing) {
          return current;
        }

        const nextQueue = existing.filter((entry) => entry.id !== queuedMessageId);
        if (nextQueue.length === existing.length) {
          return current;
        }

        const next = { ...current };
        if (nextQueue.length === 0) {
          delete next[threadKey];
        } else {
          next[threadKey] = nextQueue;
        }
        return next;
      });
    },
    [],
  );

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage) => {
      const client = clientsRef.current.get(queuedMessage.environmentId);
      const thread = threads.find(
        (candidate) =>
          candidate.environmentId === queuedMessage.environmentId &&
          candidate.id === queuedMessage.threadId,
      );
      if (!client || !thread) {
        return;
      }

      setDispatchingQueuedMessageId(queuedMessage.id);
      try {
        await client.dispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(queuedMessage.commandId),
          threadId: ThreadId.makeUnsafe(queuedMessage.threadId),
          message: {
            messageId: MessageId.makeUnsafe(queuedMessage.messageId),
            role: "user",
            text: queuedMessage.text,
            attachments: queuedMessage.attachments,
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: queuedMessage.createdAt,
        });

        removeQueuedMessage(queuedMessage.environmentId, queuedMessage.threadId, queuedMessage.id);
        setEnvironmentStateById((current) => {
          const runtime = current[queuedMessage.environmentId];
          if (!runtime?.snapshot) {
            return current;
          }

          return {
            ...current,
            [queuedMessage.environmentId]: {
              ...runtime,
              snapshot: applyOptimisticUserMessage(runtime.snapshot, {
                threadId: ThreadId.makeUnsafe(queuedMessage.threadId),
                messageId: MessageId.makeUnsafe(queuedMessage.messageId),
                text: queuedMessage.text,
                attachments: queuedMessage.attachments,
                createdAt: queuedMessage.createdAt,
              }),
            },
          };
        });
      } catch (error) {
        removeQueuedMessage(queuedMessage.environmentId, queuedMessage.threadId, queuedMessage.id);
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to send message.",
        );
      } finally {
        setDispatchingQueuedMessageId((current) => (current === queuedMessage.id ? null : current));
      }
    },
    [removeQueuedMessage, threads],
  );

  useQueueDrain({
    dispatchingQueuedMessageId,
    queuedMessagesByThreadKey,
    threads,
    environments: connectedEnvironments,
    sendQueuedMessage,
  });

  const onRefresh = useCallback(async () => {
    const targets = selectedThread
      ? [selectedThread.environmentId]
      : Object.keys(savedConnectionsById);
    await Promise.all(
      targets.map(async (environmentId) => {
        const client = clientsRef.current.get(environmentId);
        if (!client) {
          return;
        }

        try {
          const [serverConfig, snapshot] = await Promise.all([
            client.refreshServerConfig(),
            client.refreshSnapshot(),
          ]);
          setEnvironmentStateById((current) => ({
            ...current,
            [environmentId]: {
              ...(current[environmentId] ?? defaultEnvironmentRuntimeState()),
              serverConfig,
              snapshot,
              connectionError: null,
            },
          }));
        } catch (error) {
          setEnvironmentStateById((current) => ({
            ...current,
            [environmentId]: {
              ...(current[environmentId] ?? defaultEnvironmentRuntimeState()),
              connectionError:
                error instanceof Error ? error.message : "Failed to refresh remote data.",
            },
          }));
        }
      }),
    );
  }, [savedConnectionsById, selectedThread]);

  const onCreateThread = useCallback(
    async (project: ScopedMobileProject) => {
      const client = clientsRef.current.get(project.environmentId);
      if (!client) {
        return;
      }

      const latestProjectThread =
        threads.find(
          (thread) =>
            thread.environmentId === project.environmentId && thread.projectId === project.id,
        ) ?? null;
      const modelSelection =
        project.defaultModelSelection ?? latestProjectThread?.modelSelection ?? null;
      if (!modelSelection) {
        setPendingConnectionError("This project does not have a default model configured yet.");
        return;
      }

      const threadId = ThreadId.makeUnsafe(newClientId("thread"));
      const createdAt = new Date().toISOString();
      await client.dispatchCommand({
        type: "thread.create",
        commandId: CommandId.makeUnsafe(newClientId("command")),
        threadId,
        projectId: project.id,
        title: "New thread",
        modelSelection,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: null,
        createdAt,
      });
      setSelectedThreadRef({
        environmentId: project.environmentId,
        threadId,
      });
      await onRefresh();
    },
    [onRefresh, threads],
  );

  const onConnectPress = useCallback(() => {
    void bootstrapRemoteConnection(connectionInput)
      .then(async (connection) => {
        setPendingConnectionError(null);
        await connectSavedEnvironment(connection);
        setConnectionInput({ pairingUrl: "" });
        setConnectionEditorVisible(false);
      })
      .catch((error) => {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to pair with the environment.",
        );
      });
  }, [connectSavedEnvironment, connectionInput]);

  const onRemoveEnvironmentPress = useCallback(
    (environmentId: string) => {
      const connection = savedConnectionsById[environmentId];
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
    },
    [disconnectEnvironment, savedConnectionsById],
  );

  const onSendMessage = useCallback(() => {
    if (!selectedThread) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
    const text = (draftMessageByThreadKey[threadKey] ?? "").trim();
    const attachments = draftAttachmentsByThreadKey[threadKey] ?? [];
    if (text.length === 0 && attachments.length === 0) {
      return;
    }

    const createdAt = new Date().toISOString();
    enqueueThreadMessage({
      id: newClientId("queued-message"),
      environmentId: selectedThread.environmentId,
      threadId: selectedThread.id,
      messageId: newClientId("message"),
      commandId: newClientId("command"),
      text,
      attachments,
      createdAt,
    });
    setDraftMessageByThreadKey((current) => ({
      ...current,
      [threadKey]: "",
    }));
    setDraftAttachmentsByThreadKey((current) => ({
      ...current,
      [threadKey]: [],
    }));
  }, [draftAttachmentsByThreadKey, draftMessageByThreadKey, enqueueThreadMessage, selectedThread]);

  const onStopThread = useCallback(async () => {
    if (!selectedThread) {
      return;
    }

    const client = clientsRef.current.get(selectedThread.environmentId);
    if (!client) {
      return;
    }

    if (
      selectedThread.session?.status !== "running" &&
      selectedThread.session?.status !== "starting"
    ) {
      return;
    }

    await client.dispatchCommand({
      type: "thread.turn.interrupt",
      commandId: CommandId.makeUnsafe(newClientId("command")),
      threadId: selectedThread.id,
      ...(selectedThread.session?.activeTurnId
        ? { turnId: selectedThread.session.activeTurnId }
        : {}),
      createdAt: new Date().toISOString(),
    });
  }, [selectedThread]);

  const onRenameThread = useCallback(
    async (title: string) => {
      if (!selectedThread) {
        return;
      }

      const client = clientsRef.current.get(selectedThread.environmentId);
      if (!client) {
        return;
      }

      const trimmed = title.trim();
      if (!trimmed || trimmed === selectedThread.title) {
        return;
      }

      await client.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.makeUnsafe(newClientId("command")),
        threadId: selectedThread.id,
        title: trimmed,
      });
    },
    [selectedThread],
  );

  const onRespondToApproval = useCallback(
    async (requestId: ApprovalRequestId, decision: ProviderApprovalDecision) => {
      if (!selectedThread) {
        return;
      }

      const client = clientsRef.current.get(selectedThread.environmentId);
      if (!client) {
        return;
      }

      setRespondingApprovalId(requestId);
      try {
        await client.dispatchCommand({
          type: "thread.approval.respond",
          commandId: CommandId.makeUnsafe(newClientId("command")),
          threadId: selectedThread.id,
          requestId,
          decision,
          createdAt: new Date().toISOString(),
        });
      } finally {
        setRespondingApprovalId((current) => (current === requestId ? null : current));
      }
    },
    [selectedThread],
  );

  const onSelectUserInputOption = useCallback(
    (requestId: string, questionId: string, label: string) => {
      if (!selectedThread) {
        return;
      }

      const requestKey = scopedRequestKey(
        selectedThread.environmentId,
        requestId as ApprovalRequestId,
      );
      setUserInputDraftsByRequestKey((current) => ({
        ...current,
        [requestKey]: {
          ...current[requestKey],
          [questionId]: {
            selectedOptionLabel: label,
          },
        },
      }));
    },
    [selectedThread],
  );

  const onChangeUserInputCustomAnswer = useCallback(
    (requestId: string, questionId: string, customAnswer: string) => {
      if (!selectedThread) {
        return;
      }

      const requestKey = scopedRequestKey(
        selectedThread.environmentId,
        requestId as ApprovalRequestId,
      );
      setUserInputDraftsByRequestKey((current) => ({
        ...current,
        [requestKey]: {
          ...current[requestKey],
          [questionId]: setPendingUserInputCustomAnswer(
            current[requestKey]?.[questionId],
            customAnswer,
          ),
        },
      }));
    },
    [selectedThread],
  );

  const onSubmitUserInput = useCallback(async () => {
    if (!selectedThread || !activePendingUserInput || !activePendingUserInputAnswers) {
      return;
    }

    const client = clientsRef.current.get(selectedThread.environmentId);
    if (!client) {
      return;
    }

    setRespondingUserInputId(activePendingUserInput.requestId);
    try {
      await client.dispatchCommand({
        type: "thread.user-input.respond",
        commandId: CommandId.makeUnsafe(newClientId("command")),
        threadId: selectedThread.id,
        requestId: activePendingUserInput.requestId,
        answers: activePendingUserInputAnswers,
        createdAt: new Date().toISOString(),
      });
    } finally {
      setRespondingUserInputId((current) =>
        current === activePendingUserInput.requestId ? null : current,
      );
    }
  }, [activePendingUserInput, activePendingUserInputAnswers, selectedThread]);

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThread) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
      setDraftMessageByThreadKey((current) => ({
        ...current,
        [threadKey]: value,
      }));
    },
    [selectedThread],
  );

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThread) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
    const result = await pickComposerImages({
      existingCount: draftAttachmentsByThreadKey[threadKey]?.length ?? 0,
    });
    if (result.images.length > 0) {
      setDraftAttachmentsByThreadKey((current) => ({
        ...current,
        [threadKey]: [...(current[threadKey] ?? []), ...result.images],
      }));
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [draftAttachmentsByThreadKey, selectedThread]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThread) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
    const result = await pasteComposerClipboard({
      existingCount: draftAttachmentsByThreadKey[threadKey]?.length ?? 0,
    });
    if (result.images.length > 0) {
      setDraftAttachmentsByThreadKey((current) => ({
        ...current,
        [threadKey]: [...(current[threadKey] ?? []), ...result.images],
      }));
    }
    if (result.text) {
      setDraftMessageByThreadKey((current) => ({
        ...current,
        [threadKey]: `${current[threadKey] ?? ""}${result.text}`,
      }));
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [draftAttachmentsByThreadKey, selectedThread]);

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThread) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
      setDraftAttachmentsByThreadKey((current) => ({
        ...current,
        [threadKey]: (current[threadKey] ?? []).filter((image) => image.id !== imageId),
      }));
    },
    [selectedThread],
  );

  const selectedEnvironmentConnection = selectedThread
    ? (savedConnectionsById[selectedThread.environmentId] ?? null)
    : null;
  const selectedEnvironmentRuntime = selectedThread
    ? (environmentStateById[selectedThread.environmentId] ?? null)
    : null;

  const connectionError = firstNonNull([
    pendingConnectionError,
    selectedEnvironmentRuntime?.connectionError,
    ...connectedEnvironments.map((environment) => environment.connectionError),
  ]);
  const serverConfig =
    selectedEnvironmentRuntime?.serverConfig ??
    firstNonNull(Object.values(environmentStateById).map((runtime) => runtime.serverConfig));
  const hasClient = connectedEnvironments.length > 0;

  return {
    isLoadingSavedConnection,
    reconnectingScreenVisible: false,
    connectionSheetRequired: connectionEditorVisible || (!hasClient && !isLoadingSavedConnection),
    connectionInput,
    connectionState: deriveOverallConnectionState(connectedEnvironments),
    connectionError,
    connectedEnvironments,
    connectedEnvironmentCount: connectedEnvironments.length,
    serverConfig,
    projects,
    threads,
    selectedThread,
    selectedThreadFeed,
    selectedThreadQueueCount,
    activeWorkDurationLabel,
    activePendingApproval,
    respondingApprovalId,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    respondingUserInputId,
    draftMessage,
    draftAttachments,
    screenTone,
    activeThreadBusy,
    hasRemoteActivity,
    selectedEnvironmentBaseUrl: selectedEnvironmentConnection?.httpBaseUrl ?? null,
    selectedEnvironmentBearerToken: selectedEnvironmentConnection?.bearerToken ?? null,
    hasClient,
    heroTitle: "T3 Code",
    showBrandWordmark: true,
    onOpenConnectionEditor: () => setConnectionEditorVisible(true),
    onCloseConnectionEditor: () => setConnectionEditorVisible(false),
    onRequestCloseConnectionEditor: () => {
      if (hasClient) {
        setConnectionEditorVisible(false);
      }
    },
    onChangeConnectionPairingUrl: (pairingUrl: string) => setConnectionInput({ pairingUrl }),
    onConnectPress,
    onRemoveEnvironmentPress,
    onRefresh,
    onCreateThread,
    onSelectThread: (thread) =>
      setSelectedThreadRef({
        environmentId: thread.environmentId,
        threadId: thread.id,
      }),
    onBackFromThread: () => setSelectedThreadRef(null),
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onRemoveDraftImage,
    onSendMessage,
    onRenameThread,
    onStopThread,
    onRespondToApproval,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
    onSubmitUserInput,
  };
}
