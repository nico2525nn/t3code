import { Context, DateTime, Effect, Layer, Option } from "effect";

import {
  GitCommandError,
  VcsProcessExitError,
  type GitCheckoutInput,
  type GitCheckoutResult,
  type GitCreateBranchInput,
  type GitCreateBranchResult,
  type GitCreateWorktreeInput,
  type GitCreateWorktreeResult,
  type GitInitInput,
  type GitListBranchesInput,
  type GitListBranchesResult,
  type GitPullResult,
  type GitRemoveWorktreeInput,
  type GitStatusInput,
  type GitStatusResult,
} from "@t3tools/contracts";
import { makeGitVcsDriverCore } from "./GitVcsDriverCore.ts";
import { VcsDriver, type VcsDriverShape } from "./VcsDriver.ts";
import { VcsProcess, type VcsProcessShape } from "./VcsProcess.ts";

export interface ExecuteGitInput {
  readonly operation: string;
  readonly cwd: string;
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
  readonly progress?: ExecuteGitProgress;
}

export interface ExecuteGitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface GitStatusDetails extends Omit<GitStatusResult, "pr"> {
  upstreamRef: string | null;
}

export interface GitPreparedCommitContext {
  stagedSummary: string;
  stagedPatch: string;
}

export interface ExecuteGitProgress {
  readonly onStdoutLine?: (line: string) => Effect.Effect<void, never>;
  readonly onStderrLine?: (line: string) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitProgress {
  readonly onOutputLine?: (input: {
    stream: "stdout" | "stderr";
    text: string;
  }) => Effect.Effect<void, never>;
  readonly onHookStarted?: (hookName: string) => Effect.Effect<void, never>;
  readonly onHookFinished?: (input: {
    hookName: string;
    exitCode: number | null;
    durationMs: number | null;
  }) => Effect.Effect<void, never>;
}

export interface GitCommitOptions {
  readonly timeoutMs?: number;
  readonly progress?: GitCommitProgress;
}

export interface GitPushResult {
  status: "pushed" | "skipped_up_to_date";
  branch: string;
  upstreamBranch?: string | undefined;
  setUpstream?: boolean | undefined;
}

export interface GitRangeContext {
  commitSummary: string;
  diffSummary: string;
  diffPatch: string;
}

export interface GitRenameBranchInput {
  cwd: string;
  oldBranch: string;
  newBranch: string;
}

export interface GitRenameBranchResult {
  branch: string;
}

export interface GitFetchPullRequestBranchInput {
  cwd: string;
  prNumber: number;
  branch: string;
}

export interface GitEnsureRemoteInput {
  cwd: string;
  preferredName: string;
  url: string;
}

export interface GitFetchRemoteBranchInput {
  cwd: string;
  remoteName: string;
  remoteBranch: string;
  localBranch: string;
}

export interface GitSetBranchUpstreamInput {
  cwd: string;
  branch: string;
  remoteName: string;
  remoteBranch: string;
}

export interface GitVcsDriverShape {
  readonly execute: (input: ExecuteGitInput) => Effect.Effect<ExecuteGitResult, GitCommandError>;
  readonly status: (input: GitStatusInput) => Effect.Effect<GitStatusResult, GitCommandError>;
  readonly statusDetails: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly statusDetailsLocal: (cwd: string) => Effect.Effect<GitStatusDetails, GitCommandError>;
  readonly prepareCommitContext: (
    cwd: string,
    filePaths?: readonly string[],
  ) => Effect.Effect<GitPreparedCommitContext | null, GitCommandError>;
  readonly commit: (
    cwd: string,
    subject: string,
    body: string,
    options?: GitCommitOptions,
  ) => Effect.Effect<{ commitSha: string }, GitCommandError>;
  readonly pushCurrentBranch: (
    cwd: string,
    fallbackBranch: string | null,
  ) => Effect.Effect<GitPushResult, GitCommandError>;
  readonly readRangeContext: (
    cwd: string,
    baseBranch: string,
  ) => Effect.Effect<GitRangeContext, GitCommandError>;
  readonly readConfigValue: (
    cwd: string,
    key: string,
  ) => Effect.Effect<string | null, GitCommandError>;
  readonly listBranches: (
    input: GitListBranchesInput,
  ) => Effect.Effect<GitListBranchesResult, GitCommandError>;
  readonly pullCurrentBranch: (cwd: string) => Effect.Effect<GitPullResult, GitCommandError>;
  readonly createWorktree: (
    input: GitCreateWorktreeInput,
  ) => Effect.Effect<GitCreateWorktreeResult, GitCommandError>;
  readonly fetchPullRequestBranch: (
    input: GitFetchPullRequestBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly ensureRemote: (input: GitEnsureRemoteInput) => Effect.Effect<string, GitCommandError>;
  readonly fetchRemoteBranch: (
    input: GitFetchRemoteBranchInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly setBranchUpstream: (
    input: GitSetBranchUpstreamInput,
  ) => Effect.Effect<void, GitCommandError>;
  readonly removeWorktree: (input: GitRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
  readonly renameBranch: (
    input: GitRenameBranchInput,
  ) => Effect.Effect<GitRenameBranchResult, GitCommandError>;
  readonly createBranch: (
    input: GitCreateBranchInput,
  ) => Effect.Effect<GitCreateBranchResult, GitCommandError>;
  readonly checkoutBranch: (
    input: GitCheckoutInput,
  ) => Effect.Effect<GitCheckoutResult, GitCommandError>;
  readonly initRepo: (input: GitInitInput) => Effect.Effect<void, GitCommandError>;
  readonly listLocalBranchNames: (cwd: string) => Effect.Effect<string[], GitCommandError>;
}

export class GitVcsDriver extends Context.Service<GitVcsDriver, GitVcsDriverShape>()(
  "t3/vcs/GitVcsDriver",
) {}

const WORKSPACE_FILES_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const GIT_CHECK_IGNORE_MAX_STDIN_BYTES = 256 * 1024;
const WORKSPACE_GIT_HARDENED_CONFIG_ARGS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
] as const;

const nowFreshness = Effect.fn("GitVcsDriver.nowFreshness")(function* () {
  const now = yield* DateTime.now;
  return {
    source: "live-local" as const,
    observedAt: now,
    expiresAt: Option.none(),
  };
});

function splitNullSeparatedPaths(input: string, truncated: boolean): string[] {
  const parts = input.split("\0");
  if (parts.length === 0) return [];

  if (truncated && parts[parts.length - 1]?.length) {
    parts.pop();
  }

  return parts.filter((value) => value.length > 0);
}

function chunkPathsForGitCheckIgnore(relativePaths: ReadonlyArray<string>): string[][] {
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let chunkBytes = 0;

  for (const relativePath of relativePaths) {
    const relativePathBytes = Buffer.byteLength(relativePath) + 1;
    if (chunk.length > 0 && chunkBytes + relativePathBytes > GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }

    chunk.push(relativePath);
    chunkBytes += relativePathBytes;

    if (chunkBytes >= GIT_CHECK_IGNORE_MAX_STDIN_BYTES) {
      chunks.push(chunk);
      chunk = [];
      chunkBytes = 0;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}

const gitCommand = (
  process: VcsProcessShape,
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly stdin?: string;
    readonly allowNonZeroExit?: boolean;
    readonly timeoutMs?: number;
    readonly maxOutputBytes?: number;
    readonly truncateOutputAtMaxBytes?: boolean;
  },
) =>
  process.run({
    operation,
    command: "git",
    args,
    cwd,
    ...(options?.stdin !== undefined ? { stdin: options.stdin } : {}),
    ...(options?.allowNonZeroExit !== undefined
      ? { allowNonZeroExit: options.allowNonZeroExit }
      : {}),
    ...(options?.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options?.maxOutputBytes !== undefined ? { maxOutputBytes: options.maxOutputBytes } : {}),
    ...(options?.truncateOutputAtMaxBytes !== undefined
      ? { truncateOutputAtMaxBytes: options.truncateOutputAtMaxBytes }
      : {}),
  });

export const makeVcsDriverShape = Effect.fn("makeGitVcsDriverShape")(function* () {
  const process = yield* VcsProcess;
  const capabilities = {
    kind: "git" as const,
    supportsWorktrees: true,
    supportsBookmarks: false,
    supportsAtomicSnapshot: false,
    supportsPushDefaultRemote: true,
  };

  const isInsideWorkTree: VcsDriverShape["isInsideWorkTree"] = (cwd) =>
    gitCommand(
      process,
      "GitVcsDriver.isInsideWorkTree",
      cwd,
      ["rev-parse", "--is-inside-work-tree"],
      {
        allowNonZeroExit: true,
        timeoutMs: 5_000,
        maxOutputBytes: 4_096,
      },
    ).pipe(Effect.map((result) => result.exitCode === 0 && result.stdout.trim() === "true"));

  const execute: VcsDriverShape["execute"] = (input) =>
    gitCommand(process, input.operation, input.cwd, input.args, {
      ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
      ...(input.allowNonZeroExit !== undefined ? { allowNonZeroExit: input.allowNonZeroExit } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxOutputBytes !== undefined ? { maxOutputBytes: input.maxOutputBytes } : {}),
      ...(input.truncateOutputAtMaxBytes !== undefined
        ? { truncateOutputAtMaxBytes: input.truncateOutputAtMaxBytes }
        : {}),
    });

  const detectRepository: VcsDriverShape["detectRepository"] = Effect.fn("detectRepository")(
    function* (cwd) {
      if (!(yield* isInsideWorkTree(cwd))) {
        return null;
      }

      const root = yield* gitCommand(process, "GitVcsDriver.detectRepository.root", cwd, [
        "rev-parse",
        "--show-toplevel",
      ]);
      const gitCommonDir = yield* gitCommand(
        process,
        "GitVcsDriver.detectRepository.commonDir",
        cwd,
        ["rev-parse", "--git-common-dir"],
      ).pipe(Effect.catch(() => Effect.succeed(null)));

      return {
        kind: "git" as const,
        rootPath: root.stdout.trim(),
        metadataPath: gitCommonDir?.stdout.trim() || null,
        freshness: yield* nowFreshness(),
      };
    },
  );

  const listWorkspaceFiles: VcsDriverShape["listWorkspaceFiles"] = (cwd) =>
    gitCommand(
      process,
      "GitVcsDriver.listWorkspaceFiles",
      cwd,
      [
        ...WORKSPACE_GIT_HARDENED_CONFIG_ARGS,
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ],
      {
        allowNonZeroExit: true,
        timeoutMs: 20_000,
        maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
        truncateOutputAtMaxBytes: true,
      },
    ).pipe(
      Effect.flatMap((result) =>
        result.exitCode === 0
          ? Effect.gen(function* () {
              const freshness = yield* nowFreshness();
              return {
                paths: splitNullSeparatedPaths(result.stdout, result.stdoutTruncated),
                truncated: result.stdoutTruncated,
                freshness,
              };
            })
          : Effect.fail(
              new VcsProcessExitError({
                operation: "GitVcsDriver.listWorkspaceFiles",
                command: "git ls-files",
                cwd,
                exitCode: result.exitCode,
                detail: result.stderr.trim() || "git ls-files failed",
              }),
            ),
      ),
    );

  const filterIgnoredPaths: VcsDriverShape["filterIgnoredPaths"] = Effect.fn("filterIgnoredPaths")(
    function* (cwd, relativePaths) {
      if (relativePaths.length === 0) {
        return relativePaths;
      }

      const ignoredPaths = new Set<string>();
      const chunks = chunkPathsForGitCheckIgnore(relativePaths);

      for (const chunk of chunks) {
        const result = yield* gitCommand(
          process,
          "GitVcsDriver.filterIgnoredPaths",
          cwd,
          [...WORKSPACE_GIT_HARDENED_CONFIG_ARGS, "check-ignore", "--no-index", "-z", "--stdin"],
          {
            stdin: `${chunk.join("\0")}\0`,
            allowNonZeroExit: true,
            timeoutMs: 20_000,
            maxOutputBytes: WORKSPACE_FILES_MAX_OUTPUT_BYTES,
            truncateOutputAtMaxBytes: true,
          },
        );

        if (result.exitCode !== 0 && result.exitCode !== 1) {
          return yield* new VcsProcessExitError({
            operation: "GitVcsDriver.filterIgnoredPaths",
            command: "git check-ignore",
            cwd,
            exitCode: result.exitCode,
            detail: result.stderr.trim() || "git check-ignore failed",
          });
        }

        for (const ignoredPath of splitNullSeparatedPaths(result.stdout, result.stdoutTruncated)) {
          ignoredPaths.add(ignoredPath);
        }
      }

      if (ignoredPaths.size === 0) {
        return relativePaths;
      }

      return relativePaths.filter((relativePath) => !ignoredPaths.has(relativePath));
    },
  );

  return {
    capabilities,
    execute,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    filterIgnoredPaths,
  } satisfies VcsDriverShape;
});

export const makeVcsDriver = Effect.fn("makeGitVcsDriver")(function* () {
  const driver = yield* makeVcsDriverShape();
  return VcsDriver.of(driver);
});

export const make = Effect.fn("makeGitVcsDriverService")(function* () {
  const git = yield* makeGitVcsDriverCore();
  return GitVcsDriver.of(git);
});

export const vcsLayer = Layer.effect(VcsDriver, makeVcsDriver());
export const layer = Layer.effect(GitVcsDriver, make());
