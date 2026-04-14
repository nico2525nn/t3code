import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import ThreadTerminalDrawer from "../ThreadTerminalDrawer";
import { projectScriptCwd, projectScriptRuntimeEnv } from "@t3tools/shared/projectScripts";
import { readEnvironmentApi } from "../../environmentApi";
import { useStore } from "../../store";
import type { TerminalContextSelection } from "../../lib/terminalContext";
import { useWorkspaceStore } from "../../workspace/store";

export function ThreadTerminalSurface(props: { threadRef: ScopedThreadRef }) {
  const { threadRef } = props;
  const thread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = thread
    ? scopeProjectRef(thread.environmentId, thread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, threadRef),
  );
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const terminalLaunchContext = useTerminalStateStore(
    (state) => state.terminalLaunchContextByThreadKey[scopedThreadKey(threadRef)] ?? null,
  );
  const addTerminalContext = useComposerDraftStore((state) => state.addTerminalContext);
  const closeTerminalSurfacesForThread = useWorkspaceStore(
    (state) => state.closeTerminalSurfacesForThread,
  );
  const [containerHeight, setContainerHeight] = useState(320);
  const [focusRequestId, setFocusRequestId] = useState(1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const worktreePath = thread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const effectiveWorktreePath = terminalLaunchContext?.worktreePath ?? worktreePath;
  const cwd = useMemo(
    () =>
      terminalLaunchContext?.cwd ??
      (project
        ? projectScriptCwd({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : null),
    [effectiveWorktreePath, project, terminalLaunchContext?.cwd],
  );
  const runtimeEnv = useMemo(
    () =>
      project
        ? projectScriptRuntimeEnv({
            project: { cwd: project.cwd },
            worktreePath: effectiveWorktreePath,
          })
        : {},
    [effectiveWorktreePath, project],
  );

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const nextHeight = Math.max(180, Math.floor(entries[0]?.contentRect.height ?? 0));
      setContainerHeight((current) => (current === nextHeight ? current : nextHeight));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setFocusRequestId((current) => current + 1);
  }, [terminalState.activeTerminalId]);

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) {
        return;
      }

      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      const fallbackExitWrite = () =>
        api.terminal
          .write({ threadId: threadRef.threadId, terminalId, data: "exit\n" })
          .catch(() => undefined);

      if ("close" in api.terminal && typeof api.terminal.close === "function") {
        void (async () => {
          if (isFinalTerminal) {
            await api.terminal
              .clear({ threadId: threadRef.threadId, terminalId })
              .catch(() => undefined);
          }
          await api.terminal.close({
            threadId: threadRef.threadId,
            terminalId,
            deleteHistory: true,
          });
        })().catch(() => fallbackExitWrite());
      } else {
        void fallbackExitWrite();
      }

      storeCloseTerminal(threadRef, terminalId);
      if (isFinalTerminal) {
        closeTerminalSurfacesForThread(threadRef);
      }
      setFocusRequestId((current) => current + 1);
    },
    [
      closeTerminalSurfacesForThread,
      storeCloseTerminal,
      terminalState.terminalIds.length,
      threadRef,
    ],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      addTerminalContext(threadRef, {
        ...selection,
        id: randomUUID(),
        threadId: threadRef.threadId,
        createdAt: new Date().toISOString(),
      });
    },
    [addTerminalContext, threadRef],
  );

  if (!project || !cwd) {
    return <div ref={containerRef} className="min-h-0 flex-1 bg-background" />;
  }

  return (
    <div ref={containerRef} className="min-h-0 flex-1 overflow-hidden bg-background">
      <ThreadTerminalDrawer
        threadRef={threadRef}
        threadId={threadRef.threadId}
        cwd={cwd}
        worktreePath={effectiveWorktreePath}
        runtimeEnv={runtimeEnv}
        visible
        height={containerHeight}
        terminalIds={terminalState.terminalIds}
        activeTerminalId={terminalState.activeTerminalId}
        terminalGroups={terminalState.terminalGroups}
        activeTerminalGroupId={terminalState.activeTerminalGroupId}
        focusRequestId={focusRequestId}
        onSplitTerminal={() => {
          storeSplitTerminal(threadRef, `terminal-${randomUUID()}`);
          setFocusRequestId((current) => current + 1);
        }}
        onNewTerminal={() => {
          storeNewTerminal(threadRef, `terminal-${randomUUID()}`);
          setFocusRequestId((current) => current + 1);
        }}
        onActiveTerminalChange={(terminalId) => {
          storeSetActiveTerminal(threadRef, terminalId);
          setFocusRequestId((current) => current + 1);
        }}
        onCloseTerminal={closeTerminal}
        onHeightChange={(height) => {
          storeSetTerminalHeight(threadRef, height);
        }}
        onAddTerminalContext={handleAddTerminalContext}
        showResizeHandle={false}
      />
    </div>
  );
}
