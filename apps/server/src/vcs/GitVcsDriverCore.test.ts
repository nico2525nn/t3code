import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, PlatformError, Scope } from "effect";
import { describe, expect } from "vitest";

import { GitCommandError } from "@t3tools/contracts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";

const ServerConfigLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
});
const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfigLayer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTmpDir = (
  prefix = "git-vcs-driver-test-",
): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.makeTempDirectoryScoped({ prefix });
  });

const writeTextFile = (
  filePath: string,
  contents: string,
): Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.makeDirectory(path.dirname(filePath), { recursive: true });
    yield* fileSystem.writeFileString(filePath, contents);
  });

const git = (
  cwd: string,
  args: ReadonlyArray<string>,
  env?: NodeJS.ProcessEnv,
): Effect.Effect<string, GitCommandError, GitVcsDriver.GitVcsDriver> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    const result = yield* driver.execute({
      operation: "GitVcsDriver.test.git",
      cwd,
      args,
      ...(env ? { env } : {}),
      timeoutMs: 10_000,
    });
    return result.stdout.trim();
  });

const initRepoWithCommit = (
  cwd: string,
): Effect.Effect<
  { readonly initialBranch: string },
  GitCommandError | PlatformError.PlatformError,
  GitVcsDriver.GitVcsDriver | FileSystem.FileSystem
> =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    yield* driver.initRepo({ cwd });
    yield* git(cwd, ["config", "user.email", "test@test.com"]);
    yield* git(cwd, ["config", "user.name", "Test"]);
    yield* writeTextFile(path.join(cwd, "README.md"), "# test\n");
    yield* git(cwd, ["add", "."]);
    yield* git(cwd, ["commit", "-m", "initial commit"]);
    const initialBranch = yield* git(cwd, ["branch", "--show-current"]);
    return { initialBranch };
  });

it.layer(TestLayer)("GitVcsDriver core integration", (it) => {
  describe("repository status", () => {
    it.effect("reports non-repository directories without failing", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const driver = yield* GitVcsDriver.GitVcsDriver;

        expect(yield* driver.listBranches({ cwd })).toMatchObject({
          isRepo: false,
          branches: [],
        });
      }),
    );

    it.effect("reports branch and dirty state for a repository", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        yield* writeTextFile(path.join(cwd, "feature.ts"), "export const value = 1;\n");

        const status = yield* (yield* GitVcsDriver.GitVcsDriver).statusDetails(cwd);

        expect(status.isRepo).toBe(true);
        expect(status.branch).toBe(initialBranch);
        expect(status.hasWorkingTreeChanges).toBe(true);
        expect(status.workingTree.files.map((file) => file.path)).toContain("feature.ts");
      }),
    );
  });

  describe("branch operations", () => {
    it.effect("creates, checks out, renames, and lists branches", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* driver.createBranch({ cwd, branch: "feature/original" });
        const checkout = yield* driver.checkoutBranch({ cwd, branch: "feature/original" });
        expect(checkout.branch).toBe("feature/original");

        const renamed = yield* driver.renameBranch({
          cwd,
          oldBranch: "feature/original",
          newBranch: "feature/renamed",
        });
        expect(renamed.branch).toBe("feature/renamed");
        expect(yield* git(cwd, ["branch", "--show-current"])).toBe("feature/renamed");

        const branches = yield* driver.listBranches({ cwd });
        expect(branches.branches.find((branch) => branch.name === "feature/renamed")).toMatchObject(
          {
            current: true,
          },
        );
      }),
    );

    it.effect("returns the existing branch when rename source and target match", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const current = yield* git(cwd, ["branch", "--show-current"]);
        const result = yield* driver.renameBranch({
          cwd,
          oldBranch: current,
          newBranch: current,
        });

        expect(result.branch).toBe(current);
      }),
    );
  });

  describe("worktree operations", () => {
    it.effect("creates and removes a worktree for a new branch", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const { initialBranch } = yield* initRepoWithCommit(cwd);
        const worktreePath = path.join(yield* makeTmpDir("git-worktrees-"), "feature-worktree");
        const driver = yield* GitVcsDriver.GitVcsDriver;

        const created = yield* driver.createWorktree({
          cwd,
          path: worktreePath,
          branch: initialBranch,
          newBranch: "feature/worktree",
        });

        expect(created.worktree.path).toBe(worktreePath);
        expect(created.worktree.branch).toBe("feature/worktree");
        expect(yield* git(worktreePath, ["branch", "--show-current"])).toBe("feature/worktree");

        yield* driver.removeWorktree({ cwd, path: worktreePath });
        const fileSystem = yield* FileSystem.FileSystem;
        expect(yield* fileSystem.exists(worktreePath)).toBe(false);
      }),
    );
  });

  describe("commit context", () => {
    it.effect("stages selected files and commits only those files", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        yield* initRepoWithCommit(cwd);
        const driver = yield* GitVcsDriver.GitVcsDriver;

        yield* writeTextFile(path.join(cwd, "a.txt"), "a\n");
        yield* writeTextFile(path.join(cwd, "b.txt"), "b\n");

        const context = yield* driver.prepareCommitContext(cwd, ["a.txt"]);
        expect(context?.stagedSummary).toContain("a.txt");
        expect(context?.stagedSummary).not.toContain("b.txt");

        const commit = yield* driver.commit(cwd, "Add a", "");
        expect(commit.commitSha).toMatch(/^[a-f0-9]{40}$/);
        expect(yield* git(cwd, ["log", "-1", "--pretty=%s"])).toBe("Add a");

        const status = yield* git(cwd, ["status", "--porcelain"]);
        expect(status).toContain("?? b.txt");
        expect(status).not.toContain("a.txt");
      }),
    );
  });

  describe("remote operations", () => {
    it.effect("pushes with upstream setup and skips when already up to date", () =>
      Effect.gen(function* () {
        const cwd = yield* makeTmpDir();
        const remote = yield* makeTmpDir("git-remote-");
        yield* initRepoWithCommit(cwd);
        yield* git(remote, ["init", "--bare"]);
        yield* git(cwd, ["remote", "add", "origin", remote]);
        yield* (yield* GitVcsDriver.GitVcsDriver).createBranch({
          cwd,
          branch: "feature/push",
        });
        yield* (yield* GitVcsDriver.GitVcsDriver).checkoutBranch({
          cwd,
          branch: "feature/push",
        });
        yield* writeTextFile(path.join(cwd, "feature.txt"), "feature\n");
        yield* (yield* GitVcsDriver.GitVcsDriver).prepareCommitContext(cwd);
        yield* (yield* GitVcsDriver.GitVcsDriver).commit(cwd, "Add feature", "");

        const pushed = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        expect(pushed).toMatchObject({
          status: "pushed",
          branch: "feature/push",
          setUpstream: true,
        });
        expect(yield* git(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"])).toBe(
          "origin/feature/push",
        );

        const skipped = yield* (yield* GitVcsDriver.GitVcsDriver).pushCurrentBranch(cwd, null);
        expect(skipped).toMatchObject({
          status: "skipped_up_to_date",
          branch: "feature/push",
        });
      }),
    );
  });
});
