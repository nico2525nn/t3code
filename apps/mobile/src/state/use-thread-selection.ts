import { useCallback, useEffect, useMemo } from "react";

import type { SavedRemoteConnection } from "../lib/connection";
import type { ScopedMobileProject, ScopedMobileThread } from "../lib/scopedEntities";
import { useRemoteCatalog } from "./use-remote-catalog";
import { type EnvironmentRuntimeState } from "./remote-runtime-types";
import { useRemoteEnvironmentState } from "./use-remote-environment-registry";
import { useThreadSelectionStore } from "./thread-selection-store";

function deriveSelectedThread(
  selectedThreadRef: { readonly environmentId: string; readonly threadId: string } | null,
  threads: ReadonlyArray<ScopedMobileThread>,
): ScopedMobileThread | null {
  if (!selectedThreadRef) {
    return null;
  }

  return (
    threads.find(
      (thread) =>
        thread.environmentId === selectedThreadRef.environmentId &&
        thread.id === selectedThreadRef.threadId,
    ) ?? null
  );
}

function deriveSelectedThreadProject(
  selectedThread: ScopedMobileThread | null,
  projects: ReadonlyArray<ScopedMobileProject>,
): ScopedMobileProject | null {
  if (!selectedThread) {
    return null;
  }

  return (
    projects.find(
      (project) =>
        project.environmentId === selectedThread.environmentId &&
        project.id === selectedThread.projectId,
    ) ?? null
  );
}

export function useThreadSelection() {
  const { projects, threads } = useRemoteCatalog();
  const { environmentStateById, savedConnectionsById } = useRemoteEnvironmentState();
  const selectedThreadRef = useThreadSelectionStore((state) => state.selectedThreadRef);
  const selectThreadRef = useThreadSelectionStore((state) => state.selectThreadRef);
  const clearSelectedThreadRef = useThreadSelectionStore((state) => state.clearSelectedThreadRef);

  const selectedThread = useMemo(
    () => deriveSelectedThread(selectedThreadRef, threads),
    [selectedThreadRef, threads],
  );

  useEffect(() => {
    if (!selectedThreadRef || selectedThread) {
      return;
    }

    clearSelectedThreadRef();
  }, [clearSelectedThreadRef, selectedThread, selectedThreadRef]);

  const selectedThreadProject = useMemo(
    () => deriveSelectedThreadProject(selectedThread, projects),
    [projects, selectedThread],
  );

  const selectedEnvironmentConnection = selectedThread
    ? (savedConnectionsById[selectedThread.environmentId] ?? null)
    : null;
  const selectedEnvironmentRuntime = selectedThread
    ? (environmentStateById[selectedThread.environmentId] ?? null)
    : null;

  const onSelectThread = useCallback(
    (thread: ScopedMobileThread) => {
      selectThreadRef({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
    },
    [selectThreadRef],
  );

  const onBackFromThread = useCallback(() => {
    clearSelectedThreadRef();
  }, [clearSelectedThreadRef]);

  return {
    selectedThreadRef,
    selectThreadRef,
    clearSelectedThreadRef,
    selectedThread,
    selectedThreadProject,
    selectedEnvironmentConnection,
    selectedEnvironmentRuntime,
    onSelectThread,
    onBackFromThread,
  };
}

export type ThreadSelectionSnapshot = {
  readonly savedConnectionsById: Record<string, SavedRemoteConnection>;
  readonly environmentStateById: Record<string, EnvironmentRuntimeState>;
};
