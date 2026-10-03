import {
  MessageId,
  PlanId,
  ProviderTurnId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderDriverKind,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

import type { NativeTimelineItem, NativeTimelineTurn } from "./NativeTimeline.ts";

/** The wire snapshot the HTTP layer reads; mirrors the orchestrator return. */
export interface NativeTimelineSnapshot {
  readonly schemaVersion: number;
  readonly snapshotSequence: number;
  readonly projection: OrchestrationV2ThreadProjection;
}

/**
 * The provider conversation an app thread was adopted from, if any.
 *
 * A thread T3 created itself has no strong native ref, so it is never
 * read through: its history is already in the projection.
 */
export function adoptedProviderThread(
  providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>,
): OrchestrationV2ProviderThread | undefined {
  return providerThreads.find(
    (candidate) =>
      candidate.nativeThreadRef?.strength === "strong" && candidate.nativeThreadRef.nativeId,
  );
}

/**
 * Deterministic ids so a refresh does not churn item identity.
 *
 * A client that keeps a thread open will read it again on reconnect. Deriving
 * the id from the provider's own item id means the second read produces the
 * same rows, so the client sees no change rather than a rewritten history.
 */
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

/**
 * Provider timestamps arrive as ISO strings. `makeUnsafe` is deliberate: these
 * come from the provider own serializer, and an unparsable value would be a
 * provider bug worth surfacing rather than a silent epoch fallback.
 */
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
  /** Ordinals of local rows, so native rows continue the sequence. */
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
    // An adopted conversation has no T3 run behind it; the provider owns it.
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
      return { ...base, type: "reasoning", text: item.text, streaming: !item.completed };
    case "plan":
      return {
        ...base,
        type: "proposed_plan",
        planId: PlanId.make(`native-plan:${item.nativeItemId}`),
        markdown: item.text,
        streaming: false,
      };
    case "tool":
      return {
        ...base,
        type: "notification",
        source: { kind: "command" },
        outcome: item.completed ? "completed" : "updated",
        summary: item.title ?? item.toolName,
      };
  }
}

function toConversationMessage(
  context: ProjectionContext,
  item: NativeTimelineItem,
  at: DateTime.Utc,
): OrchestrationV2ConversationMessage | undefined {
  if (item.kind !== "user_message" && item.kind !== "assistant_message") return undefined;
  const id = nativeMessageId({
    driver: context.driver,
    providerInstanceId: context.providerInstanceId,
    nativeItemId: item.nativeItemId,
  });
  return {
    id,
    threadId: context.thread.id,
    runId: null,
    nodeId: null,
    role: item.kind === "user_message" ? "user" : "assistant",
    text: item.text,
    attachments: [],
    streaming: item.kind === "assistant_message" ? !item.completed : false,
    createdBy: item.kind === "user_message" ? "user" : "agent",
    creationSource: "provider",
    createdAt: at,
    updatedAt: at,
  } satisfies OrchestrationV2ConversationMessage;
}

/**
 * Overlay an adopted conversation's history onto a thread snapshot.
 *
 * Local rows win on id: once T3 has run a turn on this thread its projection is
 * the record of what happened after adoption, and the native history is only
 * what came before it.
 */
export function mergeNativeTimeline(input: {
  readonly snapshot: NativeTimelineSnapshot;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly turns: ReadonlyArray<NativeTimelineTurn>;
  readonly readAt: DateTime.Utc;
}): NativeTimelineSnapshot {
  const { snapshot, providerThread, readAt } = input;
  const { projection } = snapshot;
  const existingItemIds = new Set(projection.turnItems.map((item) => String(item.id)));
  const existingMessageIds = new Set(projection.messages.map((message) => String(message.id)));
  const context: ProjectionContext = {
    thread: projection.thread,
    providerThread,
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    startingOrdinal: projection.turnItems.length,
  };

  const turnItems: OrchestrationV2TurnItem[] = [];
  const messages: OrchestrationV2ConversationMessage[] = [];
  let ordinal = context.startingOrdinal;

  for (const turn of input.turns) {
    for (const item of turn.items) {
      const mapped = toTurnItem(context, turn, item, ordinal, readAt);
      if (existingItemIds.has(String(mapped.id))) continue;
      existingItemIds.add(String(mapped.id));
      turnItems.push(mapped);
      ordinal += 1;

      const message = toConversationMessage(context, item, readAt);
      if (message !== undefined && !existingMessageIds.has(String(message.id))) {
        existingMessageIds.add(String(message.id));
        messages.push(message);
      }
    }
  }

  if (turnItems.length === 0 && messages.length === 0) {
    return snapshot;
  }

  return {
    ...snapshot,
    projection: {
      ...projection,
      turnItems: [...projection.turnItems, ...turnItems],
      messages: [...projection.messages, ...messages],
    },
  };
}
