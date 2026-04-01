import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Cause, Option } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";
import { parsePullRequestReference } from "~/pullRequestReference";
import { gitResolvePullRequestAtom, gitPreparePullRequestThreadMutationAtom } from "~/rpc/gitAtoms";
import { REACTIVITY_KEYS } from "~/rpc/client";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

interface PullRequestThreadDialogProps {
  open: boolean;
  cwd: string | null;
  initialReference: string | null;
  onOpenChange: (open: boolean) => void;
  onPrepared: (input: { branch: string; worktreePath: string | null }) => Promise<void> | void;
}

function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

export function PullRequestThreadDialog({
  open,
  cwd,
  initialReference,
  onOpenChange,
  onPrepared,
}: PullRequestThreadDialogProps) {
  const referenceInputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState(initialReference ?? "");
  const [referenceDirty, setReferenceDirty] = useState(false);
  const [preparingMode, setPreparingMode] = useState<"local" | "worktree" | null>(null);
  const [prepareFollowupErrorMessage, setPrepareFollowupErrorMessage] = useState<string | null>(
    null,
  );
  const [debouncedReference, referenceDebouncer] = useDebouncedValue(
    reference,
    { wait: 450 },
    (debouncerState) => ({ isPending: debouncerState.isPending }),
  );
  const resetPreparePullRequestThread = useAtomSet(gitPreparePullRequestThreadMutationAtom);

  useEffect(() => {
    if (!open) return;
    setReference(initialReference ?? "");
    setReferenceDirty(false);
    setPreparingMode(null);
    setPrepareFollowupErrorMessage(null);
    resetPreparePullRequestThread(Atom.Reset);
  }, [initialReference, open, resetPreparePullRequestThread]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      referenceInputRef.current?.focus();
      referenceInputRef.current?.select();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [open]);

  const parsedReference = parsePullRequestReference(reference);
  const parsedDebouncedReference = parsePullRequestReference(debouncedReference);
  const resolvePullRequestResult = useAtomValue(
    gitResolvePullRequestAtom({
      cwd: open ? cwd : null,
      reference: open ? parsedDebouncedReference : null,
    }),
  );
  const preparePullRequestThread = useAtomSet(gitPreparePullRequestThreadMutationAtom, {
    mode: "promise",
  });
  const preparePullRequestThreadResult = useAtomValue(gitPreparePullRequestThreadMutationAtom);
  const resolvePullRequestData = Option.getOrUndefined(AsyncResult.value(resolvePullRequestResult));
  const resolvePullRequestError = Option.getOrNull(
    Option.map(AsyncResult.cause(resolvePullRequestResult), (cause) => Cause.squash(cause)),
  );
  const isPreparingPullRequestThread = preparingMode !== null;

  const liveResolvedPullRequest =
    parsedReference !== null && parsedReference === parsedDebouncedReference
      ? (resolvePullRequestData?.pullRequest ?? null)
      : null;
  const resolvedPullRequest = liveResolvedPullRequest;
  const isResolving =
    open &&
    parsedReference !== null &&
    resolvedPullRequest === null &&
    (referenceDebouncer.state.isPending ||
      parsedReference !== parsedDebouncedReference ||
      AsyncResult.isInitial(resolvePullRequestResult) ||
      resolvePullRequestResult.waiting);
  const statusTone = useMemo(() => {
    switch (resolvedPullRequest?.state) {
      case "merged":
        return "text-violet-600 dark:text-violet-300/90";
      case "closed":
        return "text-zinc-500 dark:text-zinc-400/80";
      case "open":
        return "text-emerald-600 dark:text-emerald-300/90";
      default:
        return "text-muted-foreground";
    }
  }, [resolvedPullRequest?.state]);
  const preparePullRequestThreadErrorMessage = AsyncResult.match(preparePullRequestThreadResult, {
    onInitial: () => null,
    onSuccess: () => null,
    onFailure: (error) => Cause.pretty(error.cause),
  });

  const handleConfirm = useCallback(
    async (mode: "local" | "worktree") => {
      if (!parsedReference) {
        setReferenceDirty(true);
        return;
      }
      if (!parsedReference || !resolvedPullRequest || !cwd) {
        return;
      }
      setPrepareFollowupErrorMessage(null);
      setPreparingMode(mode);
      try {
        const result = await preparePullRequestThread({
          payload: {
            cwd,
            reference: parsedReference,
            mode,
          },
          reactivityKeys: [REACTIVITY_KEYS.git(cwd)],
        });

        try {
          await onPrepared({
            branch: result.branch,
            worktreePath: result.worktreePath,
          });
          onOpenChange(false);
        } catch (error) {
          setPrepareFollowupErrorMessage(
            toErrorMessage(error, "Failed to prepare pull request thread."),
          );
        }
      } catch {
        return;
      } finally {
        setPreparingMode(null);
      }
    },
    [cwd, onOpenChange, onPrepared, parsedReference, preparePullRequestThread, resolvedPullRequest],
  );

  const validationMessage = !referenceDirty
    ? null
    : reference.trim().length === 0
      ? "Paste a GitHub pull request URL, `gh pr checkout 123`, or enter 123 / #123."
      : parsedReference === null
        ? "Use a GitHub pull request URL, `gh pr checkout 123`, 123, or #123."
        : null;
  const errorMessage =
    validationMessage ??
    (resolvedPullRequest === null && AsyncResult.isFailure(resolvePullRequestResult)
      ? resolvePullRequestError instanceof Error
        ? resolvePullRequestError.message
        : "Failed to resolve pull request."
      : (prepareFollowupErrorMessage ?? preparePullRequestThreadErrorMessage));

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!isPreparingPullRequestThread) {
          onOpenChange(nextOpen);
        }
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Checkout Pull Request</DialogTitle>
          <DialogDescription>
            Resolve a GitHub pull request, then create the draft thread in the main repo or in a
            dedicated worktree.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Pull request</span>
            <Input
              ref={referenceInputRef}
              placeholder="https://github.com/owner/repo/pull/42, gh pr checkout 42, or #42"
              value={reference}
              onChange={(event) => {
                setReferenceDirty(true);
                setReference(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter") {
                  return;
                }
                event.preventDefault();
                if (!isResolving && !isPreparingPullRequestThread) {
                  void handleConfirm("local");
                }
              }}
            />
          </label>

          {resolvedPullRequest ? (
            <div className="rounded-xl border border-border/70 bg-muted/24 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate font-medium text-sm">{resolvedPullRequest.title}</p>
                  <p className="truncate text-muted-foreground text-xs">
                    #{resolvedPullRequest.number} · {resolvedPullRequest.headBranch} to{" "}
                    {resolvedPullRequest.baseBranch}
                  </p>
                </div>
                <span className={cn("shrink-0 text-xs capitalize", statusTone)}>
                  {resolvedPullRequest.state}
                </span>
              </div>
            </div>
          ) : null}

          {isResolving ? (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Spinner className="size-3.5" />
              Resolving pull request...
            </div>
          ) : null}

          {errorMessage ? <p className="text-destructive text-xs">{errorMessage}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isPreparingPullRequestThread}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void handleConfirm("local");
            }}
            disabled={!cwd || !resolvedPullRequest || isResolving || isPreparingPullRequestThread}
          >
            {preparingMode === "local" ? "Preparing local..." : "Local"}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => {
              void handleConfirm("worktree");
            }}
            disabled={!cwd || !resolvedPullRequest || isResolving || isPreparingPullRequestThread}
          >
            {preparingMode === "worktree" ? "Preparing worktree..." : "Worktree"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
