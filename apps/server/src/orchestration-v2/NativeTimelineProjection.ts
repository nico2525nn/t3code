import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CodexSchema from "effect-codex-app-server/schema";

import * as NativeTimeline from "./NativeTimeline.ts";
import type { NativeTimelineItem } from "./NativeTimeline.ts";

/**
 * Codex item text shapes, decoded leniently.
 *
 * The generated schema is exhaustive, but a provider upgrade must not take the
 * history read-through down with it: an unrecognised item becomes a skipped
 * row rather than a failed page.
 */
const UserInputText = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const AgentMessage = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  text: Schema.String,
});

const Reasoning = Schema.Struct({
  type: Schema.Literal("reasoning"),
  text: Schema.String,
});

const Plan = Schema.Struct({
  type: Schema.Literal("plan"),
  text: Schema.String,
});

const CommandExecution = Schema.Struct({
  type: Schema.Literal("commandExecution"),
  command: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const McpToolCall = Schema.Struct({
  type: Schema.Literal("mcpToolCall"),
  tool: Schema.String,
  title: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const WebSearch = Schema.Struct({
  type: Schema.Literal("webSearch"),
  query: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const FileChange = Schema.Struct({
  type: Schema.Literal("fileChange"),
});

const DynamicToolCall = Schema.Struct({
  type: Schema.Literal("dynamicToolCall"),
  tool: Schema.String,
  title: Schema.optional(Schema.Union([Schema.String, Schema.Null])),
});

const firstTextInput = (content: ReadonlyArray<unknown>): string | undefined => {
  for (const entry of content) {
    const decoded = Schema.decodeUnknownOption(UserInputText)(entry);
    if (Option.isSome(decoded) && decoded.value.text.trim().length > 0) {
      return decoded.value.text;
    }
  }
  return undefined;
};

/** Decode leniently: an item a newer provider adds is skipped, not fatal. */
const decode = <A>(codec: Schema.Codec<A>, value: unknown): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(codec)(value));

/**
 * Map one native item onto the conversation-bearing subset.
 *
 * Returns `undefined` for items that carry no reader-visible content:
 * compaction markers, image views, idle sleepers, review-mode transitions and
 * sub-agent rosters. Copying them would grow a page without adding anything.
 */
export function toNativeTimelineItem(
  item: Extract<CodexSchema.V2ThreadItemsListResponse__ThreadItem, { readonly id: string }>,
): NativeTimelineItem | undefined {
  switch (item.type) {
    case "userMessage": {
      const text = firstTextInput(item.content);
      return text === undefined ? undefined : { kind: "user_message", nativeItemId: item.id, text };
    }
    case "agentMessage": {
      const decoded = decode(AgentMessage, item);
      return decoded === undefined || decoded.text.trim().length === 0
        ? undefined
        : {
            kind: "assistant_message",
            nativeItemId: item.id,
            text: decoded.text,
            completed: true,
          };
    }
    case "reasoning": {
      const decoded = decode(Reasoning, item);
      return decoded === undefined || decoded.text.trim().length === 0
        ? undefined
        : {
            kind: "reasoning",
            nativeItemId: item.id,
            text: decoded.text,
            completed: true,
          };
    }
    case "plan": {
      const decoded = decode(Plan, item);
      return decoded === undefined
        ? undefined
        : { kind: "plan", nativeItemId: item.id, text: decoded.text };
    }
    case "commandExecution": {
      const decoded = decode(CommandExecution, item);
      return {
        kind: "tool",
        nativeItemId: item.id,
        title: decoded?.command ?? null,
        toolName: "shell",
        completed: true,
      };
    }
    case "mcpToolCall": {
      const decoded = decode(McpToolCall, item);
      return {
        kind: "tool",
        nativeItemId: item.id,
        title: decoded?.title ?? null,
        toolName: decoded?.tool ?? "mcp",
        completed: true,
      };
    }
    case "dynamicToolCall": {
      const decoded = decode(DynamicToolCall, item);
      return {
        kind: "tool",
        nativeItemId: item.id,
        title: decoded?.title ?? null,
        toolName: decoded?.tool ?? "tool",
        completed: true,
      };
    }
    case "webSearch": {
      const decoded = decode(WebSearch, item);
      return {
        kind: "tool",
        nativeItemId: item.id,
        title: decoded?.query ?? null,
        toolName: "web_search",
        completed: true,
      };
    }
    case "fileChange":
      return {
        kind: "tool",
        nativeItemId: item.id,
        title: null,
        toolName: "file_change",
        completed: true,
      };
    default:
      return undefined;
  }
}

const TurnItemEntry = Schema.Struct({
  item: Schema.Unknown,
  turnId: Schema.String,
});

/**
 * Split one item page into per-turn rows and measure the payload it carried.
 *
 * The byte total is what bounds a read-through: a turn budget alone lets a
 * single agentic turn pull its whole transcript into memory.
 */
export function partitionTimelineItems(entries: ReadonlyArray<unknown>): {
  readonly byTurn: Map<string, ReadonlyArray<NativeTimelineItem>>;
  readonly approximateBytes: number;
} {
  const byTurn = new Map<string, NativeTimelineItem[]>();
  let approximateBytes = 0;
  for (const entry of entries) {
    const decoded = decode(TurnItemEntry, entry);
    if (decoded === undefined) continue;
    const nativeItem = decoded.item as Extract<
      CodexSchema.V2ThreadItemsListResponse__ThreadItem,
      { readonly id: string }
    >;
    if (typeof nativeItem?.id !== "string") continue;
    approximateBytes += Buffer.byteLength(
      JSON.stringify(nativeItem, (_key, value: unknown) =>
        typeof value === "string" ? value : value,
      ),
      "utf8",
    );
    const mapped = toNativeTimelineItem(nativeItem);
    if (mapped === undefined) continue;
    const bucket = byTurn.get(decoded.turnId);
    if (bucket === undefined) {
      byTurn.set(decoded.turnId, [mapped]);
    } else {
      bucket.push(mapped);
    }
  }
  return { byTurn, approximateBytes };
}
