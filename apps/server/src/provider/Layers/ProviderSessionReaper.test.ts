import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it, vi } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import { ProviderValidationError } from "../Errors.ts";
import { ProviderSessionReaper } from "../Services/ProviderSessionReaper.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderSessionReaperLive } from "./ProviderSessionReaper.ts";

const defaultModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5-codex",
} as const;

const TEST_NOW = DateTime.makeUnsafe("2026-04-14T00:30:00.000Z");
const TEST_NOW_ISO = DateTime.formatIso(TEST_NOW);
const STALE_LAST_SEEN_AT = DateTime.formatIso(
  DateTime.subtractDuration(TEST_NOW, Duration.seconds(2)),
);
const FRESH_LAST_SEEN_AT = DateTime.formatIso(
  DateTime.subtractDuration(TEST_NOW, Duration.millis(500)),
);

const drainFibers = Effect.forEach(Array.from({ length: 10 }), () => Effect.yieldNow, {
  discard: true,
});

function makeReadModel(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly session: {
      readonly threadId: ThreadId;
      readonly status: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
      readonly providerName: "codex" | "claudeAgent";
      readonly runtimeMode: "approval-required" | "full-access" | "auto-accept-edits";
      readonly activeTurnId: TurnId | null;
      readonly lastError: string | null;
      readonly updatedAt: string;
    } | null;
  }>,
) {
  const projectId = ProjectId.make("project-provider-session-reaper");

  return {
    snapshotSequence: 0,
    updatedAt: TEST_NOW_ISO,
    projects: [
      {
        id: projectId,
        title: "Provider Reaper Project",
        workspaceRoot: "/tmp/provider-reaper-project",
        defaultModelSelection,
        scripts: [],
        createdAt: TEST_NOW_ISO,
        updatedAt: TEST_NOW_ISO,
        deletedAt: null,
      },
    ],
    threads: threads.map((thread) => ({
      id: thread.id,
      projectId,
      title: `Thread ${thread.id}`,
      modelSelection: defaultModelSelection,
      interactionMode: "default" as const,
      runtimeMode: "full-access" as const,
      branch: null,
      worktreePath: null,
      createdAt: TEST_NOW_ISO,
      updatedAt: TEST_NOW_ISO,
      archivedAt: null,
      latestUserMessageAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
      latestTurn: null,
      messages: [],
      session: thread.session,
      activities: [],
      proposedPlans: [],
      checkpoints: [],
      deletedAt: null,
    })),
  };
}

function createHarness(input: {
  readonly readModel: ReturnType<typeof makeReadModel>;
  readonly stopSessionImplementation?: (input: {
    readonly threadId: ThreadId;
  }) => ReturnType<ProviderServiceShape["stopSession"]>;
}) {
  const stoppedThreadIds = new Set<ThreadId>();
  const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(
    (request) =>
      (input.stopSessionImplementation
        ? input.stopSessionImplementation(request)
        : Effect.sync(() => {
            stoppedThreadIds.add(request.threadId);
          })) as ReturnType<ProviderServiceShape["stopSession"]>,
  );

  const runtimeRepositoryLayer = ProviderSessionRuntime.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
  );
  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(runtimeRepositoryLayer),
  );
  const layer = makeProviderSessionReaperLive({
    inactivityThreshold: Duration.seconds(1),
    sweepInterval: Duration.seconds(60),
  }).pipe(
    Layer.provideMerge(providerSessionDirectoryLayer),
    Layer.provideMerge(runtimeRepositoryLayer),
    Layer.provideMerge(
      Layer.mock(ProviderService)({
        stopSession,
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.succeed(
            Option.fromNullishOr(input.readModel.threads.find((thread) => thread.id === threadId)),
          ),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(TestClock.layer()),
  );

  return { layer, stopSession, stoppedThreadIds };
}

function seedSession(input: {
  readonly threadId: ThreadId;
  readonly providerName: "codex" | "claudeAgent";
  readonly status?: "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  readonly lastSeenAt: string;
  readonly resumeOpaque: string;
}) {
  return Effect.gen(function* () {
    const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
    yield* repository.upsert({
      threadId: input.threadId,
      providerName: input.providerName,
      providerInstanceId: null,
      adapterKey: input.providerName,
      runtimeMode: "full-access",
      status: input.status ?? "running",
      lastSeenAt: input.lastSeenAt,
      resumeCursor: {
        opaque: input.resumeOpaque,
      },
      runtimePayload: null,
    });
  });
}

const runInitialSweep = Effect.gen(function* () {
  const reaper = yield* ProviderSessionReaper;
  yield* reaper.start();
  yield* drainFibers;
});

function runWithHarness<A, E, R>(
  harness: ReturnType<typeof createHarness>,
  effect: Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    yield* TestClock.setTime(TEST_NOW.epochMilliseconds);
    return yield* effect;
  }).pipe(Effect.scoped, Effect.provide(harness.layer));
}

describe("ProviderSessionReaper", () => {
  it.effect("reaps stale persisted sessions without active turns", () => {
    const threadId = ThreadId.make("thread-reaper-stale");
    const harness = createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: TEST_NOW_ISO,
          },
        },
      ]),
    });

    return runWithHarness(
      harness,
      Effect.gen(function* () {
        yield* seedSession({
          threadId,
          providerName: "claudeAgent",
          lastSeenAt: STALE_LAST_SEEN_AT,
          resumeOpaque: "resume-stale",
        });
        yield* runInitialSweep;

        assert.deepStrictEqual(harness.stopSession.mock.calls[0]?.[0], { threadId });
        assert.isTrue(harness.stoppedThreadIds.has(threadId));
      }),
    );
  });

  it.effect("skips stale sessions when the thread still has an active turn", () => {
    const threadId = ThreadId.make("thread-reaper-active-turn");
    const turnId = TurnId.make("turn-reaper-active");
    const harness = createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "running",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: turnId,
            lastError: null,
            updatedAt: TEST_NOW_ISO,
          },
        },
      ]),
    });

    return runWithHarness(
      harness,
      Effect.gen(function* () {
        yield* seedSession({
          threadId,
          providerName: "claudeAgent",
          lastSeenAt: STALE_LAST_SEEN_AT,
          resumeOpaque: "resume-active-turn",
        });
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        yield* runInitialSweep;

        assert.equal(harness.stopSession.mock.calls.length, 0);
        const remaining = yield* repository.getByThreadId({ threadId });
        assert.isTrue(Option.isSome(remaining));
      }),
    );
  });

  it.effect("does not reap sessions that are still within the inactivity threshold", () => {
    const threadId = ThreadId.make("thread-reaper-fresh");
    const harness = createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: TEST_NOW_ISO,
          },
        },
      ]),
    });

    return runWithHarness(
      harness,
      Effect.gen(function* () {
        yield* seedSession({
          threadId,
          providerName: "claudeAgent",
          lastSeenAt: FRESH_LAST_SEEN_AT,
          resumeOpaque: "resume-fresh",
        });
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        yield* runInitialSweep;

        assert.equal(harness.stopSession.mock.calls.length, 0);
        const remaining = yield* repository.getByThreadId({ threadId });
        assert.isTrue(Option.isSome(remaining));
      }),
    );
  });

  it.effect("skips persisted sessions that are already marked stopped", () => {
    const threadId = ThreadId.make("thread-reaper-stopped");
    const harness = createHarness({
      readModel: makeReadModel([
        {
          id: threadId,
          session: {
            threadId,
            status: "stopped",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: TEST_NOW_ISO,
          },
        },
      ]),
    });

    return runWithHarness(
      harness,
      Effect.gen(function* () {
        yield* seedSession({
          threadId,
          providerName: "claudeAgent",
          status: "stopped",
          lastSeenAt: STALE_LAST_SEEN_AT,
          resumeOpaque: "resume-stopped",
        });
        const repository = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
        yield* runInitialSweep;

        assert.equal(harness.stopSession.mock.calls.length, 0);
        const remaining = yield* repository.getByThreadId({ threadId });
        assert.isTrue(Option.isSome(remaining));
      }),
    );
  });

  it.effect("continues reaping other sessions when one stop attempt fails", () => {
    const failedThreadId = ThreadId.make("thread-reaper-stop-failure");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-success");
    const harness = createHarness({
      readModel: makeReadModel([
        {
          id: failedThreadId,
          session: {
            threadId: failedThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: TEST_NOW_ISO,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: TEST_NOW_ISO,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === failedThreadId
          ? Effect.fail(
              new ProviderValidationError({
                operation: "ProviderSessionReaper.test",
                issue: "simulated stop failure",
              }),
            )
          : Effect.void,
    });

    return runWithHarness(
      harness,
      Effect.gen(function* () {
        yield* seedSession({
          threadId: failedThreadId,
          providerName: "claudeAgent",
          lastSeenAt: STALE_LAST_SEEN_AT,
          resumeOpaque: "resume-failure",
        });
        yield* seedSession({
          threadId: reapedThreadId,
          providerName: "codex",
          lastSeenAt: STALE_LAST_SEEN_AT,
          resumeOpaque: "resume-success",
        });
        yield* runInitialSweep;

        assert.deepStrictEqual(
          harness.stopSession.mock.calls.map(([request]) => request.threadId),
          [failedThreadId, reapedThreadId],
        );
      }),
    );
  });

  it.effect("continues reaping other sessions when one stop attempt defects", () => {
    const defectThreadId = ThreadId.make("thread-reaper-stop-defect");
    const reapedThreadId = ThreadId.make("thread-reaper-stop-after-defect");
    const harness = createHarness({
      readModel: makeReadModel([
        {
          id: defectThreadId,
          session: {
            threadId: defectThreadId,
            status: "ready",
            providerName: "claudeAgent",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: TEST_NOW_ISO,
          },
        },
        {
          id: reapedThreadId,
          session: {
            threadId: reapedThreadId,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: TEST_NOW_ISO,
          },
        },
      ]),
      stopSessionImplementation: (request) =>
        request.threadId === defectThreadId
          ? Effect.die(new Error("simulated stop defect"))
          : Effect.void,
    });

    return runWithHarness(
      harness,
      Effect.gen(function* () {
        yield* seedSession({
          threadId: defectThreadId,
          providerName: "claudeAgent",
          lastSeenAt: STALE_LAST_SEEN_AT,
          resumeOpaque: "resume-defect",
        });
        yield* seedSession({
          threadId: reapedThreadId,
          providerName: "codex",
          lastSeenAt: STALE_LAST_SEEN_AT,
          resumeOpaque: "resume-after-defect",
        });
        yield* runInitialSweep;

        assert.deepStrictEqual(
          harness.stopSession.mock.calls.map(([request]) => request.threadId),
          [defectThreadId, reapedThreadId],
        );
      }),
    );
  });
});
