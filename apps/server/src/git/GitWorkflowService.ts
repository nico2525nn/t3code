import { Context, Effect, Layer } from "effect";

import {
  GitManagerError,
  GitCommandError,
  type GitCheckoutInput,
  type GitCheckoutResult,
  type GitCreateBranchInput,
  type GitCreateBranchResult,
  type GitCreateWorktreeInput,
  type GitCreateWorktreeResult,
  type GitListBranchesInput,
  type GitListBranchesResult,
  type GitManagerServiceError,
  type GitPreparePullRequestThreadInput,
  type GitPreparePullRequestThreadResult,
  type GitPullRequestRefInput,
  type GitPullResult,
  type GitRemoveWorktreeInput,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusInput,
  type GitStatusLocalResult,
  type GitStatusRemoteResult,
  type GitStatusResult,
} from "@t3tools/contracts";

import { GitManager, type GitRunStackedActionOptions } from "./Services/GitManager.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsDriverRegistry } from "../vcs/VcsDriverRegistry.ts";

export interface GitWorkflowServiceShape {
  readonly status: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusResult, GitManagerServiceError>;
  readonly localStatus: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusLocalResult, GitManagerServiceError>;
  readonly remoteStatus: (
    input: GitStatusInput,
  ) => Effect.Effect<GitStatusRemoteResult | null, GitManagerServiceError>;
  readonly invalidateLocalStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateRemoteStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly invalidateStatus: (cwd: string) => Effect.Effect<void, never>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<GitPullResult, GitCommandError>;
  readonly runStackedAction: (
    input: GitRunStackedActionInput,
    options?: GitRunStackedActionOptions,
  ) => Effect.Effect<GitRunStackedActionResult, GitManagerServiceError>;
  readonly resolvePullRequest: (
    input: GitPullRequestRefInput,
  ) => Effect.Effect<GitResolvePullRequestResult, GitManagerServiceError>;
  readonly preparePullRequestThread: (
    input: GitPreparePullRequestThreadInput,
  ) => Effect.Effect<GitPreparePullRequestThreadResult, GitManagerServiceError>;
  readonly listBranches: (
    input: GitListBranchesInput,
  ) => Effect.Effect<GitListBranchesResult, GitCommandError>;
  readonly createWorktree: (
    input: GitCreateWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, GitCommandError>;
  readonly removeWorktree: (input: GitRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly createBranch: (
    input: GitCreateBranchInput,
  ) => Effect.Effect<GitCreateBranchResult, GitCommandError>;
  readonly checkoutBranch: (
    input: GitCheckoutInput,
  ) => Effect.Effect<GitCheckoutResult, GitCommandError>;
  readonly initRepo: (input: { readonly cwd: string }) => Effect.Effect<void, GitCommandError>;
  readonly renameBranch: (input: {
    readonly cwd: string;
    readonly oldBranch: string;
    readonly newBranch: string;
  }) => Effect.Effect<GitCreateBranchResult, GitManagerServiceError>;
}

export class GitWorkflowService extends Context.Service<
  GitWorkflowService,
  GitWorkflowServiceShape
>()("t3/git/GitWorkflowService") {}

const unsupportedGitWorkflow = (operation: string, cwd: string, detail: string) =>
  new GitManagerError({
    operation,
    detail: `${detail} (${cwd})`,
  });

const unsupportedGitCommand = (operation: string, cwd: string, detail: string) =>
  new GitCommandError({
    operation,
    command: "vcs-route",
    cwd,
    detail,
  });

export const make = Effect.fn("makeGitWorkflowService")(function* () {
  const registry = yield* VcsDriverRegistry;
  const git = yield* GitVcsDriver;
  const gitManager = yield* GitManager;

  const ensureGit = Effect.fn("GitWorkflowService.ensureGit")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitWorkflow(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle.kind !== "git") {
      return yield* unsupportedGitWorkflow(
        operation,
        cwd,
        `The ${operation} workflow currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
  });

  const ensureGitCommand = Effect.fn("GitWorkflowService.ensureGitCommand")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* registry
      .resolve({ cwd })
      .pipe(
        Effect.mapError((error) =>
          unsupportedGitCommand(
            operation,
            cwd,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    if (handle.kind !== "git") {
      return yield* unsupportedGitCommand(
        operation,
        cwd,
        `The ${operation} command currently supports Git repositories only; detected ${handle.kind}.`,
      );
    }
  });

  const routeGitManager =
    <Input extends { readonly cwd: string }, Output>(
      operation: string,
      run: (input: Input) => Effect.Effect<Output, GitManagerServiceError>,
    ) =>
    (input: Input) =>
      ensureGit(operation, input.cwd).pipe(Effect.andThen(run(input)));

  return GitWorkflowService.of({
    status: routeGitManager("GitWorkflowService.status", gitManager.status),
    localStatus: routeGitManager("GitWorkflowService.localStatus", gitManager.localStatus),
    remoteStatus: routeGitManager("GitWorkflowService.remoteStatus", gitManager.remoteStatus),
    invalidateLocalStatus: gitManager.invalidateLocalStatus,
    invalidateRemoteStatus: gitManager.invalidateRemoteStatus,
    invalidateStatus: gitManager.invalidateStatus,
    pullCurrentBranch: (cwd) =>
      ensureGitCommand("GitWorkflowService.pullCurrentBranch", cwd).pipe(
        Effect.andThen(git.pullCurrentBranch(cwd)),
      ),
    runStackedAction: (input, options) =>
      ensureGit("GitWorkflowService.runStackedAction", input.cwd).pipe(
        Effect.andThen(gitManager.runStackedAction(input, options)),
      ),
    resolvePullRequest: routeGitManager(
      "GitWorkflowService.resolvePullRequest",
      gitManager.resolvePullRequest,
    ),
    preparePullRequestThread: routeGitManager(
      "GitWorkflowService.preparePullRequestThread",
      gitManager.preparePullRequestThread,
    ),
    listBranches: (input) =>
      ensureGitCommand("GitWorkflowService.listBranches", input.cwd).pipe(
        Effect.andThen(git.listBranches(input)),
      ),
    createWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.createWorktree", input.cwd).pipe(
        Effect.andThen(git.createWorktree(input)),
      ),
    removeWorktree: (input) =>
      ensureGitCommand("GitWorkflowService.removeWorktree", input.cwd).pipe(
        Effect.andThen(git.removeWorktree(input)),
      ),
    createBranch: (input) =>
      ensureGitCommand("GitWorkflowService.createBranch", input.cwd).pipe(
        Effect.andThen(git.createBranch(input)),
      ),
    checkoutBranch: (input) =>
      ensureGitCommand("GitWorkflowService.checkoutBranch", input.cwd).pipe(
        Effect.andThen(Effect.scoped(git.checkoutBranch(input))),
      ),
    initRepo: (input) => git.initRepo(input),
    renameBranch: (input) =>
      ensureGit("GitWorkflowService.renameBranch", input.cwd).pipe(
        Effect.andThen(git.renameBranch(input)),
      ),
  });
});

export const layer = Layer.effect(GitWorkflowService, make());
