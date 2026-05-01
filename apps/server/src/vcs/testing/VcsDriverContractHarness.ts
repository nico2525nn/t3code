import { realpathSync } from "node:fs";

import { it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Path, type PlatformError, type Scope } from "effect";
import { describe, expect } from "vitest";

import type { VcsDriverKind } from "@t3tools/contracts";
import { VcsDriver } from "../VcsDriver.ts";

export interface VcsDriverFixture<R, E> {
  readonly createRepo: (cwd: string) => Effect.Effect<void, E, R>;
  readonly writeFile: (
    cwd: string,
    relativePath: string,
    contents: string,
  ) => Effect.Effect<void, E, R | FileSystem.FileSystem | Path.Path>;
  readonly trackFile?: (cwd: string, relativePath: string) => Effect.Effect<void, E, R>;
  readonly commit?: (cwd: string, message: string) => Effect.Effect<void, E, R>;
  readonly ignorePath: (
    cwd: string,
    pattern: string,
  ) => Effect.Effect<void, E, R | FileSystem.FileSystem | Path.Path>;
}

export interface VcsDriverContractSuiteInput<R, E> {
  readonly name: string;
  readonly kind: VcsDriverKind;
  readonly layer: Layer.Layer<VcsDriver | R | FileSystem.FileSystem | Path.Path, E, never>;
  readonly fixture: VcsDriverFixture<R, E>;
}

export function runVcsDriverContractSuite<R, E>(input: VcsDriverContractSuiteInput<R, E>) {
  const makeTmpDir = (
    prefix = `t3-${input.kind}-vcs-contract-`,
  ): Effect.Effect<string, PlatformError.PlatformError, FileSystem.FileSystem | Scope.Scope> =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      return yield* fileSystem.makeTempDirectoryScoped({ prefix });
    });

  it.layer(input.layer)(`${input.name} VCS driver contract`, (it) => {
    describe("repository detection", () => {
      it.effect("returns null outside a repository", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          expect(yield* driver.detectRepository(cwd)).toBeNull();
          expect(yield* driver.isInsideWorkTree(cwd)).toBe(false);
        }),
      );

      it.effect("detects repository identity inside a repository and nested directories", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);
          yield* input.fixture.writeFile(cwd, "src/index.ts", "export const value = 1;\n");
          const expectedRootPath = realpathSync.native(cwd);

          const identity = yield* driver.detectRepository(cwd);
          expect(identity).toMatchObject({
            kind: input.kind,
            rootPath: expectedRootPath,
          });
          expect(identity?.freshness).toMatchObject({
            source: "live-local",
            observedAt: expect.any(String),
          });
          expect(yield* driver.isInsideWorkTree(cwd)).toBe(true);

          const path = yield* Path.Path;
          const nestedDir = path.join(cwd, "src");
          const nestedIdentity = yield* driver.detectRepository(nestedDir);
          expect(nestedIdentity?.rootPath).toBe(expectedRootPath);
          expect(yield* driver.isInsideWorkTree(nestedDir)).toBe(true);
        }),
      );
    });

    describe("workspace files", () => {
      it.effect("lists tracked and untracked non-ignored files", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);
          yield* input.fixture.writeFile(cwd, "tracked.ts", "export const tracked = true;\n");
          if (input.fixture.trackFile && input.fixture.commit) {
            yield* input.fixture.trackFile(cwd, "tracked.ts");
            yield* input.fixture.commit(cwd, "Track file");
          }
          yield* input.fixture.writeFile(cwd, "untracked.ts", "export const untracked = true;\n");

          const result = yield* driver.listWorkspaceFiles(cwd);

          expect(result.paths).toContain("tracked.ts");
          expect(result.paths).toContain("untracked.ts");
          expect(result.truncated).toBe(false);
          expect(result.freshness).toMatchObject({
            source: "live-local",
            observedAt: expect.any(String),
          });
        }),
      );

      it.effect("excludes ignored files from workspace listing", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);
          yield* input.fixture.ignorePath(cwd, "*.log");
          yield* input.fixture.writeFile(cwd, "included.ts", "export const included = true;\n");
          yield* input.fixture.writeFile(cwd, "debug.log", "ignore me\n");
          yield* input.fixture.writeFile(cwd, "nested/error.log", "ignore me too\n");

          const result = yield* driver.listWorkspaceFiles(cwd);

          expect(result.paths).toContain("included.ts");
          expect(result.paths).not.toContain("debug.log");
          expect(result.paths).not.toContain("nested/error.log");
        }),
      );
    });

    describe("ignored path filtering", () => {
      it.effect("filters ignored paths", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);
          yield* input.fixture.ignorePath(cwd, "*.log");

          const result = yield* driver.filterIgnoredPaths(cwd, [
            "keep.ts",
            "debug.log",
            "nested/error.log",
          ]);

          expect(result).toEqual(["keep.ts"]);
        }),
      );

      it.effect("returns empty input unchanged", () =>
        Effect.gen(function* () {
          const cwd = yield* makeTmpDir();
          const driver = yield* VcsDriver;

          yield* input.fixture.createRepo(cwd);

          expect(yield* driver.filterIgnoredPaths(cwd, [])).toEqual([]);
        }),
      );
    });
  });
}
