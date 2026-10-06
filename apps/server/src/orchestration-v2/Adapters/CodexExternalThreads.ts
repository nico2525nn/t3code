import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";

import { buildCodexInitializeParams } from "../../provider/CodexProvider.ts";
import type { CodexSettings } from "@t3tools/contracts";
import { CODEX_CLIENT_CAPABILITIES } from "./CodexAdapterV2.ts";
import type { CodexAppServerClientFactoryShape } from "./CodexAdapterV2.ts";
import type { NativeTimelineItem, NativeTimelineTurn } from "../NativeTimeline.ts";
import { NATIVE_TIMELINE_TURN_PAGE_SIZE } from "../NativeTimeline.ts";
import * as NativeCatalog from "../NativeCatalog.ts";

/**
 * Conversations the Codex provider owns that T3 never created.
 *
 * Everything here runs on short-lived connections opened through the adapter's
 * own client factory: no session, no subscription, no state. The catalog sync
 * and the history read-through are the only callers.
 */

export type CodexNativeThreadSummary = NativeCatalog.NativeThreadSummary;

export type CodexNativeThreadPage = NativeCatalog.NativeThreadPage;

export interface CodexNativeTimelinePage {
  readonly turns: ReadonlyArray<NativeTimelineTurn>;
  readonly nextCursor: string | null;
}

export class CodexNativeReadError extends Schema.TaggedError<CodexNativeReadError>()(
  "CodexNativeReadError",
  {
    operation: Schema.Literals(["list-threads", "list-turns", "active-turn"]),
    nativeThreadId: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Codex native ${this.operation} failed${this.nativeThreadId === undefined ? "" : ` for ${this.nativeThreadId}`}.`;
  }
}

export interface CodexExternalThreadsOptions {
  readonly clientFactory: CodexAppServerClientFactoryShape;
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
}

type StandaloneClient = CodexClient.CodexAppServerClient["Service"];

/** Open a throwaway connection: handshake, use, close. No session attached. */
const withClient = <A>(
  options: CodexExternalThreadsOptions,
  use: (client: StandaloneClient) => Effect.Effect<A, CodexNativeReadError>,
): Effect.Effect<A, CodexNativeReadError, Scope.Scope> =>
  Effect.gen(function* () {
    const client = yield* options.clientFactory
      .open({
        instanceId: "codex" as never,
        threadId: "thread:codex-external-read" as never,
        providerSessionId: "provider-session:codex-external-read" as never,
        runtimePolicy: { runtimeMode: "background", cwd: undefined } as never,
        settings: options.settings,
        environment: options.environment,
      })
      .pipe(
        Effect.mapError((cause) => new CodexNativeReadError({ operation: "list-threads", cause })),
      );
    yield* client
      .request("initialize", {
        clientInfo: buildCodexInitializeParams().clientInfo,
        capabilities: CODEX_CLIENT_CAPABILITIES,
      })
      .pipe(
        Effect.mapError((cause) => new CodexNativeReadError({ operation: "list-threads", cause })),
      );
    yield* client
      .notify("initialized", undefined)
      .pipe(
        Effect.mapError((cause) => new CodexNativeReadError({ operation: "list-threads", cause })),
      );
    return yield* use(client);
  });

const toIso = (seconds: number | null | undefined): string | undefined =>
  seconds === null || seconds === undefined
    ? undefined
    : DateTime.formatIso(DateTime.makeUnsafe(seconds * 1000));

export const listNativeThreads = (
  options: CodexExternalThreadsOptions,
  input: {
    readonly archived: boolean;
    readonly cursor: string | undefined;
    readonly limit: number;
  },
): Effect.Effect<CodexNativeThreadPage, CodexNativeReadError, Scope.Scope> =>
  withClient(options, (client) =>
    client
      .request("thread/list", {
        archived: input.archived,
        cursor: input.cursor ?? null,
        limit: input.limit,
        sortDirection: "desc",
      })
      .pipe(
        Effect.mapError((cause) => new CodexNativeReadError({ operation: "list-threads", cause })),
        Effect.map((response) => ({
          threads: response.data.map((thread) => ({
            nativeId: thread.id,
            title: thread.name ?? undefined,
            cwd: thread.cwd,
            updatedAt:
              toIso(thread.updatedAt) ??
              toIso(thread.createdAt) ??
              DateTime.formatIso(DateTime.nowUnsafe()),
            createdAt: toIso(thread.createdAt),
            model: thread.model ?? undefined,
            archived: input.archived,
            ephemeral: thread.ephemeral,
          })),
          nextCursor: response.nextCursor ?? null,
        })),
      ),
  );

/** The turn this conversation is running right now, if any. One cheap request. */
export const readNativeActiveTurn = (
  options: CodexExternalThreadsOptions,
  nativeThreadId: string,
): Effect.Effect<{ readonly turnId: string } | null, CodexNativeReadError, Scope.Scope> =>
  withClient(options, (client) =>
    client
      .request("thread/turns/list", {
        threadId: nativeThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "notLoaded",
      })
      .pipe(
        Effect.mapError(
          (cause) => new CodexNativeReadError({ operation: "active-turn", nativeThreadId, cause }),
        ),
        Effect.map((page) => {
          const newest = page.data[0];
          return newest?.status === "inProgress" ? { turnId: newest.id } : null;
        }),
      ),
  );

const UserInputText = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String,
});

const decode = <A>(codec: Schema.Codec<A>, value: unknown): A | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(codec)(value));

const firstText = (content: ReadonlyArray<unknown>): string | undefined => {
  for (const entry of content) {
    const decoded = decode(UserInputText, entry);
    if (decoded !== undefined && decoded.text.trim().length > 0) return decoded.text;
  }
  return undefined;
};

/**
 * Map one native item onto the conversation-bearing subset.
 * Unknown shapes are skipped, never fatal: a provider upgrade must not take
 * the read-through down with it.
 */
function toTimelineItem(
  item: CodexSchema.V2ThreadTurnsListResponse__ThreadItem,
): NativeTimelineItem | undefined {
  switch (item.type) {
    case "userMessage": {
      const text = firstText(item.content);
      return text === undefined ? undefined : { kind: "user_message", nativeItemId: item.id, text };
    }
    case "agentMessage":
      return item.text.trim().length === 0
        ? undefined
        : { kind: "assistant_message", nativeItemId: item.id, text: item.text, completed: true };
    case "reasoning": {
      const text = [...(item.summary ?? []), ...(item.content ?? [])].join("\n").trim();
      return text.length === 0
        ? undefined
        : { kind: "reasoning", nativeItemId: item.id, text, completed: true };
    }
    case "plan":
      return { kind: "plan", nativeItemId: item.id, text: item.text };
    case "commandExecution":
      return {
        kind: "tool",
        nativeItemId: item.id,
        title: null,
        toolName: "commandExecution",
        input: item.command,
        completed: item.status === "completed",
      };
    case "mcpToolCall":
      return {
        kind: "tool",
        nativeItemId: item.id,
        title: null,
        toolName: `mcp:${item.server}/${item.tool}`,
        input: item.tool,
        completed: item.status === "completed",
      };
    case "dynamicToolCall":
      return {
        kind: "tool",
        nativeItemId: item.id,
        title: null,
        toolName: item.tool,
        input: item.tool,
        completed: item.status === "completed",
      };
    default:
      return undefined;
  }
}

/** Newest turns with conversation-bearing items, oldest-last for the merger. */
export const readNativeTimeline = (
  options: CodexExternalThreadsOptions,
  input: { readonly nativeThreadId: string; readonly cursor: string | undefined },
): Effect.Effect<CodexNativeTimelinePage, CodexNativeReadError, Scope.Scope> =>
  withClient(options, (client) =>
    Effect.gen(function* () {
      const page = yield* client
        .request("thread/turns/list", {
          threadId: input.nativeThreadId,
          limit: NATIVE_TIMELINE_TURN_PAGE_SIZE,
          sortDirection: "desc",
          // Summary drops reasoning and tool rows; the read-through exists to
          // show the conversation, so it pays for the full items.
          itemsView: "full",
          ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new CodexNativeReadError({
                operation: "list-turns",
                nativeThreadId: input.nativeThreadId,
                cause,
              }),
          ),
        );
      const turns: NativeTimelineTurn[] = page.data.map((turn) => ({
        nativeTurnId: turn.id,
        status: turn.status,
        startedAt: toIso(turn.startedAt),
        completedAt: toIso(turn.completedAt),
        items: turn.items.flatMap((item) => {
          const mapped = toTimelineItem(item);
          return mapped === undefined ? [] : [mapped];
        }),
      }));
      return { turns, nextCursor: page.nextCursor ?? null };
    }),
  );
