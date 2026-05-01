import { DateTime, Effect, Layer } from "effect";

import { VcsProcessExitError } from "@t3tools/contracts";
import { makeGitCore } from "../git/Layers/GitCore.ts";
import { VcsDriver, type VcsDriverShape } from "./VcsDriver.ts";
import { VcsProcess, type VcsProcessShape } from "./VcsProcess.ts";

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
    observedAt: DateTime.formatIso(now),
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

export const make = Effect.fn("makeGitVcsDriver")(function* () {
  const process = yield* VcsProcess;
  const legacyGit = yield* makeGitCore();
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

  return VcsDriver.of({
    ...legacyGit,
    capabilities,
    execute,
    detectRepository,
    isInsideWorkTree,
    listWorkspaceFiles,
    filterIgnoredPaths,
  });
});

export const layer = Layer.effect(VcsDriver, make());
