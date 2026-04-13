import type {
  EnvironmentId,
  OrchestrationEvent,
  OrchestrationReadModel,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  TerminalEvent,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Option from "effect/Option";
import { pipe } from "effect/Function";

import type { KnownEnvironment } from "./knownEnvironment";
import type { WsRpcClient } from "./wsRpcClient";

type OrchestrationRecoveryReason = "bootstrap" | "replay-failed" | "resubscribe" | "sequence-gap";

interface OrchestrationRecoveryPhase {
  readonly kind: "snapshot" | "replay";
  readonly reason: OrchestrationRecoveryReason;
}

interface OrchestrationRecoveryState {
  readonly latestSequence: number;
  readonly highestObservedSequence: number;
  readonly bootstrapped: boolean;
  readonly pendingReplay: boolean;
  readonly inFlight: OrchestrationRecoveryPhase | null;
}

interface ReplayRecoveryCompletion {
  readonly replayMadeProgress: boolean;
  readonly shouldReplay: boolean;
}

interface ReplayRetryTracker {
  readonly attempts: number;
  readonly latestSequence: number;
  readonly highestObservedSequence: number;
}

const REPLAY_RECOVERY_RETRY_DELAY_MS = 100;
const MAX_NO_PROGRESS_REPLAY_RETRIES = 3;

export interface EnvironmentConnection {
  readonly kind: "primary" | "saved";
  readonly environmentId: EnvironmentId;
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly ensureBootstrapped: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface OrchestrationHandlers {
  readonly applyEventBatch: (
    events: ReadonlyArray<OrchestrationEvent>,
    environmentId: EnvironmentId,
  ) => void;
  readonly syncSnapshot: (snapshot: OrchestrationReadModel, environmentId: EnvironmentId) => void;
  readonly applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => void;
}

interface EnvironmentConnectionInput extends OrchestrationHandlers {
  readonly kind: "primary" | "saved";
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly refreshMetadata?: () => Promise<void>;
  readonly onConfigSnapshot?: (config: ServerConfig) => void;
  readonly onWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
}

function createOrchestrationRecoveryCoordinator() {
  let state: OrchestrationRecoveryState = {
    latestSequence: 0,
    highestObservedSequence: 0,
    bootstrapped: false,
    pendingReplay: false,
    inFlight: null,
  };
  let replayStartSequence: number | null = null;

  const snapshotState = (): OrchestrationRecoveryState => ({
    ...state,
    ...(state.inFlight ? { inFlight: { ...state.inFlight } } : {}),
  });

  const observeSequence = (sequence: number) => {
    state = {
      ...state,
      highestObservedSequence: Math.max(state.highestObservedSequence, sequence),
    };
  };

  const resolveReplayNeedAfterRecovery = () => {
    const pendingReplayBeforeReset = state.pendingReplay;
    const observedAhead = state.highestObservedSequence > state.latestSequence;
    const shouldReplay = pendingReplayBeforeReset || observedAhead;
    state = {
      ...state,
      pendingReplay: false,
    };
    return {
      shouldReplay,
      pendingReplayBeforeReset,
      observedAhead,
    };
  };

  return {
    getState(): OrchestrationRecoveryState {
      return snapshotState();
    },

    classifyDomainEvent(sequence: number): "ignore" | "defer" | "recover" | "apply" {
      observeSequence(sequence);
      if (sequence <= state.latestSequence) {
        return "ignore";
      }

      if (!state.bootstrapped || state.inFlight) {
        state = {
          ...state,
          pendingReplay: true,
        };
        return "defer";
      }

      if (sequence !== state.latestSequence + 1) {
        state = {
          ...state,
          pendingReplay: true,
        };
        return "recover";
      }

      return "apply";
    },

    markEventBatchApplied<T extends Readonly<{ sequence: number }>>(
      events: ReadonlyArray<T>,
    ): ReadonlyArray<T> {
      const nextEvents = pipe(
        events,
        Arr.filter((event) => event.sequence > state.latestSequence),
        Arr.sortWith((event) => event.sequence, Order.Number),
      );
      if (nextEvents.length === 0) {
        return [];
      }

      const latestSequence = Arr.last(nextEvents).pipe(
        Option.map((event) => event.sequence),
        Option.getOrElse(() => state.latestSequence),
      );

      state = {
        ...state,
        latestSequence,
        highestObservedSequence: Math.max(state.highestObservedSequence, latestSequence),
      };
      return nextEvents;
    },

    beginSnapshotRecovery(reason: OrchestrationRecoveryReason): boolean {
      if (state.inFlight?.kind === "snapshot" || state.inFlight?.kind === "replay") {
        state = {
          ...state,
          pendingReplay: true,
        };
        return false;
      }

      state = {
        ...state,
        inFlight: { kind: "snapshot", reason },
      };
      return true;
    },

    completeSnapshotRecovery(snapshotSequence: number): boolean {
      state = {
        ...state,
        latestSequence: Math.max(state.latestSequence, snapshotSequence),
        highestObservedSequence: Math.max(
          state.highestObservedSequence,
          Math.max(state.latestSequence, snapshotSequence),
        ),
        bootstrapped: true,
        inFlight: null,
      };
      return resolveReplayNeedAfterRecovery().shouldReplay;
    },

    failSnapshotRecovery() {
      state = {
        ...state,
        inFlight: null,
      };
    },

    beginReplayRecovery(reason: OrchestrationRecoveryReason): boolean {
      if (!state.bootstrapped || state.inFlight?.kind === "snapshot") {
        state = {
          ...state,
          pendingReplay: true,
        };
        return false;
      }

      state = {
        ...state,
        pendingReplay: false,
        inFlight: { kind: "replay", reason },
      };
      replayStartSequence = state.latestSequence;
      return true;
    },

    completeReplayRecovery(): ReplayRecoveryCompletion {
      const replayMadeProgress =
        replayStartSequence !== null && state.latestSequence > replayStartSequence;
      replayStartSequence = null;
      state = {
        ...state,
        inFlight: null,
      };
      const replayResolution = resolveReplayNeedAfterRecovery();
      return {
        replayMadeProgress,
        shouldReplay: replayResolution.shouldReplay,
      };
    },

    failReplayRecovery() {
      state = {
        ...state,
        bootstrapped: false,
        inFlight: null,
      };
      replayStartSequence = null;
    },
  };
}

function deriveReplayRetryDecision(input: {
  readonly previousTracker: ReplayRetryTracker | null;
  readonly completion: ReplayRecoveryCompletion;
  readonly recoveryState: Pick<
    OrchestrationRecoveryState,
    "latestSequence" | "highestObservedSequence"
  >;
  readonly baseDelayMs: number;
  readonly maxNoProgressRetries: number;
}): {
  readonly shouldRetry: boolean;
  readonly delayMs: number;
  readonly tracker: ReplayRetryTracker | null;
} {
  if (!input.completion.shouldReplay) {
    return {
      shouldRetry: false,
      delayMs: 0,
      tracker: null,
    };
  }

  if (input.completion.replayMadeProgress) {
    return {
      shouldRetry: true,
      delayMs: 0,
      tracker: null,
    };
  }

  const previousTracker = input.previousTracker;
  const sameFrontier =
    previousTracker !== null &&
    previousTracker.latestSequence === input.recoveryState.latestSequence &&
    previousTracker.highestObservedSequence === input.recoveryState.highestObservedSequence;

  const attempts = sameFrontier && previousTracker !== null ? previousTracker.attempts + 1 : 1;
  if (attempts > input.maxNoProgressRetries) {
    return {
      shouldRetry: false,
      delayMs: 0,
      tracker: null,
    };
  }

  return {
    shouldRetry: true,
    delayMs: input.baseDelayMs * 2 ** (attempts - 1),
    tracker: {
      attempts,
      latestSequence: input.recoveryState.latestSequence,
      highestObservedSequence: input.recoveryState.highestObservedSequence,
    },
  };
}

function createSnapshotBootstrapController(input: {
  readonly isBootstrapped: () => boolean;
  readonly runSnapshotRecovery: (
    reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
  ) => Promise<void>;
}) {
  let inFlight: Promise<void> | null = null;

  return {
    ensureSnapshotRecovery(
      reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
    ): Promise<void> {
      if (input.isBootstrapped()) {
        return Promise.resolve();
      }

      if (inFlight !== null) {
        return inFlight;
      }

      const nextInFlight = input.runSnapshotRecovery(reason).finally(() => {
        if (inFlight === nextInFlight) {
          inFlight = null;
        }
      });
      inFlight = nextInFlight;
      return nextInFlight;
    },
  };
}

export function createEnvironmentConnection(
  input: EnvironmentConnectionInput,
): EnvironmentConnection {
  const recovery = createOrchestrationRecoveryCoordinator();
  let replayRetryTracker: ReplayRetryTracker | null = null;
  const pendingDomainEvents: OrchestrationEvent[] = [];
  let flushPendingDomainEventsScheduled = false;
  const environmentId = input.knownEnvironment.environmentId;

  if (!environmentId) {
    throw new Error(
      `Known environment ${input.knownEnvironment.label} is missing its environmentId.`,
    );
  }

  let disposed = false;

  const observeEnvironmentIdentity = (nextEnvironmentId: EnvironmentId, source: string) => {
    if (environmentId !== nextEnvironmentId) {
      throw new Error(
        `Environment connection ${environmentId} changed identity to ${nextEnvironmentId} via ${source}.`,
      );
    }
  };

  const flushPendingDomainEvents = () => {
    flushPendingDomainEventsScheduled = false;
    if (disposed || pendingDomainEvents.length === 0) {
      return;
    }

    const events = pendingDomainEvents.splice(0, pendingDomainEvents.length);
    const nextEvents = recovery.markEventBatchApplied(events);
    if (nextEvents.length === 0) {
      return;
    }

    input.applyEventBatch(nextEvents, environmentId);
  };

  const schedulePendingDomainEventFlush = () => {
    if (flushPendingDomainEventsScheduled) {
      return;
    }

    flushPendingDomainEventsScheduled = true;
    queueMicrotask(flushPendingDomainEvents);
  };

  const runReplayRecovery = async (
    reason: Extract<OrchestrationRecoveryReason, "sequence-gap" | "resubscribe">,
  ): Promise<void> => {
    if (!recovery.beginReplayRecovery(reason)) {
      return;
    }

    const fromSequenceExclusive = recovery.getState().latestSequence;
    try {
      const events = await input.client.orchestration.replayEvents({ fromSequenceExclusive });
      if (!disposed) {
        const nextEvents = recovery.markEventBatchApplied(events);
        if (nextEvents.length > 0) {
          input.applyEventBatch(nextEvents, environmentId);
        }
      }
    } catch {
      replayRetryTracker = null;
      recovery.failReplayRecovery();
      await snapshotBootstrap.ensureSnapshotRecovery("replay-failed");
      return;
    }

    if (disposed) {
      return;
    }

    const replayCompletion = recovery.completeReplayRecovery();
    const retryDecision = deriveReplayRetryDecision({
      previousTracker: replayRetryTracker,
      completion: replayCompletion,
      recoveryState: recovery.getState(),
      baseDelayMs: REPLAY_RECOVERY_RETRY_DELAY_MS,
      maxNoProgressRetries: MAX_NO_PROGRESS_REPLAY_RETRIES,
    });
    replayRetryTracker = retryDecision.tracker;

    if (!retryDecision.shouldRetry) {
      return;
    }

    if (retryDecision.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, retryDecision.delayMs);
      });
      if (disposed) {
        return;
      }
    }

    void runReplayRecovery(reason);
  };

  const runSnapshotRecovery = async (
    reason: Extract<OrchestrationRecoveryReason, "bootstrap" | "replay-failed">,
  ): Promise<void> => {
    const started = recovery.beginSnapshotRecovery(reason);
    if (!started) {
      return;
    }

    try {
      const snapshot = await input.client.orchestration.getSnapshot();
      if (!disposed) {
        input.syncSnapshot(snapshot, environmentId);
        if (recovery.completeSnapshotRecovery(snapshot.snapshotSequence)) {
          void runReplayRecovery("sequence-gap");
        }
      }
    } catch (error) {
      recovery.failSnapshotRecovery();
      throw error;
    }
  };

  const snapshotBootstrap = createSnapshotBootstrapController({
    isBootstrapped: () => recovery.getState().bootstrapped,
    runSnapshotRecovery,
  });

  const unsubLifecycle = input.client.server.subscribeLifecycle((event) => {
    if (event.type !== "welcome") {
      return;
    }

    observeEnvironmentIdentity(event.payload.environment.environmentId, "server lifecycle welcome");
    input.onWelcome?.(event.payload);
  });

  const unsubConfig = input.client.server.subscribeConfig((event) => {
    if (event.type !== "snapshot") {
      return;
    }

    observeEnvironmentIdentity(event.config.environment.environmentId, "server config snapshot");
    input.onConfigSnapshot?.(event.config);
  });

  const unsubDomainEvent = input.client.orchestration.onDomainEvent(
    (event) => {
      const action = recovery.classifyDomainEvent(event.sequence);
      if (action === "apply") {
        pendingDomainEvents.push(event);
        schedulePendingDomainEventFlush();
        return;
      }

      if (action === "ignore" || action === "defer") {
        return;
      }

      flushPendingDomainEvents();
      void runReplayRecovery("sequence-gap");
    },
    {
      onResubscribe: () => {
        if (disposed) {
          return;
        }

        flushPendingDomainEvents();
        void runReplayRecovery("resubscribe");
      },
    },
  );

  const unsubTerminalEvent = input.client.terminal.onEvent((event) => {
    input.applyTerminalEvent(event, environmentId);
  });

  void snapshotBootstrap.ensureSnapshotRecovery("bootstrap").catch(() => undefined);

  const cleanup = () => {
    disposed = true;
    flushPendingDomainEventsScheduled = false;
    pendingDomainEvents.length = 0;
    unsubDomainEvent();
    unsubTerminalEvent();
    unsubLifecycle();
    unsubConfig();
  };

  return {
    kind: input.kind,
    environmentId,
    knownEnvironment: input.knownEnvironment,
    client: input.client,
    ensureBootstrapped: () => snapshotBootstrap.ensureSnapshotRecovery("bootstrap"),
    reconnect: async () => {
      await input.client.reconnect();
      await input.refreshMetadata?.();
      await snapshotBootstrap.ensureSnapshotRecovery("bootstrap");
    },
    dispose: async () => {
      cleanup();
      await input.client.dispose();
    },
  };
}
