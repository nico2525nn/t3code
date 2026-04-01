import {
  DEFAULT_MODEL_BY_PROVIDER,
  EventId,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type ProviderKind,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

export type PerfSeedScenarioId = "large_threads" | "burst_base";
export type PerfProviderScenarioId = "dense_assistant_stream";
export type PerfScenarioId = PerfSeedScenarioId | PerfProviderScenarioId;

export interface PerfProjectScenario {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceDirectoryName: string;
  readonly defaultModelSelection: ModelSelection;
}

export interface PerfSeedThreadScenario {
  readonly id: ThreadId;
  readonly title: string;
  readonly category: "heavy" | "burst" | "light";
  readonly turnCount: number;
  readonly messageCount: number;
  readonly anchorMessageId: MessageId;
  readonly terminalMessageId: MessageId;
  readonly planStride: number | null;
  readonly activityStride: number | null;
  readonly diffStride: number | null;
}

export interface PerfSeedScenario {
  readonly id: PerfSeedScenarioId;
  readonly project: PerfProjectScenario;
  readonly threads: ReadonlyArray<PerfSeedThreadScenario>;
}

export interface TimedFixtureProviderRuntimeEvent {
  readonly delayMs?: number;
  readonly type: ProviderRuntimeEvent["type"];
  readonly itemId?: string;
  readonly requestId?: string;
  readonly payload: unknown;
}

export interface PerfProviderScenario {
  readonly id: PerfProviderScenarioId;
  readonly provider: ProviderKind;
  readonly sentinelText: string;
  readonly totalDurationMs: number;
  readonly events: ReadonlyArray<TimedFixtureProviderRuntimeEvent>;
}

const PERF_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  model: DEFAULT_MODEL_BY_PROVIDER.codex,
};

const PERF_PROJECT: PerfProjectScenario = {
  id: ProjectId.makeUnsafe("perf-project-primary"),
  title: "Performance Workspace",
  workspaceDirectoryName: "perf-workspace",
  defaultModelSelection: PERF_MODEL_SELECTION,
};

const makeThreadId = (slug: string) => ThreadId.makeUnsafe(`perf-thread-${slug}`);
const makeTurnId = (threadSlug: string, index: number) =>
  TurnId.makeUnsafe(`perf-turn-${threadSlug}-${index.toString().padStart(4, "0")}`);
const makeMessageId = (threadSlug: string, role: "user" | "assistant", index: number) =>
  MessageId.makeUnsafe(`perf-message-${threadSlug}-${role}-${index.toString().padStart(4, "0")}`);

const LARGE_THREAD_DEFINITIONS = {
  heavyA: {
    id: makeThreadId("heavy-a"),
    title: "Large Thread A",
    category: "heavy",
    turnCount: 1_000,
    messageCount: 2_000,
    anchorMessageId: makeMessageId("heavy-a", "user", 1),
    terminalMessageId: makeMessageId("heavy-a", "assistant", 1_000),
    planStride: 120,
    activityStride: 32,
    diffStride: 48,
  },
  heavyB: {
    id: makeThreadId("heavy-b"),
    title: "Large Thread B",
    category: "heavy",
    turnCount: 1_000,
    messageCount: 2_000,
    anchorMessageId: makeMessageId("heavy-b", "user", 1),
    terminalMessageId: makeMessageId("heavy-b", "assistant", 1_000),
    planStride: 125,
    activityStride: 36,
    diffStride: 54,
  },
  burst: {
    id: makeThreadId("burst"),
    title: "Burst Target Thread",
    category: "burst",
    turnCount: 120,
    messageCount: 240,
    anchorMessageId: makeMessageId("burst", "user", 1),
    terminalMessageId: makeMessageId("burst", "assistant", 120),
    planStride: 30,
    activityStride: 10,
    diffStride: 12,
  },
} as const satisfies Record<string, PerfSeedThreadScenario>;

const LIGHT_THREADS: ReadonlyArray<PerfSeedThreadScenario> = Array.from(
  { length: 9 },
  (_, index) => {
    const threadNumber = index + 1;
    const slug = `light-${threadNumber.toString().padStart(2, "0")}`;
    return {
      id: makeThreadId(slug),
      title: `Light Thread ${threadNumber}`,
      category: "light",
      turnCount: 12,
      messageCount: 24,
      anchorMessageId: makeMessageId(slug, "user", 1),
      terminalMessageId: makeMessageId(slug, "assistant", 12),
      planStride: null,
      activityStride: 6,
      diffStride: null,
    } satisfies PerfSeedThreadScenario;
  },
);

const BURST_NAVIGATION_THREAD: PerfSeedThreadScenario = {
  ...LIGHT_THREADS[0]!,
  title: "Burst Navigation Thread",
};

const BURST_FILLER_THREAD: PerfSeedThreadScenario = {
  ...LIGHT_THREADS[1]!,
  title: "Burst Filler Thread",
};

export const PERF_SEED_SCENARIOS = {
  large_threads: {
    id: "large_threads",
    project: PERF_PROJECT,
    threads: [
      LARGE_THREAD_DEFINITIONS.heavyA,
      LARGE_THREAD_DEFINITIONS.heavyB,
      LARGE_THREAD_DEFINITIONS.burst,
      ...LIGHT_THREADS,
    ],
  },
  burst_base: {
    id: "burst_base",
    project: PERF_PROJECT,
    threads: [LARGE_THREAD_DEFINITIONS.burst, BURST_NAVIGATION_THREAD, BURST_FILLER_THREAD],
  },
} as const satisfies Record<PerfSeedScenarioId, PerfSeedScenario>;

const DENSE_ASSISTANT_STREAM_SENTINEL = "PERF_STREAM_SENTINEL:dense_assistant_stream:completed";

function buildAssistantChunk(index: number, totalSteps: number): string {
  if (index === totalSteps - 1) {
    return `Completed render pass. ${DENSE_ASSISTANT_STREAM_SENTINEL}`;
  }
  if (index % 11 === 0) {
    return `Scanning synthetic shard ${index}. `;
  }
  if (index % 7 === 0) {
    return `Applying websocket delta batch ${index}. `;
  }
  if (index % 5 === 0) {
    return `Recomputing viewport summary ${index}. `;
  }
  return `chunk-${index.toString().padStart(3, "0")} `;
}

function buildDenseAssistantStreamScenario(): PerfProviderScenario {
  const events: TimedFixtureProviderRuntimeEvent[] = [
    {
      delayMs: 0,
      type: "turn.started",
      payload: {
        model: DEFAULT_MODEL_BY_PROVIDER.codex,
      },
    },
  ];
  const stepCount = 200;
  for (let index = 0; index < stepCount; index += 1) {
    const stepOffsetMs = index * 15;
    const toolItemId = `perf-command-${index.toString().padStart(3, "0")}`;
    events.push({
      delayMs: stepOffsetMs + 2,
      type: "item.started",
      itemId: toolItemId,
      payload: {
        itemType: "command_execution",
        title: `Perf command ${index + 1}`,
        detail: `Simulated websocket workload ${index + 1}`,
      },
    });
    events.push({
      delayMs: stepOffsetMs + 7,
      type: "content.delta",
      payload: {
        streamKind: "assistant_text",
        delta: buildAssistantChunk(index, stepCount),
      },
    });
    events.push({
      delayMs: stepOffsetMs + 11,
      type: "item.completed",
      itemId: toolItemId,
      payload: {
        itemType: "command_execution",
        status: "completed",
        title: `Perf command ${index + 1}`,
        detail: `Simulated websocket workload ${index + 1}`,
      },
    });
  }
  events.push({
    delayMs: 3_060,
    type: "turn.completed",
    payload: {
      state: "completed",
    },
  });

  return {
    id: "dense_assistant_stream",
    provider: "codex",
    sentinelText: DENSE_ASSISTANT_STREAM_SENTINEL,
    totalDurationMs: 3_060,
    events,
  };
}

export const PERF_PROVIDER_SCENARIOS = {
  dense_assistant_stream: buildDenseAssistantStreamScenario(),
} as const satisfies Record<PerfProviderScenarioId, PerfProviderScenario>;

export const PERF_CATALOG_IDS = {
  projectId: PERF_PROJECT.id,
  largeThreads: {
    heavyAThreadId: LARGE_THREAD_DEFINITIONS.heavyA.id,
    heavyBThreadId: LARGE_THREAD_DEFINITIONS.heavyB.id,
    heavyAAnchorMessageId: LARGE_THREAD_DEFINITIONS.heavyA.anchorMessageId,
    heavyBAnchorMessageId: LARGE_THREAD_DEFINITIONS.heavyB.anchorMessageId,
    heavyATerminalMessageId: LARGE_THREAD_DEFINITIONS.heavyA.terminalMessageId,
    heavyBTerminalMessageId: LARGE_THREAD_DEFINITIONS.heavyB.terminalMessageId,
  },
  burstBase: {
    burstThreadId: LARGE_THREAD_DEFINITIONS.burst.id,
    burstAnchorMessageId: LARGE_THREAD_DEFINITIONS.burst.anchorMessageId,
    burstTerminalMessageId: LARGE_THREAD_DEFINITIONS.burst.terminalMessageId,
    navigationThreadId: BURST_NAVIGATION_THREAD.id,
    navigationAnchorMessageId: BURST_NAVIGATION_THREAD.anchorMessageId,
    navigationTerminalMessageId: BURST_NAVIGATION_THREAD.terminalMessageId,
  },
  provider: {
    denseAssistantStreamSentinel: DENSE_ASSISTANT_STREAM_SENTINEL,
  },
} as const;

export function getPerfSeedScenario(scenarioId: PerfSeedScenarioId): PerfSeedScenario {
  return PERF_SEED_SCENARIOS[scenarioId];
}

export function getPerfProviderScenario(scenarioId: PerfProviderScenarioId): PerfProviderScenario {
  return PERF_PROVIDER_SCENARIOS[scenarioId];
}

export function perfTurnIdForThread(thread: PerfSeedThreadScenario, turnIndex: number): TurnId {
  const threadSlug = thread.id.replace("perf-thread-", "");
  return makeTurnId(threadSlug, turnIndex);
}

export function perfMessageIdForThread(
  thread: PerfSeedThreadScenario,
  role: "user" | "assistant",
  turnIndex: number,
): MessageId {
  const threadSlug = thread.id.replace("perf-thread-", "");
  return makeMessageId(threadSlug, role, turnIndex);
}

export function perfEventId(prefix: string, threadId: ThreadId, index: number) {
  return EventId.makeUnsafe(`${prefix}:${threadId}:${index.toString().padStart(4, "0")}`);
}
