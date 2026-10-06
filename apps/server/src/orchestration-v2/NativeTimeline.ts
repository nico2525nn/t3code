import {
  MessageId,
  PlanId,
  ProviderTurnId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** A native turn before T3 identity is applied; the caller assigns ordinals. */
export interface NativeTimelineTurn {
  readonly nativeTurnId: string;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly startedAt: string | undefined;
  readonly completedAt: string | undefined;
  readonly items: ReadonlyArray<NativeTimelineItem>;
}

/** The conversation-bearing subset of a provider's item vocabulary. */
export type NativeTimelineItem =
  | { readonly kind: "user_message"; readonly nativeItemId: string; readonly text: string }
  | {
      readonly kind: "assistant_message";
      readonly nativeItemId: string;
      readonly text: string;
      readonly completed: boolean;
    }
  | {
      readonly kind: "reasoning";
      readonly nativeItemId: string;
      readonly text: string;
      readonly completed: boolean;
    }
  | { readonly kind: "plan"; readonly nativeItemId: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly nativeItemId: string;
      readonly title: string | null;
      readonly toolName: string;
      readonly input: string;
      readonly completed: boolean;
    };

export interface NativeTimelinePage {
  readonly turns: ReadonlyArray<NativeTimelineTurn>;
  readonly nextCursor: string | null;
}

/** Newest 10 turns per read; a larger window belongs to paging, not the first paint. */
export const NATIVE_TIMELINE_TURN_PAGE_SIZE = 10;

/** What both snapshot paths return before native history is overlaid. */
export interface NativeTimelineSnapshot {
  readonly schemaVersion: number;
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
}

/** The provider conversation an app thread was adopted from, if any. */
export function adoptedProviderThread(
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
): OrchestrationV2ProviderThread | undefined {
  return providerThreads.find(
    (candidate) =>
      candidate.nativeThreadRef?.strength === "strong" && candidate.nativeThreadRef.nativeId,
  );
}

function nativeTurnItemId(input: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeItemId: string;
}): TurnItemId {
  return TurnItemId.make(
    `native-item:${input.driver}:${input.providerInstanceId}:${input.nativeItemId}`,
  );
}

function nativeMessageId(input: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly nativeItemId: string;
}): MessageId {
  return MessageId.make(
    `native-message:${input.driver}:${input.providerInstanceId}:${input.nativeItemId}`,
  );
}

const parseInstant = (value: string | undefined): DateTime.Utc | null =>
  value === undefined ? null : DateTime.makeUnsafe(Date.parse(value));

const TURN_STATUS = {
  completed: "completed",
  failed: "failed",
  interrupted: "cancelled",
  inProgress: "running",
} as const;

interface ProjectionContext {
  readonly thread: OrchestrationV2AppThread;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly startingOrdinal: number;
}

function toTurnItem(
  context: ProjectionContext,
  turn: NativeTimelineTurn,
  item: NativeTimelineItem,
  ordinal: number,
  at: DateTime.Utc,
): OrchestrationV2TurnItem {
  const providerTurnId = ProviderTurnId.make(turn.nativeTurnId);
  const base = {
    id: nativeTurnItemId({
      driver: context.driver,
      providerInstanceId: context.providerInstanceId,
      nativeItemId: item.nativeItemId,
    }),
    threadId: context.thread.id,
    runId: null,
    nodeId: null,
    providerThreadId: context.providerThread.id,
    providerTurnId,
    nativeItemRef: { driver: context.driver, nativeId: item.nativeItemId, strength: "strong" },
    parentItemId: null,
    ordinal,
    status: TURN_STATUS[turn.status],
    startedAt: parseInstant(turn.startedAt),
    completedAt: parseInstant(turn.completedAt),
    updatedAt: at,
    title: null,
  } as const;

  switch (item.kind) {
    case "user_message":
      return {
        ...base,
        type: "user_message",
        createdBy: "user",
        creationSource: "provider",
        messageId: nativeMessageId({
          driver: context.driver,
          providerInstanceId: context.providerInstanceId,
          nativeItemId: item.nativeItemId,
        }),
        inputIntent: "turn_start",
        text: item.text,
        attachments: [],
      };
    case "assistant_message":
      return {
        ...base,
        type: "assistant_message",
        messageId: nativeMessageId({
          driver: context.driver,
          providerInstanceId: context.providerInstanceId,
          nativeItemId: item.nativeItemId,
        }),
        text: item.text,
        streaming: !item.completed,
      };
    case "reasoning":
      return {
        ...base,
        type: "reasoning",
        text: item.text,
        streaming: !item.completed,
      };
    case "plan":
      return {
        ...base,
        type: "proposed_plan",
        planId: PlanId.make(
          `native-plan:${context.driver}:${context.providerInstanceId}:${item.nativeItemId}`,
        ),
        markdown: item.text,
        streaming: false,
      };
    case "tool":
      return {
        ...base,
        type: "command_execution",
        input: item.input,
        toolNonExecutionKind: item.toolName,
      };
  }
}

function toMessage(
  context: ProjectionContext,
  turn: NativeTimelineTurn,
  item: Extract<NativeTimelineItem, { kind: "user_message" | "assistant_message" }>,
  ordinal: number,
  at: DateTime.Utc,
) {
  return {
    id: nativeMessageId({
      driver: context.driver,
      providerInstanceId: context.providerInstanceId,
      nativeItemId: item.nativeItemId,
    }),
    threadId: context.thread.id,
    runId: null,
    nodeId: null,
    role: item.kind === "user_message" ? ("user" as const) : ("assistant" as const),
    text: item.text,
    attachments: [],
    streaming: item.kind === "assistant_message" ? !item.completed : false,
    createdBy: item.kind === "user_message" ? ("user" as const) : ("system" as const),
    creationSource: "provider" as const,
    createdAt: parseInstant(turn.startedAt) ?? at,
    updatedAt: at,
  };
}

/**
 * Overlay native turns onto a snapshot as projection rows.
 * Ids derive from the provider's own item ids, so a second read produces the
 * same rows instead of a rewritten history.
 */
export function mergeNativeTimeline(input: {
  readonly snapshot: NativeTimelineSnapshot;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly turns: ReadonlyArray<NativeTimelineTurn>;
  readonly readAt: DateTime.Utc;
}): NativeTimelineSnapshot {
  // Newest-first from the provider; a timeline reads oldest-first.
  const ordered = [...input.turns].reverse();
  const context: ProjectionContext = {
    thread: input.snapshot.projection.thread,
    providerThread: input.providerThread,
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    startingOrdinal: input.snapshot.projection.turnItems.length,
  };
  const turnItems: Array<OrchestrationV2TurnItem> = [...input.snapshot.projection.turnItems];
  const messages = [...input.snapshot.projection.messages];
  let ordinal = context.startingOrdinal;
  for (const turn of ordered) {
    for (const item of turn.items) {
      turnItems.push(toTurnItem(context, turn, item, ordinal, input.readAt));
      ordinal += 1;
      if (item.kind === "user_message" || item.kind === "assistant_message") {
        messages.push(toMessage(context, turn, item, ordinal, input.readAt));
      }
    }
  }
  return {
    ...input.snapshot,
    projection: { ...input.snapshot.projection, turnItems, messages },
  };
}
