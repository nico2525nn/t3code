import type { ApprovalRequestId } from "@t3tools/contracts";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

interface ThreadApprovalStoreState {
  readonly respondingApprovalId: ApprovalRequestId | null;
  readonly beginRespondingApproval: (requestId: ApprovalRequestId) => void;
  readonly finishRespondingApproval: (requestId: ApprovalRequestId) => void;
}

export const threadApprovalStore = createStore<ThreadApprovalStoreState>()((set) => ({
  respondingApprovalId: null,
  beginRespondingApproval: (requestId) => set({ respondingApprovalId: requestId }),
  finishRespondingApproval: (requestId) =>
    set((state) => ({
      respondingApprovalId:
        state.respondingApprovalId === requestId ? null : state.respondingApprovalId,
    })),
}));

export function useThreadApprovalStore<T>(selector: (state: ThreadApprovalStoreState) => T): T {
  return useStore(threadApprovalStore, selector);
}
