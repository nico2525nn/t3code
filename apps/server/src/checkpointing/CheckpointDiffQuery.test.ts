import { CheckpointRef, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect } from "vite-plus/test";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as CheckpointDiffBlobRepository from "../persistence/Services/CheckpointDiffBlobs.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { CheckpointThreadNotFoundError } from "./Errors.ts";

function makeThreadCheckpointContext(input: {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
}): ProjectionSnapshotQuery.ProjectionThreadCheckpointContext {
  return {
    threadId: input.threadId,
    projectId: input.projectId,
    workspaceRoot: input.workspaceRoot,
    worktreePath: input.worktreePath,
    checkpoints: [
      {
        turnId: TurnId.make("turn-1"),
        checkpointTurnCount: input.checkpointTurnCount,
        checkpointRef: input.checkpointRef,
        status: "ready",
        files: [],
        assistantMessageId: null,
        completedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  };
}

describe("CheckpointDiffQuery.layer", () => {
  it.effect("uses the narrow full-thread context lookup for all-turns diffs", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-full-thread");
      const threadId = ThreadId.make("thread-full-thread");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 4);
      let getThreadCheckpointContextCalls = 0;
      let getFullThreadDiffContextCalls = 0;
      const diffCheckpointsCalls: Array<{
        readonly fromCheckpointRef: CheckpointRef;
        readonly toCheckpointRef: CheckpointRef;
        readonly cwd: string;
        readonly ignoreWhitespace: boolean;
      }> = [];

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
          Effect.sync(() => {
            diffCheckpointsCalls.push({
              fromCheckpointRef,
              toCheckpointRef,
              cwd,
              ignoreWhitespace,
            });
            return "full thread diff patch";
          }),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () =>
              Effect.sync(() => {
                getThreadCheckpointContextCalls += 1;
                return Option.none();
              }),
            getFullThreadDiffContext: () =>
              Effect.sync(() => {
                getFullThreadDiffContextCalls += 1;
                return Option.some({
                  threadId,
                  projectId,
                  workspaceRoot: "/tmp/workspace",
                  worktreePath: "/tmp/worktree",
                  latestCheckpointTurnCount: 4,
                  toCheckpointRef,
                  toCheckpointStatus: "missing",
                });
              }),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer));

      expect(getThreadCheckpointContextCalls).toBe(0);
      expect(getFullThreadDiffContextCalls).toBe(1);
      expect(diffCheckpointsCalls).toEqual([
        {
          cwd: "/tmp/worktree",
          fromCheckpointRef: checkpointRefForThreadTurn(threadId, 0),
          toCheckpointRef,
          ignoreWhitespace: true,
        },
      ]);
      expect(result).toEqual({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 4,
        diff: "full thread diff patch",
      });
    }),
  );

  it.effect("computes diffs using canonical turn-0 checkpoint refs", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-1");
      const threadId = ThreadId.make("thread-1");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const diffCheckpointsCalls: Array<{
        readonly fromCheckpointRef: CheckpointRef;
        readonly toCheckpointRef: CheckpointRef;
        readonly cwd: string;
        readonly ignoreWhitespace: boolean;
      }> = [];

      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      });

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ fromCheckpointRef, toCheckpointRef, cwd, ignoreWhitespace }) =>
          Effect.sync(() => {
            diffCheckpointsCalls.push({
              fromCheckpointRef,
              toCheckpointRef,
              cwd,
              ignoreWhitespace,
            });
            return "diff patch";
          }),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
            getFullThreadDiffContext: () => Effect.die("unused"),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer));

      const expectedFromRef = checkpointRefForThreadTurn(threadId, 0);
      expect(diffCheckpointsCalls).toEqual([
        {
          cwd: "/tmp/workspace",
          fromCheckpointRef: expectedFromRef,
          toCheckpointRef,
          ignoreWhitespace: true,
        },
      ]);
      expect(result).toEqual({
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: "diff patch",
      });
    }),
  );

  it.effect("defaults to hide whitespace changes", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-default-whitespace");
      const threadId = ThreadId.make("thread-default-whitespace");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      const diffCheckpointsCalls: Array<{ readonly ignoreWhitespace: boolean }> = [];

      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      });

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: ({ ignoreWhitespace }) =>
          Effect.sync(() => {
            diffCheckpointsCalls.push({ ignoreWhitespace });
            return "diff patch";
          }),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
            getFullThreadDiffContext: () => Effect.die("unused"),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer));

      expect(diffCheckpointsCalls).toEqual([{ ignoreWhitespace: true }]);
    }),
  );

  it.effect("does not preflight checkpoint refs before diffing", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-no-preflight");
      const threadId = ThreadId.make("thread-no-preflight");
      const toCheckpointRef = checkpointRefForThreadTurn(threadId, 1);
      let hasCheckpointRefCallCount = 0;

      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: toCheckpointRef,
      });

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () =>
          Effect.sync(() => {
            hasCheckpointRefCallCount += 1;
            return true;
          }),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: () => Effect.succeed("diff patch"),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
            getFullThreadDiffContext: () => Effect.die("unused"),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
      }).pipe(Effect.provide(layer));

      expect(hasCheckpointRefCallCount).toBe(0);
    }),
  );

  it.effect("reads provider-native blobs for missing filesystem checkpoints", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-provider-diff");
      const threadId = ThreadId.make("thread-provider-diff");
      const providerCheckpointRef = CheckpointRef.make("provider-diff:thread-provider-diff:turn-1");
      const threadCheckpointContext = makeThreadCheckpointContext({
        projectId,
        threadId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpointTurnCount: 1,
        checkpointRef: providerCheckpointRef,
      });
      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(false),
        restoreCheckpoint: () => Effect.succeed(false),
        diffCheckpoints: () => Effect.die("provider-native diff should not invoke Git"),
        deleteCheckpointRefs: () => Effect.void,
      };
      const blobRepository: CheckpointDiffBlobRepository.CheckpointDiffBlobRepositoryShape = {
        upsert: () => Effect.void,
        get: () => Effect.succeed(Option.none()),
        listByThreadId: () =>
          Effect.succeed([
            {
              threadId,
              fromTurnCount: 0,
              toTurnCount: 1,
              diff: [
                "diff --git a/package.json b/package.json",
                "--- a/package.json",
                "+++ b/package.json",
                "@@ -1 +1 @@",
                "-{",
                "+{",
                "diff --git a/package.json b/package.json",
                "--- a/package.json",
                "+++ b/package.json",
                "@@ -2 +2 @@",
                '-  "old": true',
                '+  "new": true',
              ].join("\n"),
              createdAt: "2026-01-01T00:00:00.000Z",
              status: "final",
            },
          ]),
        deleteAfterTurnCount: () => Effect.void,
      };
      const projectionQuery = {
        getThreadCheckpointContext: () => Effect.succeed(Option.some(threadCheckpointContext)),
        getFullThreadDiffContext: () =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId,
              workspaceRoot: "/tmp/workspace",
              worktreePath: null,
              latestCheckpointTurnCount: 1,
              toCheckpointRef: providerCheckpointRef,
            }),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(CheckpointDiffBlobRepository.CheckpointDiffBlobRepository, blobRepository),
        ),
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projectionQuery),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        const turnDiff = yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
        const fullThreadDiff = yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 1,
          ignoreWhitespace: true,
        });
        return { turnDiff, fullThreadDiff };
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({
        turnDiff: {
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: [
            "diff --git a/package.json b/package.json",
            "--- a/package.json",
            "+++ b/package.json",
            "@@ -1 +1 @@",
            "-{",
            "+{",
            "@@ -2 +2 @@",
            '-  "old": true',
            '+  "new": true',
          ].join("\n"),
        },
        fullThreadDiff: {
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          diff: [
            "diff --git a/package.json b/package.json",
            "--- a/package.json",
            "+++ b/package.json",
            "@@ -1 +1 @@",
            "-{",
            "+{",
            "@@ -2 +2 @@",
            '-  "old": true',
            '+  "new": true',
          ].join("\n"),
        },
      });
    }),
  );

  it.effect("keeps provider-native ranges readable across unchanged turns", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-provider-empty-turn");
      const threadId = ThreadId.make("thread-provider-empty-turn");
      const providerRef = (turn: number) =>
        CheckpointRef.make(`provider-diff:${String(threadId)}:turn-${turn}`);
      const checkpoints: ProjectionSnapshotQuery.ProjectionThreadCheckpointContext["checkpoints"] =
        [
          {
            turnId: TurnId.make("turn-1"),
            checkpointTurnCount: 1,
            checkpointRef: providerRef(1),
            status: "ready",
            files: [{ path: "one.ts", kind: "modified", additions: 1, deletions: 0 }],
            assistantMessageId: null,
            completedAt: "2026-01-01T00:01:00.000Z",
          },
          {
            turnId: TurnId.make("turn-2"),
            checkpointTurnCount: 2,
            checkpointRef: providerRef(2),
            status: "ready",
            files: [],
            assistantMessageId: null,
            completedAt: "2026-01-01T00:02:00.000Z",
          },
          {
            turnId: TurnId.make("turn-3"),
            checkpointTurnCount: 3,
            checkpointRef: providerRef(3),
            status: "ready",
            files: [{ path: "three.ts", kind: "modified", additions: 2, deletions: 0 }],
            assistantMessageId: null,
            completedAt: "2026-01-01T00:03:00.000Z",
          },
        ];
      const context = {
        threadId,
        projectId,
        workspaceRoot: "/tmp/workspace",
        worktreePath: null,
        checkpoints,
      } satisfies ProjectionSnapshotQuery.ProjectionThreadCheckpointContext;
      const blobRepository: CheckpointDiffBlobRepository.CheckpointDiffBlobRepositoryShape = {
        upsert: () => Effect.void,
        get: () => Effect.succeed(Option.none()),
        listByThreadId: () =>
          Effect.succeed([
            {
              threadId,
              fromTurnCount: 0,
              toTurnCount: 1,
              diff: "patch one",
              createdAt: "2026-01-01T00:01:00.000Z",
              status: "final",
            },
            {
              threadId,
              fromTurnCount: 2,
              toTurnCount: 3,
              diff: "patch three",
              createdAt: "2026-01-01T00:03:00.000Z",
              status: "final",
            },
          ]),
        deleteAfterTurnCount: () => Effect.void,
      };
      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(false),
        restoreCheckpoint: () => Effect.succeed(false),
        diffCheckpoints: () => Effect.die("provider-native diff should not invoke Git"),
        deleteCheckpointRefs: () => Effect.void,
      };
      const projectionQuery = {
        getThreadCheckpointContext: () => Effect.succeed(Option.some(context)),
        getFullThreadDiffContext: () =>
          Effect.succeed(
            Option.some({
              threadId,
              projectId,
              workspaceRoot: "/tmp/workspace",
              worktreePath: null,
              latestCheckpointTurnCount: 3,
              toCheckpointRef: providerRef(3),
            }),
          ),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(
          Layer.succeed(CheckpointDiffBlobRepository.CheckpointDiffBlobRepository, blobRepository),
        ),
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, projectionQuery),
        ),
      );

      const result = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        const turnDiff = yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 1,
          toTurnCount: 2,
        });
        const fullThreadDiff = yield* query.getFullThreadDiff({
          threadId,
          toTurnCount: 3,
        });
        return { turnDiff, fullThreadDiff };
      }).pipe(Effect.provide(layer));

      expect(result).toEqual({
        turnDiff: {
          threadId,
          fromTurnCount: 1,
          toTurnCount: 2,
          diff: "",
        },
        fullThreadDiff: {
          threadId,
          fromTurnCount: 0,
          toTurnCount: 3,
          diff: "patch one\n\npatch three",
        },
      });
    }),
  );

  it.effect("fails when the thread is missing from the snapshot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-missing");

      const checkpointStore: CheckpointStore.CheckpointStore["Service"] = {
        isGitRepository: () => Effect.succeed(true),
        captureCheckpoint: () => Effect.void,
        hasCheckpointRef: () => Effect.succeed(true),
        restoreCheckpoint: () => Effect.succeed(true),
        diffCheckpoints: () => Effect.succeed(""),
        deleteCheckpointRefs: () => Effect.void,
      };

      const layer = CheckpointDiffQuery.layer.pipe(
        Layer.provideMerge(Layer.succeed(CheckpointStore.CheckpointStore, checkpointStore)),
        Layer.provideMerge(
          Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
            getUserInputActivity: () => Effect.die("unused"),
            getCommandReadModel: () =>
              Effect.die("CheckpointDiffQuery should not request the command read model"),
            getSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the full orchestration snapshot"),
            getShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request the orchestration shell snapshot"),
            getArchivedShellSnapshot: () =>
              Effect.die("CheckpointDiffQuery should not request archived shell snapshots"),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: () => Effect.die("unused"),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getImportedAgentSessionSources: () => Effect.die("unused"),
            getThreadCheckpointContext: () => Effect.succeed(Option.none()),
            getFullThreadDiffContext: () => Effect.succeed(Option.none()),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
            searchThreads: () => Effect.succeed({ matches: [] }),
          }),
        ),
      );

      const error = yield* Effect.gen(function* () {
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery;
        return yield* query.getTurnDiff({
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
        });
      }).pipe(Effect.provide(layer), Effect.flip);

      expect(error).toBeInstanceOf(CheckpointThreadNotFoundError);
      expect(error).toMatchObject({
        operation: "CheckpointDiffQuery.getTurnDiff",
        threadId,
      });
      expect(error.message).toBe(
        "Checkpoint invariant violation in CheckpointDiffQuery.getTurnDiff: Thread 'thread-missing' not found.",
      );
    }),
  );
});
