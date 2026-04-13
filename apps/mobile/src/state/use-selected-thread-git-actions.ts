import { useCallback, useEffect } from "react";

import { type GitActionRequestInput } from "@t3tools/client-runtime";
import {
  CommandId,
  type GitBranch,
  type GitRunStackedActionResult,
  ThreadId,
} from "@t3tools/contracts";
import {
  dedupeRemoteBranchesWithLocalMatches,
  sanitizeFeatureBranchName,
} from "@t3tools/shared/git";

import { uuidv4 } from "../lib/uuid";
import { type ScopedMobileProject, type ScopedMobileThread } from "../lib/scopedEntities";
import { useRemoteEnvironmentStore } from "./remote-environment-store";
import { getEnvironmentClient } from "./use-remote-environment-registry";
import { gitActionManager } from "./use-git-action-state";
import { gitBranchManager } from "./use-git-branches";
import { gitStatusManager } from "./use-git-status";
import { useThreadSelection } from "./use-thread-selection";

export function useSelectedThreadGitActions() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const setPendingConnectionError = useRemoteEnvironmentStore(
    (state) => state.setPendingConnectionError,
  );

  const selectedThreadGitRootCwd = selectedThreadProject?.workspaceRoot ?? null;

  const updateThreadGitContext = useCallback(
    async (
      thread: NonNullable<typeof selectedThread>,
      nextState: {
        readonly branch?: string | null;
        readonly worktreePath?: string | null;
      },
    ) => {
      const client = getEnvironmentClient(thread.environmentId);
      if (!client) {
        return;
      }

      await client.orchestration.dispatchCommand({
        type: "thread.meta.update",
        commandId: CommandId.make(uuidv4()),
        threadId: ThreadId.make(thread.id),
        ...(nextState.branch !== undefined ? { branch: nextState.branch } : {}),
        ...(nextState.worktreePath !== undefined ? { worktreePath: nextState.worktreePath } : {}),
      });
    },
    [],
  );

  const refreshSelectedThreadGitStatus = useCallback(
    async (options?: { readonly quiet?: boolean; readonly cwd?: string | null }) => {
      if (!selectedThread || !selectedThreadProject) {
        return null;
      }

      const cwd =
        options?.cwd ?? selectedThread.worktreePath ?? selectedThreadProject.workspaceRoot;
      if (!cwd) {
        return null;
      }

      try {
        const client = getEnvironmentClient(selectedThread.environmentId);
        if (!client) {
          return null;
        }

        const status = await gitActionManager.refreshStatus(
          { environmentId: selectedThread.environmentId, cwd },
          client.git,
          options,
        );
        setPendingConnectionError(null);
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to refresh git status.";
        setPendingConnectionError(message);
        return null;
      }
    },
    [selectedThread, selectedThreadProject, setPendingConnectionError],
  );

  useEffect(() => {
    if (!selectedThread || !selectedThreadProject) {
      return;
    }

    void refreshSelectedThreadGitStatus({ quiet: true });
  }, [refreshSelectedThreadGitStatus, selectedThread, selectedThreadProject]);

  const runSelectedThreadGitMutation = useCallback(
    async <T>(
      operation: (input: {
        readonly thread: ScopedMobileThread;
        readonly project: ScopedMobileProject;
        readonly cwd: string;
      }) => Promise<T>,
    ): Promise<T | null> => {
      if (!selectedThread || !selectedThreadProject) {
        return null;
      }

      const cwd = selectedThread.worktreePath ?? selectedThreadProject.workspaceRoot;
      if (!cwd) {
        return null;
      }

      try {
        setPendingConnectionError(null);
        return await operation({
          thread: selectedThread,
          project: selectedThreadProject,
          cwd,
        });
      } catch (error) {
        setPendingConnectionError(error instanceof Error ? error.message : "Git action failed.");
        return null;
      }
    },
    [selectedThread, selectedThreadProject, setPendingConnectionError],
  );

  const refreshSelectedThreadBranches = useCallback(async (): Promise<ReadonlyArray<GitBranch>> => {
    if (!selectedThread || !selectedThreadProject || !selectedThreadGitRootCwd) {
      return [];
    }

    const client = getEnvironmentClient(selectedThread.environmentId);
    if (!client) {
      return [];
    }

    try {
      const result = await gitBranchManager.load(
        { environmentId: selectedThread.environmentId, cwd: selectedThreadGitRootCwd, query: null },
        client.git,
        { limit: 100 },
      );
      return dedupeRemoteBranchesWithLocalMatches(result?.branches ?? []).filter(
        (branch) => !branch.isRemote,
      );
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to load branches.",
      );
      return [];
    }
  }, [selectedThread, selectedThreadGitRootCwd, selectedThreadProject, setPendingConnectionError]);

  const syncSelectedThreadBranchState = useCallback(
    async (input: {
      readonly thread: ScopedMobileThread;
      readonly cwd: string;
      readonly branchRootCwd?: string | null;
      readonly nextThreadState?: {
        readonly branch?: string | null;
        readonly worktreePath?: string | null;
      };
    }) => {
      if (input.nextThreadState) {
        await updateThreadGitContext(input.thread, input.nextThreadState);
      }

      const branchRootCwd = input.branchRootCwd ?? selectedThreadProject?.workspaceRoot ?? null;
      if (branchRootCwd) {
        gitBranchManager.invalidate({
          environmentId: input.thread.environmentId,
          cwd: branchRootCwd,
          query: null,
        });
        await refreshSelectedThreadBranches();
      }

      await refreshSelectedThreadGitStatus({ quiet: true, cwd: input.cwd });
    },
    [
      refreshSelectedThreadBranches,
      refreshSelectedThreadGitStatus,
      selectedThreadProject?.workspaceRoot,
      updateThreadGitContext,
    ],
  );

  const onCheckoutSelectedThreadBranch = useCallback(
    async (branch: string) => {
      await runSelectedThreadGitMutation(async ({ thread, cwd }) => {
        const result = await gitActionManager.checkout(
          { environmentId: thread.environmentId, cwd },
          { branch },
        );
        await syncSelectedThreadBranchState({
          thread,
          cwd,
          nextThreadState: {
            branch: result?.branch ?? thread.branch,
            worktreePath: thread.worktreePath,
          },
        });
      });
    },
    [runSelectedThreadGitMutation, syncSelectedThreadBranchState],
  );

  const onCreateSelectedThreadBranch = useCallback(
    async (branch: string) => {
      await runSelectedThreadGitMutation(async ({ thread, cwd }) => {
        const result = await gitActionManager.createBranch(
          { environmentId: thread.environmentId, cwd },
          {
            branch,
            checkout: true,
          },
        );
        await syncSelectedThreadBranchState({
          thread,
          cwd,
          nextThreadState: {
            branch: result?.branch ?? thread.branch,
            worktreePath: thread.worktreePath,
          },
        });
      });
    },
    [runSelectedThreadGitMutation, syncSelectedThreadBranchState],
  );

  const onCreateSelectedThreadWorktree = useCallback(
    async (nextWorktree: { readonly baseBranch: string; readonly newBranch: string }) => {
      await runSelectedThreadGitMutation(async ({ thread, project }) => {
        const result = await gitActionManager.createWorktree(
          { environmentId: thread.environmentId, cwd: project.workspaceRoot },
          {
            branch: nextWorktree.baseBranch,
            newBranch: sanitizeFeatureBranchName(nextWorktree.newBranch),
            path: null,
          },
        );
        if (!result) {
          return;
        }

        await syncSelectedThreadBranchState({
          thread,
          cwd: result.worktree.path,
          branchRootCwd: project.workspaceRoot,
          nextThreadState: {
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          },
        });
      });
    },
    [runSelectedThreadGitMutation, syncSelectedThreadBranchState],
  );

  const onPullSelectedThreadBranch = useCallback(async () => {
    await runSelectedThreadGitMutation(async ({ thread, cwd }) => {
      await gitActionManager.pull({ environmentId: thread.environmentId, cwd });
      await refreshSelectedThreadGitStatus({ quiet: true, cwd });
    });
  }, [refreshSelectedThreadGitStatus, runSelectedThreadGitMutation]);

  const onRunSelectedThreadGitAction = useCallback(
    async (input: GitActionRequestInput): Promise<GitRunStackedActionResult | null> => {
      return await runSelectedThreadGitMutation(async ({ thread, cwd }) => {
        const result = await gitActionManager.runStackedAction(
          { environmentId: thread.environmentId, cwd },
          {
            actionId: uuidv4(),
            action: input.action,
            ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
            ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
            ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
          },
          {
            gitStatus: gitStatusManager.getSnapshot({
              environmentId: thread.environmentId,
              cwd,
            }).data,
          },
        );
        if (!result) {
          return null;
        }

        if (result.branch.status === "created" && result.branch.name) {
          await syncSelectedThreadBranchState({
            thread,
            cwd,
            nextThreadState: {
              branch: result.branch.name,
              worktreePath: thread.worktreePath,
            },
          });
          return result;
        }

        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        return result;
      });
    },
    [refreshSelectedThreadGitStatus, runSelectedThreadGitMutation, syncSelectedThreadBranchState],
  );

  return {
    refreshSelectedThreadGitStatus,
    refreshSelectedThreadBranches,
    onCheckoutSelectedThreadBranch,
    onCreateSelectedThreadBranch,
    onCreateSelectedThreadWorktree,
    onPullSelectedThreadBranch,
    onRunSelectedThreadGitAction,
  };
}
