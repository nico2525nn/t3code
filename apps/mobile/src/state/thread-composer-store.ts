import type { MessageId, ThreadId } from "@t3tools/contracts";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import type { QueuedThreadMessage } from "../lib/threadActivity";

interface ThreadComposerStoreState {
  readonly nowTick: number;
  readonly draftMessageByThreadKey: Record<string, string>;
  readonly draftAttachmentsByThreadKey: Record<string, ReadonlyArray<DraftComposerImageAttachment>>;
  readonly dispatchingQueuedMessageId: MessageId | null;
  readonly queuedMessagesByThreadKey: Record<string, ReadonlyArray<QueuedThreadMessage>>;

  readonly setNowTick: (tick: number) => void;
  readonly setDraftMessage: (threadKey: string, value: string) => void;
  readonly appendDraftAttachments: (
    threadKey: string,
    attachments: ReadonlyArray<DraftComposerImageAttachment>,
  ) => void;
  readonly appendDraftMessage: (threadKey: string, value: string) => void;
  readonly clearDraft: (threadKey: string) => void;
  readonly removeDraftImage: (threadKey: string, imageId: string) => void;
  readonly beginDispatchingQueuedMessage: (queuedMessageId: MessageId) => void;
  readonly finishDispatchingQueuedMessage: (queuedMessageId: MessageId) => void;
  readonly enqueueQueuedMessage: (message: QueuedThreadMessage) => void;
  readonly removeQueuedMessage: (
    environmentId: string,
    threadId: ThreadId,
    queuedMessageId: MessageId,
  ) => void;
}

export const threadComposerStore = createStore<ThreadComposerStoreState>()((set) => ({
  nowTick: Date.now(),
  draftMessageByThreadKey: {},
  draftAttachmentsByThreadKey: {},
  dispatchingQueuedMessageId: null,
  queuedMessagesByThreadKey: {},

  setNowTick: (tick) => set({ nowTick: tick }),
  setDraftMessage: (threadKey, value) =>
    set((state) => ({
      draftMessageByThreadKey: {
        ...state.draftMessageByThreadKey,
        [threadKey]: value,
      },
    })),
  appendDraftAttachments: (threadKey, attachments) =>
    set((state) => ({
      draftAttachmentsByThreadKey: {
        ...state.draftAttachmentsByThreadKey,
        [threadKey]: [...(state.draftAttachmentsByThreadKey[threadKey] ?? []), ...attachments],
      },
    })),
  appendDraftMessage: (threadKey, value) =>
    set((state) => ({
      draftMessageByThreadKey: {
        ...state.draftMessageByThreadKey,
        [threadKey]: `${state.draftMessageByThreadKey[threadKey] ?? ""}${value}`,
      },
    })),
  clearDraft: (threadKey) =>
    set((state) => ({
      draftMessageByThreadKey: {
        ...state.draftMessageByThreadKey,
        [threadKey]: "",
      },
      draftAttachmentsByThreadKey: {
        ...state.draftAttachmentsByThreadKey,
        [threadKey]: [],
      },
    })),
  removeDraftImage: (threadKey, imageId) =>
    set((state) => ({
      draftAttachmentsByThreadKey: {
        ...state.draftAttachmentsByThreadKey,
        [threadKey]: (state.draftAttachmentsByThreadKey[threadKey] ?? []).filter(
          (image) => image.id !== imageId,
        ),
      },
    })),
  beginDispatchingQueuedMessage: (queuedMessageId) =>
    set({ dispatchingQueuedMessageId: queuedMessageId }),
  finishDispatchingQueuedMessage: (queuedMessageId) =>
    set((state) => ({
      dispatchingQueuedMessageId:
        state.dispatchingQueuedMessageId === queuedMessageId
          ? null
          : state.dispatchingQueuedMessageId,
    })),
  enqueueQueuedMessage: (message) =>
    set((state) => {
      const threadKey = scopedThreadKey(message.environmentId, message.threadId);
      return {
        queuedMessagesByThreadKey: {
          ...state.queuedMessagesByThreadKey,
          [threadKey]: [...(state.queuedMessagesByThreadKey[threadKey] ?? []), message],
        },
      };
    }),
  removeQueuedMessage: (environmentId, threadId, queuedMessageId) =>
    set((state) => {
      const threadKey = scopedThreadKey(environmentId, threadId);
      const existing = state.queuedMessagesByThreadKey[threadKey];
      if (!existing) {
        return state;
      }
      const nextQueue = existing.filter((entry) => entry.messageId !== queuedMessageId);
      const next = { ...state.queuedMessagesByThreadKey };
      if (nextQueue.length === 0) {
        delete next[threadKey];
      } else {
        next[threadKey] = nextQueue;
      }
      return { queuedMessagesByThreadKey: next };
    }),
}));

export function useThreadComposerStore<T>(selector: (state: ThreadComposerStoreState) => T): T {
  return useStore(threadComposerStore, selector);
}
