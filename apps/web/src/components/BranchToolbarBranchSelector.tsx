import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import type { EnvironmentId, VcsRef, ThreadId } from "@t3tools/contracts";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import { ChevronDownIcon, TriangleAlertIcon } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useOptimistic,
  useRef,
  useState,
  useTransition,
} from "react";

import { useComposerDraftStore, type DraftId } from "../composerDraftStore";
import { readEnvironmentApi } from "../environmentApi";
import { vcsQueryKeys, vcsRefSearchInfiniteQueryOptions } from "../lib/vcsReactQuery";
import { refreshVcsStatus, useVcsStatus } from "../lib/vcsStatusState";
import { cn, newCommandId } from "../lib/utils";
import { parsePullRequestReference } from "../pullRequestReference";
import { getSourceControlPresentation } from "../sourceControlPresentation";
import { useStore } from "../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../storeSelectors";
import {
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveLocalCheckoutRefMismatch,
  resolveLocalRefNameFromRemoteRef,
  resolveRefSelectionTarget,
  resolveRefToolbarValue,
  shouldIncludeRefPickerItem,
} from "./BranchToolbar.logic";
import { Button } from "./ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxListVirtualized,
  ComboboxPopup,
  ComboboxStatus,
  ComboboxTrigger,
} from "./ui/combobox";
import { Popover, PopoverPopup, PopoverTrigger } from "./ui/popover";
import { stackedThreadToast, toastManager } from "./ui/toast";

interface BranchToolbarBranchSelectorProps {
  className?: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  draftId?: DraftId;
  envLocked: boolean;
  effectiveEnvModeOverride?: "local" | "worktree";
  activeThreadBranchOverride?: string | null;
  onActiveThreadBranchOverrideChange?: (refName: string | null) => void;
  onCheckoutPullRequestRequest?: (reference: string) => void;
  onComposerFocusRequest?: () => void;
}

function toRefActionErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function getRefTriggerLabel(input: {
  activeWorktreePath: string | null;
  effectiveEnvMode: "local" | "worktree";
  resolvedActiveRefName: string | null;
}): string {
  const { activeWorktreePath, effectiveEnvMode, resolvedActiveRefName } = input;
  if (!resolvedActiveRefName) {
    return "Select ref";
  }
  if (effectiveEnvMode === "worktree" && !activeWorktreePath) {
    return `From ${resolvedActiveRefName}`;
  }
  return resolvedActiveRefName;
}

export function BranchToolbarBranchSelector({
  className,
  environmentId,
  threadId,
  draftId,
  envLocked,
  effectiveEnvModeOverride,
  activeThreadBranchOverride,
  onActiveThreadBranchOverrideChange,
  onCheckoutPullRequestRequest,
  onComposerFocusRequest,
}: BranchToolbarBranchSelectorProps) {
  // ---------------------------------------------------------------------------
  // Thread / project state (pushed down from parent to colocate with mutation)
  // ---------------------------------------------------------------------------
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  const serverThreadSelector = useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]);
  const serverThread = useStore(serverThreadSelector);
  const serverSession = serverThread?.session ?? null;
  const setThreadBranchAction = useStore((store) => store.setThreadBranch);
  const draftThread = useComposerDraftStore((store) =>
    draftId ? store.getDraftSession(draftId) : store.getDraftThreadByRef(threadRef),
  );
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);

  const activeProjectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const activeProjectSelector = useMemo(
    () => createProjectSelectorByRef(activeProjectRef),
    [activeProjectRef],
  );
  const activeProject = useStore(activeProjectSelector);

  const activeThreadId = serverThread?.id ?? (draftThread ? threadId : undefined);
  const activeThreadBranch =
    activeThreadBranchOverride !== undefined
      ? activeThreadBranchOverride
      : (serverThread?.branch ?? draftThread?.branch ?? null);
  const activeWorktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const activeProjectCwd = activeProject?.cwd ?? null;
  const refCwd = activeWorktreePath ?? activeProjectCwd;
  const hasServerThread = serverThread !== undefined;
  const effectiveEnvMode =
    effectiveEnvModeOverride ??
    resolveEffectiveEnvMode({
      activeWorktreePath,
      hasServerThread,
      draftThreadEnvMode: draftThread?.envMode,
    });

  // ---------------------------------------------------------------------------
  // Thread ref metadata mutation (colocated — only this component calls it)
  // ---------------------------------------------------------------------------
  const setThreadBranch = useCallback(
    (branch: string | null, worktreePath: string | null) => {
      if (!activeThreadId || !activeProject) return;
      const api = readEnvironmentApi(environmentId);
      if (serverSession && worktreePath !== activeWorktreePath && api) {
        void api.orchestration
          .dispatchCommand({
            type: "thread.session.stop",
            commandId: newCommandId(),
            threadId: activeThreadId,
            createdAt: new Date().toISOString(),
          })
          .catch(() => undefined);
      }
      if (api && hasServerThread) {
        void api.orchestration.dispatchCommand({
          type: "thread.meta.update",
          commandId: newCommandId(),
          threadId: activeThreadId,
          branch,
          worktreePath,
        });
      }
      if (hasServerThread) {
        onActiveThreadBranchOverrideChange?.(branch);
        setThreadBranchAction(threadRef, branch, worktreePath);
        return;
      }
      const nextDraftEnvMode = resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: worktreePath,
        currentWorktreePath: activeWorktreePath,
        effectiveEnvMode,
      });
      setDraftThreadContext(draftId ?? threadRef, {
        branch,
        worktreePath,
        envMode: nextDraftEnvMode,
        projectRef: scopeProjectRef(environmentId, activeProject.id),
      });
    },
    [
      activeThreadId,
      activeProject,
      serverSession,
      activeWorktreePath,
      hasServerThread,
      onActiveThreadBranchOverrideChange,
      setThreadBranchAction,
      setDraftThreadContext,
      draftId,
      threadRef,
      environmentId,
      effectiveEnvMode,
    ],
  );

  // ---------------------------------------------------------------------------
  // VCS ref queries
  // ---------------------------------------------------------------------------
  const queryClient = useQueryClient();
  const [isRefMenuOpen, setIsRefMenuOpen] = useState(false);
  const [isMismatchPopoverOpen, setIsMismatchPopoverOpen] = useState(false);
  const [refQuery, setRefQuery] = useState("");
  const refPickerAnchorRef = useRef<HTMLDivElement | null>(null);
  const deferredRefQuery = useDeferredValue(refQuery);

  const vcsStatusQuery = useVcsStatus({ environmentId, cwd: refCwd });
  const trimmedRefQuery = refQuery.trim();
  const deferredTrimmedRefQuery = deferredRefQuery.trim();

  useEffect(() => {
    if (!refCwd) return;
    void queryClient.prefetchInfiniteQuery(
      vcsRefSearchInfiniteQueryOptions({ environmentId, cwd: refCwd, query: "" }),
    );
  }, [refCwd, environmentId, queryClient]);

  const {
    data: refsSearchData,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isPending: isRefsSearchPending,
  } = useInfiniteQuery(
    vcsRefSearchInfiniteQueryOptions({
      environmentId,
      cwd: refCwd,
      query: deferredTrimmedRefQuery,
    }),
  );
  const refs = useMemo(
    () => refsSearchData?.pages.flatMap((page) => page.refs) ?? [],
    [refsSearchData?.pages],
  );
  const currentRefName =
    vcsStatusQuery.data?.refName ?? refs.find((refName) => refName.current)?.name ?? null;
  const sourceControlPresentation = useMemo(
    () => getSourceControlPresentation(vcsStatusQuery.data?.sourceControlProvider),
    [vcsStatusQuery.data?.sourceControlProvider],
  );
  const SourceControlIcon = sourceControlPresentation.Icon;
  const canonicalActiveRefName = resolveRefToolbarValue({
    envMode: effectiveEnvMode,
    activeWorktreePath,
    activeThreadRefName: activeThreadBranch,
    currentRefName,
  });
  const localCheckoutRefMismatch = resolveLocalCheckoutRefMismatch({
    effectiveEnvMode,
    activeWorktreePath,
    activeThreadRefName: activeThreadBranch,
    currentRefName,
  });
  const refNames = useMemo(() => refs.map((refName) => refName.name), [refs]);
  const refByName = useMemo(
    () => new Map(refs.map((refName) => [refName.name, refName] as const)),
    [refs],
  );
  const normalizedDeferredRefQuery = deferredTrimmedRefQuery.toLowerCase();
  const changeRequestReference = parsePullRequestReference(trimmedRefQuery);
  const isSelectingWorktreeBase =
    effectiveEnvMode === "worktree" && !envLocked && !activeWorktreePath;
  const checkoutChangeRequestItemValue =
    changeRequestReference && onCheckoutPullRequestRequest
      ? `__checkout_change_request__:${changeRequestReference}`
      : null;
  const canCreateRef = !isSelectingWorktreeBase && trimmedRefQuery.length > 0;
  const hasExactRefMatch = refByName.has(trimmedRefQuery);
  const createRefItemValue = canCreateRef ? `__create_new_ref__:${trimmedRefQuery}` : null;
  const refPickerItems = useMemo(() => {
    const items = [...refNames];
    if (createRefItemValue && !hasExactRefMatch) {
      items.push(createRefItemValue);
    }
    if (checkoutChangeRequestItemValue) {
      items.unshift(checkoutChangeRequestItemValue);
    }
    return items;
  }, [refNames, checkoutChangeRequestItemValue, createRefItemValue, hasExactRefMatch]);
  const filteredRefPickerItems = useMemo(
    () =>
      normalizedDeferredRefQuery.length === 0
        ? refPickerItems
        : refPickerItems.filter((itemValue) =>
            shouldIncludeRefPickerItem({
              itemValue,
              normalizedQuery: normalizedDeferredRefQuery,
              createRefItemValue,
              checkoutChangeRequestItemValue,
            }),
          ),
    [
      refPickerItems,
      checkoutChangeRequestItemValue,
      createRefItemValue,
      normalizedDeferredRefQuery,
    ],
  );
  const [resolvedActiveRefName, setOptimisticRefName] = useOptimistic(
    canonicalActiveRefName,
    (_currentRefName: string | null, optimisticRefName: string | null) => optimisticRefName,
  );
  const [isRefActionPending, startRefActionTransition] = useTransition();
  const shouldVirtualizeRefList = filteredRefPickerItems.length > 40;
  const totalRefCount = refsSearchData?.pages[0]?.totalCount ?? 0;
  const refStatusText = isRefsSearchPending
    ? "Loading refs..."
    : isFetchingNextPage
      ? "Loading more refs..."
      : hasNextPage
        ? `Showing ${refs.length} of ${totalRefCount} refs`
        : null;

  // ---------------------------------------------------------------------------
  // Ref actions
  // ---------------------------------------------------------------------------
  const runRefAction = (action: () => Promise<void>) => {
    startRefActionTransition(async () => {
      await action().catch(() => undefined);
      await queryClient
        .invalidateQueries({ queryKey: vcsQueryKeys.refs(environmentId, refCwd) })
        .catch(() => undefined);
      await refreshVcsStatus({ environmentId, cwd: refCwd }).catch(() => undefined);
    });
  };

  const selectRef = (ref: VcsRef) => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !refCwd || !activeProjectCwd || isRefActionPending) return;

    if (isSelectingWorktreeBase) {
      setThreadBranch(ref.name, null);
      setIsRefMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectionTarget = resolveRefSelectionTarget({
      activeProjectCwd,
      activeWorktreePath,
      ref,
    });

    if (selectionTarget.reuseExistingWorktree) {
      setThreadBranch(ref.name, selectionTarget.nextWorktreePath);
      setIsRefMenuOpen(false);
      onComposerFocusRequest?.();
      return;
    }

    const selectedRefName = ref.isRemote ? resolveLocalRefNameFromRemoteRef(ref) : ref.name;

    setIsRefMenuOpen(false);
    onComposerFocusRequest?.();

    runRefAction(async () => {
      const previousRefName = resolvedActiveRefName;
      setOptimisticRefName(selectedRefName);
      try {
        const checkoutResult = await api.vcs.switchRef({
          cwd: selectionTarget.checkoutCwd,
          refName: ref.name,
        });
        const nextRefName = ref.isRemote
          ? (checkoutResult.refName ?? selectedRefName)
          : selectedRefName;
        setOptimisticRefName(nextRefName);
        setThreadBranch(nextRefName, selectionTarget.nextWorktreePath);
      } catch (error) {
        setOptimisticRefName(previousRefName);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch ref.",
            description: toRefActionErrorMessage(error),
          }),
        );
      }
    });
  };

  const createRef = (rawName: string) => {
    const name = rawName.trim();
    const api = readEnvironmentApi(environmentId);
    if (!api || !refCwd || !name || isRefActionPending) return;

    setIsRefMenuOpen(false);
    onComposerFocusRequest?.();

    runRefAction(async () => {
      const previousRefName = resolvedActiveRefName;
      setOptimisticRefName(name);
      try {
        const createRefResult = await api.vcs.createRef({
          cwd: refCwd,
          refName: name,
          switchRef: true,
        });
        setOptimisticRefName(createRefResult.refName);
        setThreadBranch(createRefResult.refName, activeWorktreePath);
      } catch (error) {
        setOptimisticRefName(previousRefName);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to create and switch ref.",
            description: toRefActionErrorMessage(error),
          }),
        );
      }
    });
  };

  const switchCheckoutToThreadBranch = () => {
    const api = readEnvironmentApi(environmentId);
    if (!api || !activeProjectCwd || !localCheckoutRefMismatch || isRefActionPending) {
      return;
    }

    runRefAction(async () => {
      const previousRefName = resolvedActiveRefName;
      setOptimisticRefName(localCheckoutRefMismatch.threadRefName);
      try {
        const switchResult = await api.vcs.switchRef({
          cwd: activeProjectCwd,
          refName: localCheckoutRefMismatch.threadRefName,
        });
        setOptimisticRefName(switchResult.refName ?? localCheckoutRefMismatch.threadRefName);
        setIsMismatchPopoverOpen(false);
        onComposerFocusRequest?.();
      } catch (error) {
        setOptimisticRefName(previousRefName);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Failed to switch checkout.",
            description: toRefActionErrorMessage(error),
          }),
        );
      }
    });
  };

  const useCurrentCheckoutForThread = () => {
    if (!localCheckoutRefMismatch || isRefActionPending) {
      return;
    }

    setThreadBranch(localCheckoutRefMismatch.currentRefName, null);
    setIsMismatchPopoverOpen(false);
    onComposerFocusRequest?.();
  };

  useEffect(() => {
    if (
      effectiveEnvMode !== "worktree" ||
      activeWorktreePath ||
      activeThreadBranch ||
      !currentRefName
    ) {
      return;
    }
    setThreadBranch(currentRefName, null);
  }, [activeThreadBranch, activeWorktreePath, currentRefName, effectiveEnvMode, setThreadBranch]);

  // ---------------------------------------------------------------------------
  // Combobox / list plumbing
  // ---------------------------------------------------------------------------
  const handleOpenChange = useCallback(
    (open: boolean) => {
      setIsRefMenuOpen(open);
      if (!open) {
        setRefQuery("");
        return;
      }
      void queryClient.invalidateQueries({
        queryKey: vcsQueryKeys.refs(environmentId, refCwd),
      });
    },
    [refCwd, environmentId, queryClient],
  );

  const refListScrollElementRef = useRef<HTMLDivElement | null>(null);
  const maybeFetchNextRefPage = useCallback(() => {
    if (!isRefMenuOpen || !hasNextPage || isFetchingNextPage) {
      return;
    }

    const scrollElement = refListScrollElementRef.current;
    if (!scrollElement) {
      return;
    }

    const distanceFromBottom =
      scrollElement.scrollHeight - scrollElement.scrollTop - scrollElement.clientHeight;
    if (distanceFromBottom > 96) {
      return;
    }

    void fetchNextPage().catch(() => undefined);
  }, [fetchNextPage, hasNextPage, isRefMenuOpen, isFetchingNextPage]);
  const refListRef = useRef<LegendListRef | null>(null);
  const setRefListRef = useCallback((element: HTMLDivElement | null) => {
    refListScrollElementRef.current = (element?.parentElement as HTMLDivElement | null) ?? null;
  }, []);

  useEffect(() => {
    if (!isRefMenuOpen) {
      return;
    }

    if (shouldVirtualizeRefList) {
      refListRef.current?.scrollToOffset?.({ offset: 0, animated: false });
    } else {
      refListScrollElementRef.current?.scrollTo({ top: 0 });
    }
  }, [deferredTrimmedRefQuery, isRefMenuOpen, shouldVirtualizeRefList]);

  useEffect(() => {
    const scrollElement = refListScrollElementRef.current;
    if (!scrollElement || !isRefMenuOpen) {
      return;
    }

    const handleScroll = () => {
      maybeFetchNextRefPage();
    };

    scrollElement.addEventListener("scroll", handleScroll, { passive: true });
    handleScroll();
    return () => {
      scrollElement.removeEventListener("scroll", handleScroll);
    };
  }, [isRefMenuOpen, maybeFetchNextRefPage]);

  useEffect(() => {
    if (shouldVirtualizeRefList) return;
    maybeFetchNextRefPage();
  }, [refs.length, maybeFetchNextRefPage, shouldVirtualizeRefList]);

  const triggerLabel = getRefTriggerLabel({
    activeWorktreePath,
    effectiveEnvMode,
    resolvedActiveRefName,
  });

  function renderPickerItem(itemValue: string, index: number) {
    if (checkoutChangeRequestItemValue && itemValue === checkoutChangeRequestItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => {
            if (!changeRequestReference || !onCheckoutPullRequestRequest) {
              return;
            }
            setIsRefMenuOpen(false);
            setRefQuery("");
            onComposerFocusRequest?.();
            onCheckoutPullRequestRequest(changeRequestReference);
          }}
        >
          <div className="flex min-w-0 items-center gap-2 py-1">
            <SourceControlIcon className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="flex min-w-0 flex-col items-start">
              <span className="truncate font-medium">
                Checkout {sourceControlPresentation.terminology.singular}
              </span>
              <span className="truncate text-muted-foreground text-xs">
                {changeRequestReference}
              </span>
            </span>
          </div>
        </ComboboxItem>
      );
    }
    if (createRefItemValue && itemValue === createRefItemValue) {
      return (
        <ComboboxItem
          hideIndicator
          key={itemValue}
          index={index}
          value={itemValue}
          onClick={() => createRef(trimmedRefQuery)}
        >
          <span className="truncate">Create new ref &quot;{trimmedRefQuery}&quot;</span>
        </ComboboxItem>
      );
    }

    const ref = refByName.get(itemValue);
    if (!ref) return null;

    const hasSecondaryWorktree =
      ref.worktreePath && activeProjectCwd && ref.worktreePath !== activeProjectCwd;
    const badge = ref.current
      ? "current"
      : hasSecondaryWorktree
        ? "worktree"
        : ref.isRemote
          ? "remote"
          : ref.isDefault
            ? "default"
            : null;
    return (
      <ComboboxItem
        hideIndicator
        key={itemValue}
        index={index}
        value={itemValue}
        onClick={() => selectRef(ref)}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="truncate">{itemValue}</span>
          {badge && <span className="shrink-0 text-[10px] text-muted-foreground/45">{badge}</span>}
        </div>
      </ComboboxItem>
    );
  }

  return (
    <div
      ref={refPickerAnchorRef}
      className={cn("relative flex min-w-0 items-center justify-end", className)}
    >
      {localCheckoutRefMismatch ? (
        <Popover open={isMismatchPopoverOpen} onOpenChange={setIsMismatchPopoverOpen}>
          <PopoverTrigger
            openOnHover
            delay={120}
            closeDelay={100}
            render={
              <button
                type="button"
                className="absolute left-1.5 top-1/2 z-10 flex size-4.5 -translate-y-1/2 items-center justify-center rounded-sm text-warning outline-none transition-colors hover:bg-warning/10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background"
                aria-label="Thread ref does not match current checkout"
              />
            }
          >
            <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
          </PopoverTrigger>
          <PopoverPopup
            tooltipStyle
            side="top"
            align="center"
            sideOffset={8}
            anchor={refPickerAnchorRef}
            className="w-[28rem] max-w-[calc(100vw-2rem)] px-2 py-2"
          >
            <div className="chat-markdown space-y-2.5 text-xs leading-snug">
              <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] gap-x-2.5 gap-y-1.5">
                <span className="text-muted-foreground">Thread</span>
                <code className="max-w-full justify-self-start">
                  {localCheckoutRefMismatch.threadRefName}
                </code>
                <span className="text-muted-foreground">Checkout</span>
                <code className="max-w-full justify-self-start">
                  {localCheckoutRefMismatch.currentRefName}
                </code>
              </div>
              <p className="!my-0 border-border/70 border-t pt-2 text-muted-foreground">
                This thread was last associated with{" "}
                <code>{localCheckoutRefMismatch.threadRefName}</code>, but your checkout is on
                another ref. Switch to keep working there, or use current to update the thread to
                this checkout.
              </p>
              <div className="mt-2 flex justify-end gap-1.5">
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-1.5 text-[11px] text-muted-foreground hover:text-foreground"
                  disabled={isRefActionPending}
                  title={`Associate this thread with ${localCheckoutRefMismatch.currentRefName}`}
                  onClick={useCurrentCheckoutForThread}
                >
                  Use current
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-1.5 text-[11px]"
                  disabled={isRefActionPending}
                  title={`Switch to ${localCheckoutRefMismatch.threadRefName}`}
                  onClick={switchCheckoutToThreadBranch}
                >
                  Switch
                </Button>
              </div>
            </div>
          </PopoverPopup>
        </Popover>
      ) : null}
      <Combobox
        items={refPickerItems}
        filteredItems={filteredRefPickerItems}
        autoHighlight
        virtualized={shouldVirtualizeRefList}
        onItemHighlighted={(_value, eventDetails) => {
          if (!isRefMenuOpen || eventDetails.index < 0 || eventDetails.reason !== "keyboard") {
            return;
          }
          refListRef.current?.scrollIndexIntoView?.({
            index: eventDetails.index,
            animated: false,
          });
        }}
        onOpenChange={handleOpenChange}
        open={isRefMenuOpen}
        value={resolvedActiveRefName}
      >
        <ComboboxTrigger
          render={<Button variant="ghost" size="xs" />}
          className={cn(
            "min-w-0 text-muted-foreground/70 hover:text-foreground/80",
            localCheckoutRefMismatch &&
              "border-warning/35 bg-warning/10 pl-7 text-warning hover:bg-warning/15 hover:text-warning",
          )}
          disabled={(isRefsSearchPending && refs.length === 0) || isRefActionPending}
        >
          <span className="min-w-0 max-w-[240px] truncate">{triggerLabel}</span>
          <ChevronDownIcon className="shrink-0" />
        </ComboboxTrigger>
        <ComboboxPopup align="end" side="top" className="w-80">
          <div className="border-b p-1">
            <ComboboxInput
              className="[&_input]:font-sans rounded-md"
              inputClassName="ring-0"
              placeholder="Search refs..."
              showTrigger={false}
              size="sm"
              value={refQuery}
              onChange={(event) => setRefQuery(event.target.value)}
            />
          </div>
          <ComboboxEmpty>No refs found.</ComboboxEmpty>

          {shouldVirtualizeRefList ? (
            <ComboboxListVirtualized>
              <LegendList<string>
                ref={refListRef}
                data={filteredRefPickerItems}
                keyExtractor={(item) => item}
                renderItem={({ item, index }) => renderPickerItem(item, index)}
                estimatedItemSize={28}
                drawDistance={336}
                onEndReached={() => {
                  if (hasNextPage && !isFetchingNextPage) {
                    void fetchNextPage().catch(() => undefined);
                  }
                }}
                style={{ maxHeight: "14rem" }}
              />
            </ComboboxListVirtualized>
          ) : (
            <ComboboxList ref={setRefListRef} className="max-h-56">
              {filteredRefPickerItems.map((itemValue, index) => renderPickerItem(itemValue, index))}
            </ComboboxList>
          )}
          {refStatusText ? <ComboboxStatus>{refStatusText}</ComboboxStatus> : null}
        </ComboboxPopup>
      </Combobox>
    </div>
  );
}
