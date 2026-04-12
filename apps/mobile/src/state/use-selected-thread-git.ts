import { useCallback, useEffect } from "react";

import {
  buildGitActionProgressStages,
  type GitActionRequestInput,
  type WsRpcClient,
} from "@t3tools/client-runtime";
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

import { newClientId } from "../lib/clientId";
import {
  scopedThreadKey,
  type ScopedMobileProject,
  type ScopedMobileThread,
} from "../lib/scopedEntities";
import { useRemoteEnvironmentStore } from "./remote-environment-store";
import { useThreadSelection } from "./use-thread-selection";
import { getEnvironmentClient } from "./use-remote-environment-registry";
import { useThreadGitStore } from "./thread-git-store";

export function useSelectedThreadGit() {
  const { selectedThread, selectedThreadProject } = useThreadSelection();
  const setPendingConnectionError = useRemoteEnvironmentStore(
    (state) => state.setPendingConnectionError,
  );

  const selectedThreadGitRootCwd = selectedThreadProject?.workspaceRoot ?? null;
  const selectedThreadKey = selectedThread
    ? scopedThreadKey(selectedThread.environmentId, selectedThread.id)
    : null;
  const selectedThreadGitStatus = useThreadGitStore((state) =>
    selectedThreadKey ? (state.gitStatusByThreadKey[selectedThreadKey] ?? null) : null,
  );
  const gitOperationLabel = useThreadGitStore((state) =>
    selectedThreadKey ? (state.gitOperationLabelByThreadKey[selectedThreadKey] ?? null) : null,
  );
  const setThreadGitStatus = useThreadGitStore((state) => state.setThreadGitStatus);
  const setThreadGitOperationLabel = useThreadGitStore((state) => state.setThreadGitOperationLabel);
  const clearThreadGitState = useThreadGitStore((state) => state.clearThreadGitState);

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
        commandId: CommandId.makeUnsafe(newClientId("command")),
        threadId: ThreadId.makeUnsafe(thread.id),
        ...(nextState.branch !== undefined ? { branch: nextState.branch } : {}),
        ...(nextState.worktreePath !== undefined ? { worktreePath: nextState.worktreePath } : {}),
      });
    },
    [],
  );

  const refreshSelectedThreadGitStatus = useCallback(
    async (options?: { readonly quiet?: boolean; readonly cwd?: string | null }) => {
      if (!selectedThread || !selectedThreadProject) {
        if (selectedThreadKey) {
          clearThreadGitState(selectedThreadKey);
        }
        return null;
      }

      const cwd =
        options?.cwd ?? selectedThread.worktreePath ?? selectedThreadProject.workspaceRoot;
      if (!cwd) {
        if (selectedThreadKey) {
          clearThreadGitState(selectedThreadKey);
        }
        return null;
      }

      if (!options?.quiet && selectedThreadKey) {
        setThreadGitOperationLabel(selectedThreadKey, "Refreshing git status");
      }

      try {
        const client = getEnvironmentClient(selectedThread.environmentId);
        if (!client) {
          return null;
        }

        const status = await client.git.refreshStatus({ cwd });
        if (selectedThreadKey) {
          setThreadGitStatus(selectedThreadKey, status);
        }
        setPendingConnectionError(null);
        return status;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to refresh git status.";
        setPendingConnectionError(message);
        return null;
      } finally {
        if (!options?.quiet && selectedThreadKey) {
          setThreadGitOperationLabel(selectedThreadKey, null);
        }
      }
    },
    [
      clearThreadGitState,
      selectedThreadKey,
      selectedThread,
      selectedThreadProject,
      setPendingConnectionError,
      setThreadGitOperationLabel,
      setThreadGitStatus,
    ],
  );

  useEffect(() => {
    if (!selectedThread || !selectedThreadProject) {
      if (selectedThreadKey) {
        clearThreadGitState(selectedThreadKey);
      }
      return;
    }

    void refreshSelectedThreadGitStatus({ quiet: true });
  }, [
    clearThreadGitState,
    refreshSelectedThreadGitStatus,
    selectedThreadKey,
    selectedThread,
    selectedThreadProject,
  ]);

  const runSelectedThreadGitMutation = useCallback(
    async <T>(
      label: string,
      operation: (input: {
        readonly client: WsRpcClient;
        readonly thread: ScopedMobileThread;
        readonly project: ScopedMobileProject;
      }) => Promise<T>,
    ): Promise<T | null> => {
      if (!selectedThread || !selectedThreadProject) {
        return null;
      }

      const client = getEnvironmentClient(selectedThread.environmentId);
      if (!client) {
        return null;
      }

      if (selectedThreadKey) {
        setThreadGitOperationLabel(selectedThreadKey, label);
      }
      try {
        setPendingConnectionError(null);
        return await operation({
          client,
          thread: selectedThread,
          project: selectedThreadProject,
        });
      } catch (error) {
        setPendingConnectionError(error instanceof Error ? error.message : "Git action failed.");
        return null;
      } finally {
        if (selectedThreadKey) {
          setThreadGitOperationLabel(selectedThreadKey, null);
        }
      }
    },
    [
      selectedThreadKey,
      selectedThread,
      selectedThreadProject,
      setPendingConnectionError,
      setThreadGitOperationLabel,
    ],
  );

  const onListSelectedThreadBranches = useCallback(async (): Promise<ReadonlyArray<GitBranch>> => {
    if (!selectedThread || !selectedThreadProject || !selectedThreadGitRootCwd) {
      return [];
    }

    const client = getEnvironmentClient(selectedThread.environmentId);
    if (!client) {
      return [];
    }

    try {
      const result = await client.git.listBranches({
        cwd: selectedThreadGitRootCwd,
        limit: 100,
      });
      return dedupeRemoteBranchesWithLocalMatches(result.branches).filter(
        (branch) => !branch.isRemote,
      );
    } catch (error) {
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to load branches.",
      );
      return [];
    }
  }, [selectedThread, selectedThreadGitRootCwd, selectedThreadProject, setPendingConnectionError]);

  const onListProjectBranches = useCallback(
    async (project: ScopedMobileProject): Promise<ReadonlyArray<GitBranch>> => {
      const client = getEnvironmentClient(project.environmentId);
      if (!client) {
        return [];
      }

      try {
        const result = await client.git.listBranches({
          cwd: project.workspaceRoot,
          limit: 100,
        });
        return dedupeRemoteBranchesWithLocalMatches(result.branches).filter(
          (branch) => !branch.isRemote,
        );
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to load branches.",
        );
        return [];
      }
    },
    [setPendingConnectionError],
  );

  const onCreateProjectWorktree = useCallback(
    async (
      project: ScopedMobileProject,
      nextWorktree: {
        readonly baseBranch: string;
        readonly newBranch: string;
      },
    ): Promise<{
      readonly branch: string;
      readonly worktreePath: string;
    } | null> => {
      const client = getEnvironmentClient(project.environmentId);
      if (!client) {
        return null;
      }

      try {
        const result = await client.git.createWorktree({
          cwd: project.workspaceRoot,
          branch: nextWorktree.baseBranch,
          newBranch: sanitizeFeatureBranchName(nextWorktree.newBranch),
          path: null,
        });
        return {
          branch: result.worktree.branch,
          worktreePath: result.worktree.path,
        };
      } catch (error) {
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to create worktree.",
        );
        return null;
      }
    },
    [setPendingConnectionError],
  );

  const onCheckoutSelectedThreadBranch = useCallback(
    async (branch: string) => {
      await runSelectedThreadGitMutation(
        "Checking out branch",
        async ({ client, thread, project }) => {
          const cwd = thread.worktreePath ?? project.workspaceRoot;
          const result = await client.git.checkout({ cwd, branch });
          await updateThreadGitContext(thread, {
            branch: result.branch,
            worktreePath: thread.worktreePath,
          });
          await refreshSelectedThreadGitStatus({ quiet: true, cwd });
        },
      );
    },
    [refreshSelectedThreadGitStatus, runSelectedThreadGitMutation, updateThreadGitContext],
  );

  const onCreateSelectedThreadBranch = useCallback(
    async (branch: string) => {
      await runSelectedThreadGitMutation("Creating branch", async ({ client, thread, project }) => {
        const cwd = thread.worktreePath ?? project.workspaceRoot;
        const result = await client.git.createBranch({
          cwd,
          branch,
          checkout: true,
        });
        await updateThreadGitContext(thread, {
          branch: result.branch,
          worktreePath: thread.worktreePath,
        });
        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
      });
    },
    [refreshSelectedThreadGitStatus, runSelectedThreadGitMutation, updateThreadGitContext],
  );

  const onCreateSelectedThreadWorktree = useCallback(
    async (nextWorktree: { readonly baseBranch: string; readonly newBranch: string }) => {
      await runSelectedThreadGitMutation(
        "Creating worktree",
        async ({ client, thread, project }) => {
          const result = await client.git.createWorktree({
            cwd: project.workspaceRoot,
            branch: nextWorktree.baseBranch,
            newBranch: sanitizeFeatureBranchName(nextWorktree.newBranch),
            path: null,
          });
          await updateThreadGitContext(thread, {
            branch: result.worktree.branch,
            worktreePath: result.worktree.path,
          });
          await refreshSelectedThreadGitStatus({ quiet: true, cwd: result.worktree.path });
        },
      );
    },
    [refreshSelectedThreadGitStatus, runSelectedThreadGitMutation, updateThreadGitContext],
  );

  const onPullSelectedThreadBranch = useCallback(async () => {
    await runSelectedThreadGitMutation(
      "Pulling latest changes",
      async ({ client, thread, project }) => {
        const cwd = thread.worktreePath ?? project.workspaceRoot;
        await client.git.pull({ cwd });
        await refreshSelectedThreadGitStatus({ quiet: true, cwd });
      },
    );
  }, [refreshSelectedThreadGitStatus, runSelectedThreadGitMutation]);

  const onRunSelectedThreadGitAction = useCallback(
    async (input: GitActionRequestInput): Promise<GitRunStackedActionResult | null> => {
      const [firstStage] = buildGitActionProgressStages({
        action: input.action,
        hasCustomCommitMessage: Boolean(input.commitMessage?.trim()),
        hasWorkingTreeChanges: selectedThreadGitStatus?.hasWorkingTreeChanges ?? false,
        featureBranch: input.featureBranch ?? false,
        shouldPushBeforePr:
          input.action === "create_pr" &&
          ((selectedThreadGitStatus?.aheadCount ?? 0) > 0 ||
            !(selectedThreadGitStatus?.hasUpstream ?? false)),
      });

      return await runSelectedThreadGitMutation(
        firstStage ?? "Running git action",
        async ({ client, thread, project }) => {
          const cwd = thread.worktreePath ?? project.workspaceRoot;
          const result = await client.git.runStackedAction({
            actionId: newClientId("git-action"),
            cwd,
            action: input.action,
            ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
            ...(input.featureBranch ? { featureBranch: input.featureBranch } : {}),
            ...(input.filePaths?.length ? { filePaths: [...input.filePaths] } : {}),
          });

          if (result.branch.status === "created" && result.branch.name) {
            await updateThreadGitContext(thread, {
              branch: result.branch.name,
              worktreePath: thread.worktreePath,
            });
          }

          await refreshSelectedThreadGitStatus({ quiet: true, cwd });
          return result;
        },
      );
    },
    [
      refreshSelectedThreadGitStatus,
      runSelectedThreadGitMutation,
      selectedThreadGitStatus,
      updateThreadGitContext,
    ],
  );

  return {
    selectedThreadGitStatus,
    gitOperationLabel,
    refreshSelectedThreadGitStatus,
    onListProjectBranches,
    onCreateProjectWorktree,
    onListSelectedThreadBranches,
    onCheckoutSelectedThreadBranch,
    onCreateSelectedThreadBranch,
    onCreateSelectedThreadWorktree,
    onPullSelectedThreadBranch,
    onRunSelectedThreadGitAction,
  };
}
