import { useCallback } from "react";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  MessageId,
  ThreadId,
  type GitBranch,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import { sanitizeFeatureBranchName } from "@t3tools/shared/git";

import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { uuidv4 } from "../lib/uuid";
import type { ScopedMobileProject } from "../lib/scopedEntities";
import { buildTemporaryWorktreeBranchName } from "../lib/worktrees";
import { deriveThreadTitleFromPrompt } from "./remote-runtime-types";
import { useRemoteEnvironmentStore } from "./remote-environment-store";
import { gitBranchManager } from "./use-git-branches";
import { useRemoteCatalog } from "./use-remote-catalog";
import { getEnvironmentClient, useRemoteEnvironmentState } from "./use-remote-environment-registry";
import { useThreadSelectionStore } from "./thread-selection-store";

function useRefreshRemoteData() {
  const { savedConnectionsById } = useRemoteEnvironmentState();
  const patchEnvironmentRuntimeState = useRemoteEnvironmentStore(
    (state) => state.patchEnvironmentRuntimeState,
  );

  return useCallback(
    async (environmentIds?: ReadonlyArray<string>) => {
      const targets = environmentIds ?? Object.keys(savedConnectionsById);

      await Promise.all(
        targets.map(async (environmentId) => {
          const client = getEnvironmentClient(environmentId);
          if (!client) {
            return;
          }

          try {
            const serverConfig = await client.server.getConfig();
            patchEnvironmentRuntimeState(environmentId, (current) => ({
              ...current,
              serverConfig,
              connectionError: null,
            }));
          } catch (error) {
            patchEnvironmentRuntimeState(environmentId, (current) => ({
              ...current,
              connectionError:
                error instanceof Error ? error.message : "Failed to refresh remote data.",
            }));
          }
        }),
      );
    },
    [patchEnvironmentRuntimeState, savedConnectionsById],
  );
}

export function useProjectActions() {
  const { threads } = useRemoteCatalog();
  const refreshRemoteData = useRefreshRemoteData();
  const setPendingConnectionError = useRemoteEnvironmentStore(
    (state) => state.setPendingConnectionError,
  );
  const selectThreadRef = useThreadSelectionStore((state) => state.selectThreadRef);

  const onCreateThreadWithOptions = useCallback(
    async (input: {
      readonly project: ScopedMobileProject;
      readonly modelSelection: ModelSelection;
      readonly envMode: "local" | "worktree";
      readonly branch: string | null;
      readonly worktreePath: string | null;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
      readonly initialMessageText: string;
      readonly initialAttachments: ReadonlyArray<DraftComposerImageAttachment>;
    }) => {
      const client = getEnvironmentClient(input.project.environmentId);
      if (!client) {
        return null;
      }

      const threadId = ThreadId.make(uuidv4());
      const createdAt = new Date().toISOString();
      const initialMessageText = input.initialMessageText.trim();
      const nextTitle = deriveThreadTitleFromPrompt(input.initialMessageText);

      if (input.envMode === "worktree") {
        if (!input.branch || initialMessageText.length === 0) {
          return null;
        }

        await client.orchestration.dispatchCommand({
          type: "thread.turn.start",
          commandId: CommandId.make(uuidv4()),
          threadId,
          message: {
            messageId: MessageId.make(uuidv4()),
            role: "user",
            text: initialMessageText,
            attachments: input.initialAttachments,
          },
          modelSelection: input.modelSelection,
          titleSeed: nextTitle,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          bootstrap: {
            createThread: {
              projectId: input.project.id,
              title: nextTitle,
              modelSelection: input.modelSelection,
              runtimeMode: input.runtimeMode,
              interactionMode: input.interactionMode,
              branch: input.branch,
              worktreePath: null,
              createdAt,
            },
            prepareWorktree: {
              projectCwd: input.project.workspaceRoot,
              baseBranch: input.branch,
              branch: buildTemporaryWorktreeBranchName(),
            },
            runSetupScript: true,
          },
          createdAt: new Date().toISOString(),
        });
      } else {
        await client.orchestration.dispatchCommand({
          type: "thread.create",
          commandId: CommandId.make(uuidv4()),
          threadId,
          projectId: input.project.id,
          title: nextTitle,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          branch: input.branch,
          worktreePath: input.worktreePath,
          createdAt,
        });

        if (initialMessageText.length > 0 || input.initialAttachments.length > 0) {
          await client.orchestration.dispatchCommand({
            type: "thread.turn.start",
            commandId: CommandId.make(uuidv4()),
            threadId,
            message: {
              messageId: MessageId.make(uuidv4()),
              role: "user",
              text: initialMessageText,
              attachments: input.initialAttachments,
            },
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            createdAt: new Date().toISOString(),
          });
        }
      }

      selectThreadRef({
        environmentId: input.project.environmentId,
        threadId,
      });
      await refreshRemoteData([input.project.environmentId]);
      return {
        environmentId: input.project.environmentId,
        threadId,
      };
    },
    [refreshRemoteData, selectThreadRef],
  );

  const onCreateThread = useCallback(
    async (project: ScopedMobileProject) => {
      const latestProjectThread =
        threads.find(
          (thread) =>
            thread.environmentId === project.environmentId && thread.projectId === project.id,
        ) ?? null;
      const modelSelection =
        project.defaultModelSelection ?? latestProjectThread?.modelSelection ?? null;
      if (!modelSelection) {
        setPendingConnectionError("This project does not have a default model configured yet.");
        return null;
      }

      return await onCreateThreadWithOptions({
        project,
        modelSelection,
        envMode: "local",
        branch: null,
        worktreePath: null,
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        initialMessageText: "",
        initialAttachments: [],
      });
    },
    [onCreateThreadWithOptions, setPendingConnectionError, threads],
  );

  const onListProjectBranches = useCallback(
    async (project: ScopedMobileProject): Promise<ReadonlyArray<GitBranch>> => {
      const client = getEnvironmentClient(project.environmentId);
      if (!client) {
        return [];
      }

      try {
        const result = await gitBranchManager.load(
          { environmentId: project.environmentId, cwd: project.workspaceRoot, query: null },
          client.git,
          { limit: 100 },
        );
        return (result?.branches ?? []).filter((branch) => !branch.isRemote);
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
        gitBranchManager.invalidate({
          environmentId: project.environmentId,
          cwd: project.workspaceRoot,
          query: null,
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

  return {
    onCreateThread,
    onCreateThreadWithOptions,
    onListProjectBranches,
    onCreateProjectWorktree,
    onRefreshProjects: refreshRemoteData,
  };
}
