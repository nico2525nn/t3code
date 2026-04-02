import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CheckpointRef,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { Effect, Layer, ManagedRuntime } from "effect";

import {
  getPerfSeedScenario,
  perfEventId,
  perfMessageIdForThread,
  perfTurnIdForThread,
  type PerfSeedScenario,
  type PerfSeedScenarioId,
  type PerfSeedThreadScenario,
} from "@t3tools/shared/perf/scenarioCatalog";
import { ServerConfig } from "../../src/config.ts";
import { OrchestrationProjectionPipelineLive } from "../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationProjectionPipeline } from "../../src/orchestration/Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../../src/orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEventStoreLive } from "../../src/persistence/Layers/OrchestrationEventStore.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../../src/persistence/Layers/Sqlite.ts";
import { OrchestrationEventStore } from "../../src/persistence/Services/OrchestrationEventStore.ts";
import { ServerSettingsService, ServerSettingsLive } from "../../src/serverSettings.ts";

export interface PerfSeededState {
  readonly scenarioId: PerfSeedScenarioId;
  readonly runParentDir: string;
  readonly baseDir: string;
  readonly workspaceRoot: string;
  readonly snapshot: OrchestrationReadModel;
}

const templateDirPromises = new Map<PerfSeedScenarioId, Promise<string>>();

function runGit(cwd: string, args: ReadonlyArray<string>) {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

async function initializeGitWorkspace(workspaceRoot: string): Promise<void> {
  await mkdir(workspaceRoot, { recursive: true });
  runGit(workspaceRoot, ["init", "--initial-branch=main"]);
  runGit(workspaceRoot, ["config", "user.email", "perf@example.com"]);
  runGit(workspaceRoot, ["config", "user.name", "Perf Fixture"]);
  await writeFile(
    join(workspaceRoot, "README.md"),
    "# Performance Workspace\n\nSeeded fixture state for local perf regression tests.\n",
    "utf8",
  );
  runGit(workspaceRoot, ["add", "."]);
  runGit(workspaceRoot, ["commit", "-m", "Initial perf workspace"]);
}

function plusMs(baseTimeMs: number, offsetMs: number): string {
  return new Date(baseTimeMs + offsetMs).toISOString();
}

function makeCommandId(prefix: string, threadId: string, turnIndex: number): CommandId {
  return CommandId.makeUnsafe(`${prefix}:${threadId}:${turnIndex.toString().padStart(4, "0")}`);
}

function buildProjectEvent(
  scenario: PerfSeedScenario,
  workspaceRoot: string,
  createdAt: string,
): Omit<OrchestrationEvent, "sequence"> {
  return {
    type: "project.created",
    eventId: EventId.makeUnsafe(`perf-project-created:${String(scenario.project.id)}`),
    aggregateKind: "project",
    aggregateId: scenario.project.id,
    occurredAt: createdAt,
    commandId: CommandId.makeUnsafe(`perf-project-create:${String(scenario.project.id)}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`perf-project-create:${String(scenario.project.id)}`),
    metadata: {},
    payload: {
      projectId: scenario.project.id,
      title: scenario.project.title,
      workspaceRoot,
      defaultModelSelection: scenario.project.defaultModelSelection,
      scripts: [],
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function buildThreadCreatedEvent(
  thread: PerfSeedThreadScenario,
  scenario: PerfSeedScenario,
  createdAt: string,
): Omit<OrchestrationEvent, "sequence"> {
  return {
    type: "thread.created",
    eventId: EventId.makeUnsafe(`perf-thread-created:${String(thread.id)}`),
    aggregateKind: "thread",
    aggregateId: thread.id,
    occurredAt: createdAt,
    commandId: CommandId.makeUnsafe(`perf-thread-create:${String(thread.id)}`),
    causationEventId: null,
    correlationId: CommandId.makeUnsafe(`perf-thread-create:${String(thread.id)}`),
    metadata: {},
    payload: {
      threadId: thread.id,
      projectId: scenario.project.id,
      title: thread.title,
      modelSelection: scenario.project.defaultModelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      updatedAt: createdAt,
    },
  };
}

function buildUserMessageText(thread: PerfSeedThreadScenario, turnIndex: number): string {
  const base = `${thread.title} request ${turnIndex}: review the current workspace state and explain the next change.`;
  if (turnIndex % 11 === 0) {
    return `${base}\n\nFocus on virtualization, batching, and cross-thread navigation latency.`;
  }
  if (turnIndex % 7 === 0) {
    return `${base}\n\nSummarize CPU-sensitive paths and any websocket burst handling concerns.`;
  }
  return base;
}

function buildAssistantMessageText(thread: PerfSeedThreadScenario, turnIndex: number): string {
  const prefix = `${thread.title} response ${turnIndex}: `;
  const paragraphs = [
    "The render path stays stable when visible rows are capped and background work is batched.",
    "Navigation remains predictable when thread metadata, message slices, and work log grouping avoid unnecessary churn.",
    "Websocket-heavy turns should keep incremental UI updates small so the main thread is free for scrolling and input.",
  ];
  const paragraphCount = turnIndex % 9 === 0 ? 3 : turnIndex % 4 === 0 ? 2 : 1;
  return `${prefix}${paragraphs.slice(0, paragraphCount).join(" ")}${
    turnIndex % 13 === 0
      ? "\n\n- Keep virtual rows bounded\n- Avoid synchronous bursts\n- Preserve responsive thread switches"
      : ""
  }`;
}

function buildProposedPlanMarkdown(thread: PerfSeedThreadScenario, turnIndex: number): string {
  return [
    `## ${thread.title} plan ${turnIndex}`,
    "",
    "1. Measure the current thread switch path against a stable local budget.",
    "2. Reduce avoidable render churn in the visible timeline window.",
    "3. Validate websocket burst handling with real runtime events before tightening thresholds.",
  ].join("\n");
}

function buildCheckpointFiles(
  thread: PerfSeedThreadScenario,
  threadOrdinal: number,
  turnIndex: number,
): ReadonlyArray<{
  readonly path: string;
  readonly kind: string;
  readonly additions: number;
  readonly deletions: number;
}> {
  const nestedPathTemplates = [
    ["apps", "web", "src", "components", `thread-${threadOrdinal + 1}`, "TimelineVirtualizer.tsx"],
    ["apps", "web", "src", "components", `thread-${threadOrdinal + 1}`, "ThreadSummaryPane.tsx"],
    ["apps", "web", "src", "hooks", `thread-${threadOrdinal + 1}`, "useThreadViewport.ts"],
    ["apps", "web", "src", "stores", `thread-${threadOrdinal + 1}`, "timelineStore.ts"],
    [
      "apps",
      "server",
      "src",
      "orchestration",
      `thread-${threadOrdinal + 1}`,
      "projectionPipeline.ts",
    ],
    ["apps", "server", "src", "provider", `thread-${threadOrdinal + 1}`, "runtimeBuffer.ts"],
    ["packages", "shared", "src", "perf", `thread-${threadOrdinal + 1}`, "fixtureBuilders.ts"],
    ["packages", "shared", "src", "perf", `thread-${threadOrdinal + 1}`, "scenarioCatalog.ts"],
    ["packages", "contracts", "src", "orchestration", `thread-${threadOrdinal + 1}`, "schemas.ts"],
    ["docs", "perf", `thread-${threadOrdinal + 1}`, "notes", "regression-findings.md"],
    ["scripts", "perf", `thread-${threadOrdinal + 1}`, "capture-profile.ts"],
    ["test", "perf", "fixtures", `thread-${threadOrdinal + 1}`, "workspace-state.json"],
  ] as const;
  const fileCount = thread.category === "heavy" ? 12 + (turnIndex % 7) : 7 + (turnIndex % 4);

  return Array.from({ length: fileCount }, (_, fileIndex) => {
    const template = nestedPathTemplates[fileIndex % nestedPathTemplates.length]!;
    const variant = Math.floor(fileIndex / nestedPathTemplates.length);
    const baseSegments = [...template];
    const fileName = baseSegments.pop()!;
    const variantFileName =
      variant === 0
        ? fileName
        : fileName.replace(/(\.[^.]*)$/, `-${(variant + 1).toString().padStart(2, "0")}$1`);
    const path = [...baseSegments, variantFileName].join("/");
    const kind =
      fileIndex % 9 === 0
        ? "deleted"
        : fileIndex % 5 === 0
          ? "added"
          : fileIndex % 4 === 0
            ? "renamed"
            : "modified";

    return {
      path,
      kind,
      additions: kind === "deleted" ? 0 : 4 + ((turnIndex + fileIndex) % 11),
      deletions: kind === "added" ? 0 : 1 + ((threadOrdinal + fileIndex + turnIndex) % 6),
    };
  });
}

function buildThreadTurnEvents(
  scenario: PerfSeedScenario,
  thread: PerfSeedThreadScenario,
  threadOrdinal: number,
  projectStartMs: number,
): ReadonlyArray<Omit<OrchestrationEvent, "sequence">> {
  const events: Array<Omit<OrchestrationEvent, "sequence">> = [];
  const threadStartMs = projectStartMs + threadOrdinal * 60_000;

  for (let turnIndex = 1; turnIndex <= thread.turnCount; turnIndex += 1) {
    const turnId = perfTurnIdForThread(thread, turnIndex);
    const userMessageId = perfMessageIdForThread(thread, "user", turnIndex);
    const assistantMessageId = perfMessageIdForThread(thread, "assistant", turnIndex);
    const turnBaseMs = threadStartMs + turnIndex * 1_000;
    const userOccurredAt = plusMs(turnBaseMs, 0);
    const assistantOccurredAt = plusMs(turnBaseMs, 320);

    events.push({
      type: "thread.message-sent",
      eventId: perfEventId("perf-user-message", thread.id, turnIndex * 10),
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: userOccurredAt,
      commandId: makeCommandId("perf-user-message", String(thread.id), turnIndex),
      causationEventId: null,
      correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
      metadata: {},
      payload: {
        threadId: thread.id,
        messageId: userMessageId,
        role: "user",
        text: buildUserMessageText(thread, turnIndex),
        attachments: [],
        turnId,
        streaming: false,
        createdAt: userOccurredAt,
        updatedAt: userOccurredAt,
      },
    });

    events.push({
      type: "thread.message-sent",
      eventId: perfEventId("perf-assistant-message", thread.id, turnIndex * 10 + 1),
      aggregateKind: "thread",
      aggregateId: thread.id,
      occurredAt: assistantOccurredAt,
      commandId: makeCommandId("perf-assistant-message", String(thread.id), turnIndex),
      causationEventId: null,
      correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
      metadata: {},
      payload: {
        threadId: thread.id,
        messageId: assistantMessageId,
        role: "assistant",
        text: buildAssistantMessageText(thread, turnIndex),
        attachments: [],
        turnId,
        streaming: false,
        createdAt: assistantOccurredAt,
        updatedAt: assistantOccurredAt,
      },
    });

    if (thread.activityStride !== null && turnIndex % thread.activityStride === 0) {
      const activityOccurredAt = plusMs(turnBaseMs, 520);
      events.push({
        type: "thread.activity-appended",
        eventId: perfEventId("perf-activity", thread.id, turnIndex * 10 + 2),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: activityOccurredAt,
        commandId: makeCommandId("perf-activity", String(thread.id), turnIndex),
        causationEventId: null,
        correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
        metadata: {},
        payload: {
          threadId: thread.id,
          activity: {
            id: perfEventId("perf-activity-row", thread.id, turnIndex),
            tone: "tool",
            kind: "tool.completed",
            summary: `Synthetic command batch ${turnIndex}`,
            payload: {
              command: "perf-simulated",
              batch: turnIndex,
              threadCategory: thread.category,
            },
            turnId,
            createdAt: activityOccurredAt,
          },
        },
      });
    }

    if (thread.planStride !== null && turnIndex % thread.planStride === 0) {
      const planOccurredAt = plusMs(turnBaseMs, 640);
      events.push({
        type: "thread.proposed-plan-upserted",
        eventId: perfEventId("perf-plan", thread.id, turnIndex * 10 + 3),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: planOccurredAt,
        commandId: makeCommandId("perf-plan", String(thread.id), turnIndex),
        causationEventId: null,
        correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
        metadata: {},
        payload: {
          threadId: thread.id,
          proposedPlan: {
            id: `perf-plan:${String(thread.id)}:${turnIndex.toString().padStart(4, "0")}`,
            turnId,
            planMarkdown: buildProposedPlanMarkdown(thread, turnIndex),
            implementedAt: null,
            implementationThreadId: null,
            createdAt: planOccurredAt,
            updatedAt: planOccurredAt,
          },
        },
      });
    }

    if (thread.diffStride !== null && turnIndex % thread.diffStride === 0) {
      const diffOccurredAt = plusMs(turnBaseMs, 760);
      events.push({
        type: "thread.turn-diff-completed",
        eventId: perfEventId("perf-diff", thread.id, turnIndex * 10 + 4),
        aggregateKind: "thread",
        aggregateId: thread.id,
        occurredAt: diffOccurredAt,
        commandId: makeCommandId("perf-diff", String(thread.id), turnIndex),
        causationEventId: null,
        correlationId: makeCommandId("perf-turn", String(thread.id), turnIndex),
        metadata: {},
        payload: {
          threadId: thread.id,
          turnId,
          checkpointTurnCount: turnIndex,
          checkpointRef: CheckpointRef.makeUnsafe(
            `refs/perf/${String(thread.id)}/${turnIndex.toString().padStart(4, "0")}`,
          ),
          status: "ready",
          files: buildCheckpointFiles(thread, threadOrdinal, turnIndex),
          assistantMessageId,
          completedAt: diffOccurredAt,
        },
      });
    }
  }

  return events;
}

function buildScenarioEvents(
  scenario: PerfSeedScenario,
  workspaceRoot: string,
): ReadonlyArray<Omit<OrchestrationEvent, "sequence">> {
  const projectStartMs = Date.parse("2026-03-01T12:00:00.000Z");
  const projectCreatedAt = plusMs(projectStartMs, 0);
  return [
    buildProjectEvent(scenario, workspaceRoot, projectCreatedAt),
    ...scenario.threads.flatMap((thread, threadOrdinal) => {
      const threadCreatedAt = plusMs(projectStartMs, threadOrdinal * 60_000 + 50);
      return [
        buildThreadCreatedEvent(thread, scenario, threadCreatedAt),
        ...buildThreadTurnEvents(scenario, thread, threadOrdinal, projectStartMs),
      ];
    }),
  ];
}

async function createTemplateDir(scenarioId: PerfSeedScenarioId): Promise<string> {
  const scenario = getPerfSeedScenario(scenarioId);
  const baseDir = await mkdtemp(join(tmpdir(), `t3-perf-template-${scenarioId}-`));
  const workspaceRoot = join(baseDir, scenario.project.workspaceDirectoryName);
  await initializeGitWorkspace(workspaceRoot);

  const seedLayer = Layer.empty.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provideMerge(OrchestrationEventStoreLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(SqlitePersistenceLayerLive),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(seedLayer);

  const snapshot = await runtime.runPromise(
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const eventStore = yield* OrchestrationEventStore;
      const projectionPipeline = yield* OrchestrationProjectionPipeline;
      const snapshotQuery = yield* ProjectionSnapshotQuery;

      yield* serverSettings.updateSettings({
        enableAssistantStreaming: scenario.id === "burst_base",
      });

      for (const event of buildScenarioEvents(scenario, workspaceRoot)) {
        const storedEvent = yield* eventStore.append(event);
        yield* projectionPipeline.projectEvent(storedEvent);
      }

      return yield* snapshotQuery.getSnapshot();
    }),
  );

  const manifestPath = join(baseDir, "perf-seed-manifest.json");
  await writeFile(
    manifestPath,
    `${JSON.stringify(
      {
        scenarioId,
        workspaceRoot,
        snapshotSequence: snapshot.snapshotSequence,
        projectCount: snapshot.projects.length,
        threadCount: snapshot.threads.length,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  await runtime.dispose();
  return baseDir;
}

async function getTemplateDir(scenarioId: PerfSeedScenarioId): Promise<string> {
  const existing = templateDirPromises.get(scenarioId);
  if (existing) {
    return existing;
  }
  const created = createTemplateDir(scenarioId);
  templateDirPromises.set(scenarioId, created);
  return created;
}

export async function seedPerfState(scenarioId: PerfSeedScenarioId): Promise<PerfSeededState> {
  const scenario = getPerfSeedScenario(scenarioId);
  const templateDir = await getTemplateDir(scenarioId);
  const runParentDir = await mkdtemp(join(tmpdir(), `t3-perf-run-${scenarioId}-`));
  const baseDir = join(runParentDir, "base");
  await cp(templateDir, baseDir, { recursive: true, force: true });
  const workspaceRoot = join(baseDir, scenario.project.workspaceDirectoryName);

  const snapshotLayer = Layer.empty.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provideMerge(ServerSettingsLive),
    Layer.provideMerge(SqlitePersistenceLayerLive),
    Layer.provideMerge(ServerConfig.layerTest(workspaceRoot, baseDir)),
    Layer.provideMerge(NodeServices.layer),
  );
  const runtime = ManagedRuntime.make(snapshotLayer);
  const snapshot = await runtime.runPromise(
    Effect.gen(function* () {
      const snapshotQuery = yield* ProjectionSnapshotQuery;
      return yield* snapshotQuery.getSnapshot();
    }),
  );
  await runtime.dispose();

  return {
    scenarioId,
    runParentDir,
    baseDir,
    workspaceRoot,
    snapshot,
  };
}
