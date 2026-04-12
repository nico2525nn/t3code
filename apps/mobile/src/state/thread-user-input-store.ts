import type { ApprovalRequestId } from "@t3tools/contracts";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import {
  setPendingUserInputCustomAnswer,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";

interface ThreadUserInputStoreState {
  readonly userInputDraftsByRequestKey: Record<string, Record<string, PendingUserInputDraftAnswer>>;
  readonly respondingUserInputId: ApprovalRequestId | null;

  readonly setUserInputDraftOption: (requestKey: string, questionId: string, label: string) => void;
  readonly setUserInputDraftCustomAnswer: (
    requestKey: string,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly beginRespondingUserInput: (requestId: ApprovalRequestId) => void;
  readonly finishRespondingUserInput: (requestId: ApprovalRequestId) => void;
}

export const threadUserInputStore = createStore<ThreadUserInputStoreState>()((set) => ({
  userInputDraftsByRequestKey: {},
  respondingUserInputId: null,

  setUserInputDraftOption: (requestKey, questionId, label) =>
    set((state) => ({
      userInputDraftsByRequestKey: {
        ...state.userInputDraftsByRequestKey,
        [requestKey]: {
          ...state.userInputDraftsByRequestKey[requestKey],
          [questionId]: {
            selectedOptionLabel: label,
          },
        },
      },
    })),
  setUserInputDraftCustomAnswer: (requestKey, questionId, customAnswer) =>
    set((state) => ({
      userInputDraftsByRequestKey: {
        ...state.userInputDraftsByRequestKey,
        [requestKey]: {
          ...state.userInputDraftsByRequestKey[requestKey],
          [questionId]: setPendingUserInputCustomAnswer(
            state.userInputDraftsByRequestKey[requestKey]?.[questionId],
            customAnswer,
          ),
        },
      },
    })),
  beginRespondingUserInput: (requestId) => set({ respondingUserInputId: requestId }),
  finishRespondingUserInput: (requestId) =>
    set((state) => ({
      respondingUserInputId:
        state.respondingUserInputId === requestId ? null : state.respondingUserInputId,
    })),
}));

export function useThreadUserInputStore<T>(selector: (state: ThreadUserInputStoreState) => T): T {
  return useStore(threadUserInputStore, selector);
}
