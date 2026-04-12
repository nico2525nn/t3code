import { useStore } from "zustand";
import { createStore } from "zustand/vanilla";

import type { SelectedThreadRef } from "./remote-runtime-types";

interface ThreadSelectionStoreState {
  readonly selectedThreadRef: SelectedThreadRef | null;
  readonly selectThreadRef: (threadRef: SelectedThreadRef) => void;
  readonly clearSelectedThreadRef: () => void;
}

export const threadSelectionStore = createStore<ThreadSelectionStoreState>()((set) => ({
  selectedThreadRef: null,
  selectThreadRef: (threadRef) => set({ selectedThreadRef: threadRef }),
  clearSelectedThreadRef: () => set({ selectedThreadRef: null }),
}));

export function useThreadSelectionStore<T>(selector: (state: ThreadSelectionStoreState) => T): T {
  return useStore(threadSelectionStore, selector);
}
