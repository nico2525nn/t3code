import type { GitStatusResult } from "@t3tools/contracts";
import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

interface ThreadGitStoreState {
  readonly gitStatusByThreadKey: Record<string, GitStatusResult | null>;
  readonly gitOperationLabelByThreadKey: Record<string, string | null>;
  readonly setThreadGitStatus: (threadKey: string, status: GitStatusResult | null) => void;
  readonly setThreadGitOperationLabel: (threadKey: string, label: string | null) => void;
  readonly clearThreadGitState: (threadKey: string) => void;
}

export const threadGitStore = createStore<ThreadGitStoreState>()((set) => ({
  gitStatusByThreadKey: {},
  gitOperationLabelByThreadKey: {},
  setThreadGitStatus: (threadKey, status) =>
    set((state) => ({
      gitStatusByThreadKey: {
        ...state.gitStatusByThreadKey,
        [threadKey]: status,
      },
    })),
  setThreadGitOperationLabel: (threadKey, label) =>
    set((state) => ({
      gitOperationLabelByThreadKey: {
        ...state.gitOperationLabelByThreadKey,
        [threadKey]: label,
      },
    })),
  clearThreadGitState: (threadKey) =>
    set((state) => {
      const nextStatus = { ...state.gitStatusByThreadKey };
      const nextLabel = { ...state.gitOperationLabelByThreadKey };
      delete nextStatus[threadKey];
      delete nextLabel[threadKey];
      return {
        gitStatusByThreadKey: nextStatus,
        gitOperationLabelByThreadKey: nextLabel,
      };
    }),
}));

export function useThreadGitStore<T>(selector: (state: ThreadGitStoreState) => T): T {
  return useStore(threadGitStore, selector);
}
