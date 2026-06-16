import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { VcsActionOperation } from "@t3tools/client-runtime/state/vcs";
import type {
  EnvironmentId,
  GitActionProgressEvent,
  GitResolvePullRequestResult,
  GitRunStackedActionResult,
  GitStackedAction,
  SourceControlCloneProtocol,
  SourceControlPublishRepositoryResult,
  SourceControlRepositoryVisibility,
  ThreadId,
  VcsPullResult,
} from "@t3tools/contracts";
import { useCallback, useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { gitEnvironment } from "./git";
import { useEnvironmentQuery } from "./query";
import { sourceControlEnvironment } from "./sourceControl";
import { vcsActionManager, vcsEnvironment } from "./vcs";

export type SourceControlActionKind =
  | "init"
  | "pull"
  | "publishRepository"
  | "runStackedAction"
  | "preparePullRequestThread";

export interface SourceControlActionScope {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

interface SourceControlActionState<TArgs extends ReadonlyArray<unknown>, TResult> {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly run: (...args: TArgs) => Promise<TResult>;
  readonly resetError: () => void;
}

const pullRequestResolutionCache = new Map<string, GitResolvePullRequestResult>();

const ACTION_OPERATION = {
  init: "init",
  pull: "pull",
  publishRepository: "publish_repository",
  runStackedAction: "run_change_request",
  preparePullRequestThread: "prepare_pull_request_thread",
} as const satisfies Record<SourceControlActionKind, VcsActionOperation>;

function useAction<TArgs extends ReadonlyArray<unknown>, TResult>(input: {
  readonly kind: SourceControlActionKind;
  readonly label: string;
  readonly scope: SourceControlActionScope;
  readonly action: (...args: TArgs) => Promise<TResult>;
  readonly onSuccess?: () => void;
  readonly managedExternally?: boolean;
}): SourceControlActionState<TArgs, TResult> {
  const operation = ACTION_OPERATION[input.kind];
  const state = useAtomValue(vcsActionManager.stateAtom(input.scope));
  const ownsState = state.operation === operation;

  const resetError = useCallback(() => {
    vcsActionManager.resetError(appAtomRegistry, input.scope, operation);
  }, [input.scope, operation]);

  const run = useCallback(
    async (...args: TArgs): Promise<TResult> => {
      const execute = async () => {
        const result = await input.action(...args);
        input.onSuccess?.();
        return result;
      };
      return input.managedExternally === true
        ? execute()
        : vcsActionManager.track(
            appAtomRegistry,
            input.scope,
            {
              operation,
              label: input.label,
            },
            execute,
          );
    },
    [input.action, input.label, input.managedExternally, input.onSuccess, input.scope, operation],
  );

  return {
    error: ownsState ? state.error : null,
    isPending: ownsState && state.isRunning,
    resetError,
    run,
  };
}

function requireScope(scope: SourceControlActionScope, unavailableMessage: string) {
  if (scope.environmentId === null || scope.cwd === null) {
    throw new Error(unavailableMessage);
  }
  return {
    environmentId: scope.environmentId,
    cwd: scope.cwd,
  };
}

export function useSourceControlActionRunning(
  scope: SourceControlActionScope,
  kinds: ReadonlyArray<SourceControlActionKind>,
): boolean {
  const state = useAtomValue(vcsActionManager.stateAtom(scope));
  return (
    state.isRunning &&
    state.operation !== null &&
    kinds.some((kind) => ACTION_OPERATION[kind] === state.operation)
  );
}

export function useVcsInitAction(scope: SourceControlActionScope) {
  const init = useAtomSet(vcsEnvironment.init, { mode: "promise" });
  const action = useCallback(async () => {
    const target = requireScope(scope, "Git init is unavailable.");
    return init({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  }, [init, scope]);
  return useAction({ kind: "init", label: "Initializing repository", scope, action });
}

export function useVcsPullAction(scope: SourceControlActionScope) {
  const pull = useAtomSet(vcsEnvironment.pull, { mode: "promise" });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = useCallback(async (): Promise<VcsPullResult> => {
    const target = requireScope(scope, "Git pull is unavailable.");
    return pull({
      environmentId: target.environmentId,
      input: { cwd: target.cwd },
    });
  }, [pull, scope]);
  return useAction({
    kind: "pull",
    label: "Pulling latest changes",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function useGitStackedAction(scope: SourceControlActionScope) {
  const runStackedAction = useAtomSet(vcsActionManager.runStackedAction(scope), {
    mode: "promise",
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );

  const action = useCallback(
    async (input: {
      actionId: string;
      action: GitStackedAction;
      commitMessage?: string;
      featureBranch?: boolean;
      filePaths?: string[];
      onProgress?: (event: GitActionProgressEvent) => void;
    }): Promise<GitRunStackedActionResult> => {
      requireScope(scope, "Git action is unavailable.");
      return runStackedAction({
        actionId: input.actionId,
        action: input.action,
        ...(input.commitMessage ? { commitMessage: input.commitMessage } : {}),
        ...(input.featureBranch ? { featureBranch: true } : {}),
        ...(input.filePaths?.length ? { filePaths: input.filePaths } : {}),
        ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      });
    },
    [runStackedAction, scope],
  );

  return useAction({
    kind: "runStackedAction",
    label: "Running source control action",
    scope,
    action,
    onSuccess: status.refresh,
    managedExternally: true,
  });
}

export function useSourceControlPublishRepositoryAction(scope: SourceControlActionScope) {
  const publishRepository = useAtomSet(sourceControlEnvironment.publishRepository, {
    mode: "promise",
  });
  const status = useEnvironmentQuery(
    scope.environmentId !== null && scope.cwd !== null
      ? vcsEnvironment.status({
          environmentId: scope.environmentId,
          input: { cwd: scope.cwd },
        })
      : null,
  );
  const action = useCallback(
    async (input: {
      provider: "github" | "gitlab" | "bitbucket" | "azure-devops";
      repository: string;
      visibility: SourceControlRepositoryVisibility;
      remoteName: string;
      protocol: SourceControlCloneProtocol;
    }): Promise<SourceControlPublishRepositoryResult> => {
      const target = requireScope(scope, "Repository publishing is unavailable.");
      return publishRepository({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          ...input,
        },
      });
    },
    [publishRepository, scope],
  );
  return useAction({
    kind: "publishRepository",
    label: "Publishing repository",
    scope,
    action,
    onSuccess: status.refresh,
  });
}

export function usePreparePullRequestThreadAction(scope: SourceControlActionScope) {
  const preparePullRequestThread = useAtomSet(gitEnvironment.preparePullRequestThread, {
    mode: "promise",
  });
  const action = useCallback(
    async (input: { reference: string; mode: "local" | "worktree"; threadId?: ThreadId }) => {
      const target = requireScope(scope, "Pull request thread preparation is unavailable.");
      return preparePullRequestThread({
        environmentId: target.environmentId,
        input: {
          cwd: target.cwd,
          reference: input.reference,
          mode: input.mode,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        },
      });
    },
    [preparePullRequestThread, scope],
  );
  return useAction({
    kind: "preparePullRequestThread",
    label: "Preparing pull request thread",
    scope,
    action,
  });
}

export interface PullRequestResolutionTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly reference: string | null;
}

function pullRequestResolutionKey(target: PullRequestResolutionTarget): string | null {
  if (target.environmentId === null || target.cwd === null || target.reference === null) {
    return null;
  }
  return `${target.environmentId}:${target.cwd}:${target.reference}`;
}

export function readCachedPullRequestResolution(
  target: PullRequestResolutionTarget,
): GitResolvePullRequestResult | null {
  const key = pullRequestResolutionKey(target);
  return key === null ? null : (pullRequestResolutionCache.get(key) ?? null);
}

export function usePullRequestResolutionState(target: PullRequestResolutionTarget) {
  const query = useEnvironmentQuery(
    target.environmentId !== null && target.cwd !== null && target.reference !== null
      ? gitEnvironment.pullRequestResolution({
          environmentId: target.environmentId,
          input: {
            cwd: target.cwd,
            reference: target.reference,
          },
        })
      : null,
  );
  const key = pullRequestResolutionKey(target);

  useEffect(() => {
    if (key !== null && query.data !== null) {
      pullRequestResolutionCache.set(key, query.data);
    }
  }, [key, query.data]);

  return {
    data: query.data ?? readCachedPullRequestResolution(target),
    error: query.error,
    isPending: query.isPending && readCachedPullRequestResolution(target) === null,
    isFetching: query.isPending,
    refresh: query.refresh,
  };
}
