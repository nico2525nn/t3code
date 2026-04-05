import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { GitStatusResult } from "@t3tools/contracts";
import { describe } from "vitest";

import { GitStatusBroadcaster } from "../Services/GitStatusBroadcaster.ts";
import { GitStatusBroadcasterLive } from "./GitStatusBroadcaster.ts";
import { type GitManagerShape, GitManager } from "../Services/GitManager.ts";

const baseStatus: GitStatusResult = {
  isRepo: true,
  hasOriginRemote: true,
  isDefaultBranch: false,
  branch: "feature/status-broadcast",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: null,
};

function makeTestLayer(state: {
  currentStatus: GitStatusResult;
  statusCalls: number;
  invalidationCalls: number;
}) {
  const gitManager: GitManagerShape = {
    status: () =>
      Effect.sync(() => {
        state.statusCalls += 1;
        return state.currentStatus;
      }),
    invalidateStatus: () =>
      Effect.sync(() => {
        state.invalidationCalls += 1;
      }),
    resolvePullRequest: () => Effect.die("resolvePullRequest should not be called in this test"),
    preparePullRequestThread: () =>
      Effect.die("preparePullRequestThread should not be called in this test"),
    runStackedAction: () => Effect.die("runStackedAction should not be called in this test"),
  };

  return GitStatusBroadcasterLive.pipe(Layer.provide(Layer.succeed(GitManager, gitManager)));
}

describe("GitStatusBroadcasterLive", () => {
  it.effect("reuses the cached git status across repeated reads", () => {
    const state = {
      currentStatus: baseStatus,
      statusCalls: 0,
      invalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* GitStatusBroadcaster;

      const first = yield* broadcaster.getStatus({ cwd: "/repo" });
      const second = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(first, baseStatus);
      assert.deepStrictEqual(second, baseStatus);
      assert.equal(state.statusCalls, 1);
      assert.equal(state.invalidationCalls, 1);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });

  it.effect("refreshes the cached snapshot after explicit invalidation", () => {
    const state = {
      currentStatus: baseStatus,
      statusCalls: 0,
      invalidationCalls: 0,
    };

    return Effect.gen(function* () {
      const broadcaster = yield* GitStatusBroadcaster;
      const initial = yield* broadcaster.getStatus({ cwd: "/repo" });

      state.currentStatus = {
        ...baseStatus,
        branch: "feature/updated-status",
        aheadCount: 2,
      };
      const refreshed = yield* broadcaster.refreshStatus("/repo");
      const cached = yield* broadcaster.getStatus({ cwd: "/repo" });

      assert.deepStrictEqual(initial, baseStatus);
      assert.deepStrictEqual(refreshed, state.currentStatus);
      assert.deepStrictEqual(cached, state.currentStatus);
      assert.equal(state.statusCalls, 2);
      assert.equal(state.invalidationCalls, 2);
    }).pipe(Effect.provide(makeTestLayer(state)));
  });
});
