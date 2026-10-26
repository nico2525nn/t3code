import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2NativeItem,
  ProviderAdapterV2NativeThread,
  ProviderAdapterV2NativeThreadManagement,
  ProviderAdapterV2NativeTurn,
} from "@t3tools/provider-core/server/ProviderAdapter";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";

import { buildCodexInitializeParams } from "../../provider/CodexProvider.ts";
const CODEX_PROVIDER = ProviderDriverKind.make("codex");

type NativeClient = CodexClient.CodexAppServerClient["Service"];
type NativeClientOpen = () => Effect.Effect<NativeClient, ProviderAdapterV2Error, Scope.Scope>;

function protocolError(
  detail: string,
  cause: unknown,
): ProviderAdapter.ProviderAdapterProtocolError {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: CODEX_PROVIDER,
    detail,
    payload: cause,
  });
}

function normalizedThread(
  thread: CodexSchema.V2ThreadListResponse__Thread | CodexSchema.V2ThreadReadResponse__Thread,
  archived: boolean,
): ProviderAdapterV2NativeThread {
  const latestTurn = thread.turns.at(-1);
  return {
    nativeId: thread.id,
    cwd: thread.cwd,
    title: thread.name ?? null,
    preview: thread.preview,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    model: thread.model ?? null,
    reasoningEffort: thread.reasoningEffort ?? null,
    archived,
    status: thread.status.type,
    latestTurn:
      latestTurn === undefined
        ? null
        : {
            nativeId: latestTurn.id,
            startedAt: latestTurn.startedAt ?? null,
            completedAt: latestTurn.completedAt ?? null,
            status: latestTurn.status,
          },
    parentNativeId: thread.parentThreadId ?? null,
    forkedFromNativeId: thread.forkedFromId ?? null,
  };
}

function nativeItem(
  item: CodexSchema.V2ThreadItemsListResponse__ThreadItemEntry,
): ProviderAdapterV2NativeItem {
  return {
    nativeId: item.item.id,
    type: item.item.type,
    startedAt: item.startedAtMs == null ? null : item.startedAtMs / 1_000,
    completedAt: item.completedAtMs == null ? null : item.completedAtMs / 1_000,
    payload: item.item,
  };
}

function initialize(client: NativeClient) {
  const params = buildCodexInitializeParams();
  return client
    .request("initialize", {
      ...params,
      capabilities: {
        ...params.capabilities,
        optOutNotificationMethods: ["turn/diff/updated"],
      },
    })
    .pipe(
      Effect.catchTags({
        CodexAppServerRequestError: (error) =>
          error.code === -32600 && error.errorMessage === "Already initialized"
            ? Effect.void
            : Effect.fail(error),
      }),
      Effect.mapError((cause) =>
        protocolError("Failed to initialize the Codex App Server connection.", cause),
      ),
      Effect.andThen(
        client
          .notify("initialized", undefined)
          .pipe(
            Effect.mapError((cause) =>
              protocolError("Failed to complete the Codex App Server handshake.", cause),
            ),
          ),
      ),
    );
}

const listNativeThreads = Effect.fn("CodexNativeThreadManagement.listNativeThreads")(function* (
  client: NativeClient,
) {
  const threads = new Map<string, ProviderAdapterV2NativeThread>();
  for (const archived of [false, true]) {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    do {
      const response = yield* client
        .request("thread/list", {
          archived,
          limit: 100,
          sortDirection: "desc",
          sortKey: "updated_at",
          ...(cursor === undefined ? {} : { cursor }),
        })
        .pipe(
          Effect.mapError((cause) =>
            protocolError("Failed to list Codex App Server threads.", cause),
          ),
        );
      for (const thread of response.data) {
        if (!thread.ephemeral) threads.set(thread.id, normalizedThread(thread, archived));
      }
      const next = response.nextCursor ?? undefined;
      if (next !== undefined && seenCursors.has(next)) {
        return yield* protocolError("Codex App Server repeated a thread-list cursor.", next);
      }
      if (next !== undefined) seenCursors.add(next);
      cursor = next;
    } while (cursor !== undefined);
  }
  return Array.from(threads.values()).toSorted((left, right) => right.updatedAt - left.updatedAt);
});

const listTurns = Effect.fn("CodexNativeThreadManagement.listTurns")(function* (
  client: NativeClient,
  nativeThreadId: string,
) {
  const turns: Array<ProviderAdapterV2NativeTurn> = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const response = yield* client
      .request("thread/turns/list", {
        threadId: nativeThreadId,
        limit: 100,
        sortDirection: "asc",
        itemsView: "notLoaded",
        ...(cursor === undefined ? {} : { cursor }),
      })
      .pipe(
        Effect.mapError((cause) =>
          protocolError(`Failed to list turns for Codex thread ${nativeThreadId}.`, cause),
        ),
      );
    turns.push(
      ...response.data.map((turn) => ({
        nativeId: turn.id,
        rootNativeId: turn.rootTurnId ?? turn.id,
        startedAt: turn.startedAt ?? null,
        completedAt: turn.completedAt ?? null,
        status: turn.status,
        items: [],
      })),
    );
    const next = response.nextCursor ?? undefined;
    if (next !== undefined && seenCursors.has(next)) {
      return yield* protocolError(`Codex repeated a turn-list cursor for ${nativeThreadId}.`, next);
    }
    if (next !== undefined) seenCursors.add(next);
    cursor = next;
  } while (cursor !== undefined);
  return turns;
});

const listItems = Effect.fn("CodexNativeThreadManagement.listItems")(function* (
  client: NativeClient,
  nativeThreadId: string,
  nativeTurnId: string,
) {
  const items: Array<ProviderAdapterV2NativeItem> = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  do {
    const response = yield* client
      .request("thread/items/list", {
        threadId: nativeThreadId,
        turnId: nativeTurnId,
        limit: 1_000,
        sortDirection: "asc",
        ...(cursor === undefined ? {} : { cursor }),
      })
      .pipe(
        Effect.mapError((cause) =>
          protocolError(`Failed to list items for Codex thread ${nativeThreadId}.`, cause),
        ),
      );
    items.push(...response.data.map(nativeItem));
    const next = response.nextCursor ?? undefined;
    if (next !== undefined && seenCursors.has(next)) {
      return yield* protocolError(
        `Codex repeated an item-list cursor for ${nativeThreadId}.`,
        next,
      );
    }
    if (next !== undefined) seenCursors.add(next);
    cursor = next;
  } while (cursor !== undefined);
  return items;
});

function readLegacyTurns(thread: CodexSchema.V2ThreadReadResponse__Thread) {
  return thread.turns.map((turn) => ({
    nativeId: turn.id,
    rootNativeId: turn.rootTurnId ?? turn.id,
    startedAt: turn.startedAt ?? null,
    completedAt: turn.completedAt ?? null,
    status: turn.status,
    items: turn.items.map((item) => ({
      nativeId: item.id,
      type: item.type,
      startedAt: null,
      completedAt: null,
      payload: item,
    })),
  }));
}

export function makeCodexNativeThreadManagement(
  openClient: NativeClientOpen,
): ProviderAdapterV2NativeThreadManagement {
  const withClient = <A>(use: (client: NativeClient) => Effect.Effect<A, ProviderAdapterV2Error>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* openClient();
        yield* initialize(client);
        return yield* use(client);
      }),
    );

  return {
    listThreads: () => withClient(listNativeThreads),
    readThread: ({
      nativeThreadId,
      archived = false,
      knownUpdatedAt,
      knownNativeTurnIds = [],
      latestTurnOnly = false,
    }) =>
      withClient((client) =>
        Effect.gen(function* () {
          const response = yield* client
            .request("thread/read", { threadId: nativeThreadId, includeTurns: false })
            .pipe(
              Effect.mapError((cause) =>
                protocolError(`Failed to read Codex thread ${nativeThreadId}.`, cause),
              ),
            );
          if (knownUpdatedAt !== undefined && response.thread.updatedAt === knownUpdatedAt) {
            return {
              thread: normalizedThread(response.thread, archived),
              turns: [],
            };
          }
          if (response.thread.historyMode !== "paginated") {
            const legacy = yield* client
              .request("thread/read", { threadId: nativeThreadId, includeTurns: true })
              .pipe(
                Effect.mapError((cause) =>
                  protocolError(`Failed to read legacy Codex history ${nativeThreadId}.`, cause),
                ),
              );
            return {
              thread: normalizedThread(legacy.thread, archived),
              turns: readLegacyTurns(legacy.thread).map((turn) => {
                const isLatestTurn = turn.nativeId === legacy.thread.turns.at(-1)?.id;
                return (latestTurnOnly && !isLatestTurn) ||
                  (!latestTurnOnly && knownNativeTurnIds.includes(turn.nativeId))
                  ? { ...turn, items: [] }
                  : turn;
              }),
            };
          }
          const turns = yield* listTurns(client, nativeThreadId);
          const knownTurnIds = new Set(knownNativeTurnIds);
          const latestTurnId = turns.at(-1)?.nativeId;
          const itemsByTurn = new Map(
            yield* Effect.forEach(
              turns.filter((turn) =>
                latestTurnOnly ? turn.nativeId === latestTurnId : !knownTurnIds.has(turn.nativeId),
              ),
              (turn) =>
                listItems(client, nativeThreadId, turn.nativeId).pipe(
                  Effect.map((items) => [turn.nativeId, items] as const),
                ),
              { concurrency: 4 },
            ),
          );
          return {
            thread: {
              ...normalizedThread(response.thread, archived),
              latestTurn: turns.at(-1) ?? null,
            },
            turns: turns.map((turn) => ({
              ...turn,
              items: itemsByTurn.get(turn.nativeId) ?? [],
            })),
          };
        }),
      ),
    setName: ({ nativeThreadId, name }) =>
      withClient((client) =>
        client.request("thread/name/set", { threadId: nativeThreadId, name }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            protocolError(`Failed to rename Codex thread ${nativeThreadId}.`, cause),
          ),
        ),
      ),
    archive: (nativeThreadId) =>
      withClient((client) =>
        client.request("thread/archive", { threadId: nativeThreadId }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            protocolError(`Failed to archive Codex thread ${nativeThreadId}.`, cause),
          ),
        ),
      ),
    unarchive: (nativeThreadId) =>
      withClient((client) =>
        client.request("thread/unarchive", { threadId: nativeThreadId }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            protocolError(`Failed to unarchive Codex thread ${nativeThreadId}.`, cause),
          ),
        ),
      ),
    delete: (nativeThreadId) =>
      withClient((client) =>
        client.request("thread/delete", { threadId: nativeThreadId }).pipe(
          Effect.asVoid,
          Effect.mapError((cause) =>
            protocolError(`Failed to delete Codex thread ${nativeThreadId}.`, cause),
          ),
        ),
      ),
  };
}
