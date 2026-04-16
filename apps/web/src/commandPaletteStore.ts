import { create } from "zustand";

export interface CommandPaletteWorkspaceTarget {
  disposition: "split-right" | "split-down";
}

interface CommandPaletteStore {
  open: boolean;
  workspaceTarget: CommandPaletteWorkspaceTarget | null;
  setOpen: (open: boolean) => void;
  toggleOpen: () => void;
  openWorkspaceTarget: (target: CommandPaletteWorkspaceTarget) => void;
  clearWorkspaceTarget: () => void;
}

export const useCommandPaletteStore = create<CommandPaletteStore>((set) => ({
  open: false,
  workspaceTarget: null,
  setOpen: (open) => set({ open, ...(open ? {} : { workspaceTarget: null }) }),
  toggleOpen: () =>
    set((state) => {
      const next = !state.open;
      return { open: next, ...(next ? {} : { workspaceTarget: null }) };
    }),
  openWorkspaceTarget: (target) => set({ open: true, workspaceTarget: target }),
  clearWorkspaceTarget: () => set({ workspaceTarget: null }),
}));
