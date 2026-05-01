import { it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { describe, expect } from "vitest";

import { ServerConfig } from "../config.ts";
import { VcsDriver } from "./VcsDriver.ts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import * as VcsProcess from "./VcsProcess.ts";

const splitNullSeparatedPaths = (input: string): string[] =>
  input
    .split("\0")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

const GitVcsDriverTestDependencies = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-git-vcs-driver-test-",
}).pipe(Layer.provide(NodeServices.layer));

it.layer(Layer.empty)("GitVcsDriver.layer", (it) => {
  describe("workspace helpers", () => {
    it.effect("filterIgnoredPaths chunks large path lists and preserves kept paths", () =>
      Effect.gen(function* () {
        const cwd = "/virtual/repo";
        const relativePaths = Array.from({ length: 340 }, (_, index) => {
          const prefix = index % 3 === 0 ? "ignored" : "kept";
          return `${prefix}/segment-${String(index).padStart(4, "0")}/${"x".repeat(900)}.ts`;
        });
        const expectedPaths = relativePaths.filter(
          (relativePath) => !relativePath.startsWith("ignored/"),
        );

        const seenChunks: string[][] = [];
        const layer = GitVcsDriver.layer.pipe(
          Layer.provideMerge(GitVcsDriverTestDependencies),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(
            Layer.succeed(VcsProcess.VcsProcess, {
              run: (input) => {
                expect(input.command).toBe("git");
                expect(input.args).toEqual([
                  "-c",
                  "core.fsmonitor=false",
                  "-c",
                  "core.untrackedCache=false",
                  "check-ignore",
                  "--no-index",
                  "-z",
                  "--stdin",
                ]);

                const chunkPaths = splitNullSeparatedPaths(input.stdin ?? "");
                seenChunks.push(chunkPaths);
                const ignoredPaths = chunkPaths.filter((relativePath) =>
                  relativePath.startsWith("ignored/"),
                );

                return Effect.succeed({
                  exitCode: ignoredPaths.length > 0 ? 0 : 1,
                  stdout: ignoredPaths.length > 0 ? `${ignoredPaths.join("\0")}\0` : "",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                });
              },
            }),
          ),
        );

        const result = yield* Effect.gen(function* () {
          const vcs = yield* VcsDriver;
          return yield* vcs.filterIgnoredPaths(cwd, relativePaths);
        }).pipe(Effect.provide(layer));

        expect(seenChunks.length).toBeGreaterThan(1);
        expect(seenChunks.flat()).toEqual(relativePaths);
        expect(result).toEqual(expectedPaths);
      }),
    );

    it.effect("listWorkspaceFiles disables fsmonitor and untracked cache helpers", () =>
      Effect.gen(function* () {
        const layer = GitVcsDriver.layer.pipe(
          Layer.provideMerge(GitVcsDriverTestDependencies),
          Layer.provideMerge(NodeServices.layer),
          Layer.provide(
            Layer.succeed(VcsProcess.VcsProcess, {
              run: (input) => {
                expect(input.command).toBe("git");
                expect(input.args).toEqual([
                  "-c",
                  "core.fsmonitor=false",
                  "-c",
                  "core.untrackedCache=false",
                  "ls-files",
                  "--cached",
                  "--others",
                  "--exclude-standard",
                  "-z",
                ]);
                return Effect.succeed({
                  exitCode: 0,
                  stdout: "src/index.ts\0README.md\0",
                  stderr: "",
                  stdoutTruncated: false,
                  stderrTruncated: false,
                });
              },
            }),
          ),
        );

        const result = yield* Effect.gen(function* () {
          const vcs = yield* VcsDriver;
          return yield* vcs.listWorkspaceFiles("/virtual/repo");
        }).pipe(Effect.provide(layer));

        expect(result.paths).toEqual(["src/index.ts", "README.md"]);
        expect(result.truncated).toBe(false);
        expect(result.freshness.source).toBe("live-local");
      }),
    );
  });
});
