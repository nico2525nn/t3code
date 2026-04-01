import {
  EventId,
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeSessionId,
  TurnId,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  type ProviderUserInputAnswers,
  type ThreadId,
} from "@t3tools/contracts";
import { Effect, Queue, Stream } from "effect";

import {
  getPerfProviderScenario,
  type PerfProviderScenario,
  type TimedFixtureProviderRuntimeEvent,
} from "@t3tools/shared/perf/scenarioCatalog";
import {
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../provider/Errors.ts";
import type {
  ProviderAdapterShape,
  ProviderThreadSnapshot,
  ProviderThreadTurnSnapshot,
} from "../provider/Services/ProviderAdapter.ts";
import { getPerfProviderScenarioId } from "./config.ts";

interface PerfSessionState {
  session: ProviderSession;
  snapshot: ProviderThreadSnapshot;
  turnCount: number;
  pendingTimers: Set<ReturnType<typeof setTimeout>>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function sessionNotFound(threadId: ThreadId): ProviderAdapterSessionNotFoundError {
  return new ProviderAdapterSessionNotFoundError({
    provider: "codex",
    threadId: String(threadId),
  });
}

function resolvePerfScenario(inputText: string | undefined): PerfProviderScenario {
  const scenarioId = getPerfProviderScenarioId();
  if (scenarioId) {
    return getPerfProviderScenario(scenarioId);
  }

  const trimmedInput = inputText?.trim() || "perf request";
  return {
    id: "dense_assistant_stream",
    provider: "codex",
    sentinelText: `PERF_STREAM_SENTINEL:fallback:${trimmedInput}`,
    totalDurationMs: 48,
    events: [
      {
        delayMs: 0,
        type: "turn.started",
        payload: {
          model: "gpt-5.4",
        },
      },
      {
        delayMs: 16,
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: `Perf fallback response for: ${trimmedInput}. `,
        },
      },
      {
        delayMs: 32,
        type: "content.delta",
        payload: {
          streamKind: "assistant_text",
          delta: `PERF_STREAM_SENTINEL:fallback:${trimmedInput}`,
        },
      },
      {
        delayMs: 48,
        type: "turn.completed",
        payload: {
          state: "completed",
        },
      },
    ],
  };
}

function toIdleSession(session: ProviderSession, updatedAt: string): ProviderSession {
  const { activeTurnId: _activeTurnId, ...rest } = session;
  return {
    ...rest,
    status: "ready",
    updatedAt,
  };
}

function buildRuntimeEvent(input: {
  readonly template: TimedFixtureProviderRuntimeEvent;
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly startedAtMs: number;
  readonly index: number;
}): ProviderRuntimeEvent {
  const createdAt = new Date(input.startedAtMs + (input.template.delayMs ?? 0)).toISOString();
  return {
    type: input.template.type,
    eventId: EventId.makeUnsafe(
      `perf-runtime:${String(input.threadId)}:${String(input.turnId)}:${input.index.toString().padStart(4, "0")}`,
    ),
    provider: "codex",
    threadId: input.threadId,
    turnId: input.turnId,
    createdAt,
    ...(input.template.itemId ? { itemId: RuntimeItemId.makeUnsafe(input.template.itemId) } : {}),
    ...(input.template.requestId
      ? { requestId: RuntimeRequestId.makeUnsafe(input.template.requestId) }
      : {}),
    payload: input.template.payload,
  } as ProviderRuntimeEvent;
}

export const makePerfProviderAdapter = Effect.gen(function* () {
  const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
  const sessions = new Map<ThreadId, PerfSessionState>();

  const clearPendingTimers = (threadId: ThreadId) =>
    Effect.sync(() => {
      const state = sessions.get(threadId);
      if (!state) {
        return;
      }
      for (const timer of state.pendingTimers) {
        clearTimeout(timer);
      }
      state.pendingTimers.clear();
    });

  const scheduleRuntimeEvent = (input: {
    readonly state: PerfSessionState;
    readonly event: ProviderRuntimeEvent;
    readonly delayMs: number;
    readonly onAfterEmit?: () => void;
  }) =>
    Effect.sync(() => {
      const timer = setTimeout(() => {
        input.state.pendingTimers.delete(timer);
        Effect.runFork(
          Queue.offer(runtimeEvents, input.event).pipe(
            Effect.tap(() => Effect.sync(() => input.onAfterEmit?.())),
            Effect.asVoid,
          ),
        );
      }, input.delayMs);
      input.state.pendingTimers.add(timer);
    });

  const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (
    input: ProviderSessionStartInput,
  ) =>
    Effect.gen(function* () {
      if (input.provider !== undefined && input.provider !== "codex") {
        return yield* new ProviderAdapterValidationError({
          provider: "codex",
          operation: "startSession",
          issue: `Perf provider only supports codex sessions, received '${input.provider}'.`,
        });
      }

      const createdAt = nowIso();
      const session: ProviderSession = {
        provider: "codex",
        status: "ready",
        runtimeMode: input.runtimeMode,
        threadId: input.threadId,
        ...(input.cwd ? { cwd: input.cwd } : {}),
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        resumeCursor:
          input.resumeCursor ??
          RuntimeSessionId.makeUnsafe(`perf-resume:${String(input.threadId)}:${Date.now()}`),
        createdAt,
        updatedAt: createdAt,
      };

      sessions.set(input.threadId, {
        session,
        snapshot: {
          threadId: input.threadId,
          turns: [],
        },
        turnCount: 0,
        pendingTimers: new Set(),
      });

      return session;
    });

  const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (
    input: ProviderSendTurnInput,
  ) =>
    Effect.gen(function* () {
      const state = sessions.get(input.threadId);
      if (!state) {
        return yield* Effect.fail(sessionNotFound(input.threadId));
      }

      yield* clearPendingTimers(input.threadId);

      state.turnCount += 1;
      const turnId = TurnId.makeUnsafe(
        `perf-turn:${String(input.threadId)}:${state.turnCount.toString().padStart(4, "0")}`,
      );
      const scenario = resolvePerfScenario(input.input);
      const startedAtMs = Date.now();
      const sentAt = new Date(startedAtMs).toISOString();

      state.session = {
        ...state.session,
        status: "running",
        activeTurnId: turnId,
        updatedAt: sentAt,
      };

      const userTurnItem = {
        type: "userMessage",
        content: [{ type: "text", text: input.input ?? "" }],
      } as const;
      const nextTurn: ProviderThreadTurnSnapshot = {
        id: turnId,
        items: [userTurnItem],
      };
      state.snapshot = {
        threadId: state.snapshot.threadId,
        turns: [...state.snapshot.turns, nextTurn],
      };

      let assistantText = "";
      const updateAssistantSnapshot = (completedAt: string) => {
        state.session = toIdleSession(state.session, completedAt);
        state.snapshot = {
          threadId: state.snapshot.threadId,
          turns: state.snapshot.turns.map((turn) =>
            turn.id === turnId
              ? {
                  ...turn,
                  items:
                    assistantText.length > 0
                      ? [...turn.items, { type: "agentMessage", text: assistantText }]
                      : turn.items,
                }
              : turn,
          ),
        };
      };

      yield* Effect.forEach(
        scenario.events,
        (template, index) => {
          const event = buildRuntimeEvent({
            template,
            threadId: input.threadId,
            turnId,
            startedAtMs,
            index,
          });
          const delayMs = template.delayMs ?? 0;
          return scheduleRuntimeEvent({
            state,
            event,
            delayMs,
            onAfterEmit: () => {
              if (event.type === "content.delta" && event.payload.streamKind === "assistant_text") {
                assistantText += event.payload.delta;
              }
              if (event.type === "turn.completed") {
                updateAssistantSnapshot(event.createdAt);
              }
            },
          });
        },
        { concurrency: 1 },
      );

      return {
        threadId: input.threadId,
        turnId,
      } satisfies ProviderTurnStartResult;
    });

  const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (
    threadId,
    turnId,
  ) =>
    Effect.gen(function* () {
      const state = sessions.get(threadId);
      if (!state) {
        return yield* Effect.fail(sessionNotFound(threadId));
      }
      yield* clearPendingTimers(threadId);
      const interruptedTurnId = turnId ?? state.session.activeTurnId;
      state.session = toIdleSession(state.session, nowIso());
      if (interruptedTurnId) {
        yield* Queue.offer(runtimeEvents, {
          type: "turn.completed",
          eventId: EventId.makeUnsafe(
            `perf-runtime:${String(threadId)}:${String(interruptedTurnId)}:interrupted`,
          ),
          provider: "codex",
          threadId,
          turnId: interruptedTurnId,
          createdAt: nowIso(),
          payload: {
            state: "interrupted",
          },
        } satisfies ProviderRuntimeEvent);
      }
    });

  const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
    threadId,
    _requestId: ApprovalRequestId,
    _decision: ProviderApprovalDecision,
  ) => (sessions.has(threadId) ? Effect.void : Effect.fail(sessionNotFound(threadId)));

  const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
    threadId,
    _requestId,
    _answers: ProviderUserInputAnswers,
  ) => (sessions.has(threadId) ? Effect.void : Effect.fail(sessionNotFound(threadId)));

  const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
    Effect.gen(function* () {
      if (!sessions.has(threadId)) {
        return yield* Effect.fail(sessionNotFound(threadId));
      }
      yield* clearPendingTimers(threadId);
      sessions.delete(threadId);
    });

  const listSessions: ProviderAdapterShape<ProviderAdapterError>["listSessions"] = () =>
    Effect.sync(() => Array.from(sessions.values(), (state) => state.session));

  const hasSession: ProviderAdapterShape<ProviderAdapterError>["hasSession"] = (threadId) =>
    Effect.succeed(sessions.has(threadId));

  const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
    sessions.has(threadId)
      ? Effect.succeed(sessions.get(threadId)!.snapshot)
      : Effect.fail(sessionNotFound(threadId));

  const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
    threadId,
    numTurns,
  ) =>
    Effect.gen(function* () {
      const state = sessions.get(threadId);
      if (!state) {
        return yield* Effect.fail(sessionNotFound(threadId));
      }
      if (!Number.isInteger(numTurns) || numTurns < 0 || numTurns > state.snapshot.turns.length) {
        return yield* new ProviderAdapterValidationError({
          provider: "codex",
          operation: "rollbackThread",
          issue: "numTurns must be an integer between 0 and the current turn count.",
        });
      }
      state.snapshot = {
        threadId: state.snapshot.threadId,
        turns: state.snapshot.turns.slice(0, state.snapshot.turns.length - numTurns),
      };
      state.turnCount = state.snapshot.turns.length;
      return state.snapshot;
    });

  const stopAll: ProviderAdapterShape<ProviderAdapterError>["stopAll"] = () =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        Array.from(sessions.keys()),
        (threadId) => clearPendingTimers(threadId),
        {
          concurrency: "unbounded",
        },
      );
      sessions.clear();
    });

  return {
    provider: "codex",
    capabilities: {
      sessionModelSwitch: "in-session",
    },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    hasSession,
    readThread,
    rollbackThread,
    stopAll,
    streamEvents: Stream.fromQueue(runtimeEvents),
  } satisfies ProviderAdapterShape<ProviderAdapterError>;
});
