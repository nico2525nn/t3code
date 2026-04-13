import { useCallback, useEffect, useMemo } from "react";

import { ApprovalRequestId, CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { deriveActiveWorkStartedAt, formatElapsed } from "@t3tools/shared/orchestrationTiming";

import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { ScopedMobileThread } from "../lib/scopedEntities";
import { scopedRequestKey, scopedThreadKey } from "../lib/scopedEntities";
import {
  buildPendingUserInputAnswers,
  buildThreadFeed,
  derivePendingApprovals,
  derivePendingUserInputs,
  type QueuedThreadMessage,
} from "../lib/threadActivity";
import { uuidv4 } from "../lib/uuid";
import type { ConnectedEnvironmentSummary } from "./remote-runtime-types";
import { useRemoteEnvironmentStore } from "./remote-environment-store";
import { getEnvironmentClient, useRemoteConnectionStatus } from "./use-remote-environment-registry";
import { useRemoteCatalog } from "./use-remote-catalog";
import { useThreadSelection } from "./use-thread-selection";
import { useThreadComposerStore } from "./thread-composer-store";
import { useThreadUserInputStore } from "./thread-user-input-store";

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

export function useThreadComposerState() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const { threads } = useRemoteCatalog();
  const { selectedThread } = useThreadSelection();

  const setPendingConnectionError = useRemoteEnvironmentStore(
    (state) => state.setPendingConnectionError,
  );
  const nowTick = useThreadComposerStore((state) => state.nowTick);
  const draftMessageByThreadKey = useThreadComposerStore((state) => state.draftMessageByThreadKey);
  const draftAttachmentsByThreadKey = useThreadComposerStore(
    (state) => state.draftAttachmentsByThreadKey,
  );
  const dispatchingQueuedMessageId = useThreadComposerStore(
    (state) => state.dispatchingQueuedMessageId,
  );
  const queuedMessagesByThreadKey = useThreadComposerStore(
    (state) => state.queuedMessagesByThreadKey,
  );
  const userInputDraftsByRequestKey = useThreadUserInputStore(
    (state) => state.userInputDraftsByRequestKey,
  );
  const setNowTick = useThreadComposerStore((state) => state.setNowTick);
  const beginDispatchingQueuedMessage = useThreadComposerStore(
    (state) => state.beginDispatchingQueuedMessage,
  );
  const finishDispatchingQueuedMessage = useThreadComposerStore(
    (state) => state.finishDispatchingQueuedMessage,
  );
  const enqueueQueuedMessage = useThreadComposerStore((state) => state.enqueueQueuedMessage);
  const removeQueuedMessage = useThreadComposerStore((state) => state.removeQueuedMessage);
  const setDraftMessage = useThreadComposerStore((state) => state.setDraftMessage);
  const appendDraftAttachments = useThreadComposerStore((state) => state.appendDraftAttachments);
  const appendDraftMessage = useThreadComposerStore((state) => state.appendDraftMessage);
  const clearDraft = useThreadComposerStore((state) => state.clearDraft);
  const removeDraftImage = useThreadComposerStore((state) => state.removeDraftImage);
  const setUserInputDraftOption = useThreadUserInputStore((state) => state.setUserInputDraftOption);
  const setUserInputDraftCustomAnswer = useThreadUserInputStore(
    (state) => state.setUserInputDraftCustomAnswer,
  );

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

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const sendQueuedMessage = useCallback(
    async (queuedMessage: QueuedThreadMessage) => {
      const client = getEnvironmentClient(queuedMessage.environmentId);
      const thread = threads.find(
        (candidate) =>
          candidate.environmentId === queuedMessage.environmentId &&
          candidate.id === queuedMessage.threadId,
      );
      if (!client || !thread) {
        return;
      }

      beginDispatchingQueuedMessage(queuedMessage.messageId);
      try {
        await client.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make(queuedMessage.commandId),
          threadId: ThreadId.make(queuedMessage.threadId),
          message: {
            messageId: MessageId.make(queuedMessage.messageId),
            role: "user",
            text: queuedMessage.text,
            attachments: queuedMessage.attachments,
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: queuedMessage.createdAt,
        });

        removeQueuedMessage(
          queuedMessage.environmentId,
          queuedMessage.threadId,
          queuedMessage.messageId,
        );
      } catch (error) {
        removeQueuedMessage(
          queuedMessage.environmentId,
          queuedMessage.threadId,
          queuedMessage.messageId,
        );
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to send message.",
        );
      } finally {
        finishDispatchingQueuedMessage(queuedMessage.messageId);
      }
    },
    [
      beginDispatchingQueuedMessage,
      finishDispatchingQueuedMessage,
      removeQueuedMessage,
      setPendingConnectionError,
      threads,
    ],
  );

  useQueueDrain({
    dispatchingQueuedMessageId,
    queuedMessagesByThreadKey,
    threads,
    environments: connectedEnvironments,
    sendQueuedMessage,
  });

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
    enqueueQueuedMessage({
      environmentId: selectedThread.environmentId,
      threadId: selectedThread.id,
      messageId: MessageId.make(uuidv4()),
      commandId: CommandId.make(uuidv4()),
      text,
      attachments,
      createdAt,
    });
    clearDraft(threadKey);
  }, [
    clearDraft,
    draftAttachmentsByThreadKey,
    draftMessageByThreadKey,
    enqueueQueuedMessage,
    selectedThread,
  ]);

  const onSelectUserInputOption = useCallback(
    (requestId: string, questionId: string, label: string) => {
      if (!selectedThread) {
        return;
      }

      const requestKey = scopedRequestKey(
        selectedThread.environmentId,
        requestId as ApprovalRequestId,
      );
      setUserInputDraftOption(requestKey, questionId, label);
    },
    [selectedThread, setUserInputDraftOption],
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
      setUserInputDraftCustomAnswer(requestKey, questionId, customAnswer);
    },
    [selectedThread, setUserInputDraftCustomAnswer],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThread) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
      setDraftMessage(threadKey, value);
    },
    [selectedThread, setDraftMessage],
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
      appendDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [
    appendDraftAttachments,
    draftAttachmentsByThreadKey,
    selectedThread,
    setPendingConnectionError,
  ]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThread) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
    const result = await pasteComposerClipboard({
      existingCount: draftAttachmentsByThreadKey[threadKey]?.length ?? 0,
    });
    if (result.images.length > 0) {
      appendDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendDraftMessage(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [
    appendDraftAttachments,
    appendDraftMessage,
    draftAttachmentsByThreadKey,
    selectedThread,
    setPendingConnectionError,
  ]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThread || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: draftAttachmentsByThreadKey[threadKey]?.length ?? 0,
        });
        if (images.length > 0) {
          appendDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", error);
      }
    },
    [appendDraftAttachments, draftAttachmentsByThreadKey, selectedThread],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThread) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThread.environmentId, selectedThread.id);
      removeDraftImage(threadKey, imageId);
    },
    [removeDraftImage, selectedThread],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    activeWorkDurationLabel,
    activePendingApproval,
    activePendingUserInput,
    activePendingUserInputDrafts,
    activePendingUserInputAnswers,
    draftMessage,
    draftAttachments,
    activeThreadBusy,
    onChangeDraftMessage,
    onPickDraftImages,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onSelectUserInputOption,
    onChangeUserInputCustomAnswer,
  };
}
