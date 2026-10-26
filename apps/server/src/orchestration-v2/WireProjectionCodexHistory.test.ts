import {
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  duplicateLegacyCodexAssistantMessageItemIds,
  duplicateLegacyCodexUserMessageItemIds,
  projectThreadProjectionForWire,
} from "./WireProjection.ts";

const threadId = ThreadId.make("codex-native-history");
const providerThreadId = ProviderThreadId.make("codex-native-provider-thread");
const providerTurnId = ProviderTurnId.make("codex-native-provider-turn");
const runId = RunId.make("codex-native-run");
const at = DateTime.makeUnsafe("2026-10-05T18:51:04.000Z");
const providerThread: Pick<
  OrchestrationV2ProviderThread,
  "id" | "nativeThreadRef" | "nativeMetadata"
> = {
  id: providerThreadId,
  nativeThreadRef: {
    driver: "codex" as OrchestrationV2ProviderThread["driver"],
    nativeId: "native-thread",
    strength: "strong",
  },
  nativeMetadata: { historySyncUpdatedAt: "2026-10-05T18:51:04.000Z" },
};

function userMessage(input: {
  readonly id: string;
  readonly messageId: string;
  readonly text: string;
  readonly startedAt: NonNullable<OrchestrationV2TurnItem["startedAt"]>;
  readonly native?: boolean;
}): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(input.id),
    threadId,
    runId: input.native ? runId : null,
    nodeId: input.native ? NodeId.make("codex-native-node") : null,
    providerThreadId: input.native ? providerThreadId : null,
    providerTurnId: input.native ? providerTurnId : null,
    nativeItemRef: input.native
      ? {
          driver: "codex" as OrchestrationV2ProviderThread["driver"],
          nativeId: input.id,
          strength: "strong",
        }
      : null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    createdBy: "user",
    creationSource: input.native ? "provider" : "server",
    type: "user_message",
    messageId: MessageId.make(input.messageId),
    inputIntent: "turn_start",
    text: input.text,
    attachments: [],
    startedAt: input.startedAt,
    completedAt: input.startedAt,
    updatedAt: input.startedAt,
  };
}

function assistantMessage(input: {
  readonly id: string;
  readonly nativeId: string;
  readonly text: string;
}): Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> {
  return {
    id: TurnItemId.make(input.id),
    threadId,
    runId,
    nodeId: NodeId.make("codex-native-node"),
    providerThreadId,
    providerTurnId,
    nativeItemRef: {
      driver: ProviderDriverKind.make("codex"),
      nativeId: input.nativeId,
      strength: "strong",
    },
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    type: "assistant_message",
    messageId: MessageId.make(`assistant:${input.nativeId}`),
    text: input.text,
    streaming: false,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
}

it("hides only migrated Codex prompts duplicated by synchronized native history", () => {
  const native = userMessage({
    id: "native-item",
    messageId: "native-message",
    text: "same prompt",
    startedAt: at,
    native: true,
  });
  const duplicate = userMessage({
    id: "legacy-duplicate",
    messageId: "legacy-duplicate-message",
    text: "same prompt",
    startedAt: DateTime.makeUnsafe("2026-10-05T18:51:04.500Z"),
  });
  const repeatedLater = userMessage({
    id: "legacy-repeat",
    messageId: "legacy-repeat-message",
    text: "same prompt",
    startedAt: DateTime.makeUnsafe("2026-10-05T18:51:09.000Z"),
  });
  const unique = userMessage({
    id: "legacy-unique",
    messageId: "legacy-unique-message",
    text: "different prompt",
    startedAt: DateTime.makeUnsafe("2026-10-05T18:51:04.500Z"),
  });

  assert.deepEqual(
    duplicateLegacyCodexUserMessageItemIds({
      providerThreads: [providerThread],
      turnItems: [native, duplicate, repeatedLater, unique],
    }),
    new Set([duplicate.id]),
  );
  assert.isEmpty(
    duplicateLegacyCodexUserMessageItemIds({
      providerThreads: [{ ...providerThread, nativeMetadata: null }],
      turnItems: [native, duplicate],
    }),
  );
});

it("hides a migrated Codex assistant item only when its matching native item is present", () => {
  const nativeId = "assistant-native-item";
  const legacy = assistantMessage({
    id: `migration:v1:turn-item:assistant:${nativeId}`,
    nativeId,
    text: "same response",
  });
  const native = assistantMessage({
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: ProviderDriverKind.make("codex"),
      nativeItemId: nativeId,
    }),
    nativeId,
    text: "same response",
  });
  const unrelatedLegacy = assistantMessage({
    id: "migration:v1:turn-item:assistant:unimported",
    nativeId: "unimported",
    text: "older response",
  });

  assert.deepEqual(
    duplicateLegacyCodexAssistantMessageItemIds([legacy, native, unrelatedLegacy]),
    new Set([legacy.id]),
  );
  assert.isEmpty(
    duplicateLegacyCodexAssistantMessageItemIds([
      legacy,
      { ...native, text: "different response" },
    ]),
  );

  const visible = [legacy, native].map((item, position) => ({
    visibility: "local" as const,
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
    position,
  }));
  const projection = projectThreadProjectionForWire({
    providerThreads: [providerThread],
    turnItems: [legacy, native],
    visibleTurnItems: visible,
    messages: [],
    contextHandoffs: [],
  } as unknown as OrchestrationV2ThreadProjection);
  assert.deepEqual(
    projection.turnItems.map((item) => item.id),
    [native.id],
  );
  assert.deepEqual(
    projection.visibleTurnItems.map((row) => row.item.id),
    [native.id],
  );
});

it("preserves Codex reasoning and tool calls while hiding an exact assistant duplicate", () => {
  const nativeId = "assistant-with-tools";
  const legacy = assistantMessage({
    id: `migration:v1:turn-item:assistant:${nativeId}`,
    nativeId,
    text: "same response",
  });
  const native = assistantMessage({
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: ProviderDriverKind.make("codex"),
      nativeItemId: nativeId,
    }),
    nativeId,
    text: "same response",
  });
  const activity = {
    threadId,
    runId,
    nodeId: NodeId.make("codex-native-node"),
    providerThreadId,
    providerTurnId,
    nativeItemRef: {
      driver: ProviderDriverKind.make("codex"),
      nativeId: "native-activity",
      strength: "strong" as const,
    },
    parentItemId: null,
    ordinal: 2,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  const reasoning: Extract<OrchestrationV2TurnItem, { type: "reasoning" }> = {
    ...activity,
    id: TurnItemId.make("codex-reasoning"),
    type: "reasoning",
    text: "Thinking through the tool result.",
    streaming: false,
  };
  const command: Extract<OrchestrationV2TurnItem, { type: "command_execution" }> = {
    ...activity,
    id: TurnItemId.make("codex-command"),
    type: "command_execution",
    input: "git status --short",
    output: "working tree inspected",
    exitCode: 0,
  };
  const visibleItems = [legacy, native, reasoning, command];
  const projection = projectThreadProjectionForWire({
    providerThreads: [providerThread],
    turnItems: visibleItems,
    visibleTurnItems: visibleItems.map((item, position) => ({
      visibility: "local" as const,
      sourceThreadId: threadId,
      sourceItemId: item.id,
      item,
      position,
    })),
    messages: [],
    contextHandoffs: [],
  } as unknown as OrchestrationV2ThreadProjection);

  assert.deepEqual(
    projection.visibleTurnItems.map((row) => row.item.type),
    ["assistant_message", "reasoning", "command_execution"],
  );
  assert.deepEqual(
    projection.turnItems.map((item) => item.type),
    ["assistant_message", "reasoning", "command_execution"],
  );
});
