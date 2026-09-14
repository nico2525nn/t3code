/**
 * One read path for Codex's durable thread history.
 *
 * The daemon API has two history formats: older threads return all turns from
 * `thread/read`, while newer threads expose paginated `thread/turns/list`.
 * Keeping that compatibility decision here prevents the manager and a live
 * runtime from disagreeing about what a thread contains.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";
import { TurnId } from "@t3tools/contracts";

export type CodexAppServerHistoryClient = Pick<
  CodexClient.CodexAppServerClient["Service"],
  "request"
> & {
  readonly raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">;
};

export const CODEX_HISTORY_PAGE_SIZE = 100;

const CodexHistoryMetadata = Schema.Struct({
  // `thread/read` with `includeTurns: false` is a metadata response. The
  // daemon keeps adding metadata fields, so decode the object as a record and
  // validate only the discriminator this compatibility layer owns.
  thread: Schema.Record(Schema.String, Schema.Unknown),
});

const CodexTurnsPage = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  nextCursor: Schema.optionalKey(Schema.Union([Schema.String, Schema.Null])),
});

const invalidPayload = (method: string, cause: unknown) =>
  CodexErrors.CodexAppServerRequestError.invalidPayload(
    method,
    "decode-payload",
    cause as Schema.SchemaError,
  );

const readLegacyThread = (client: CodexAppServerHistoryClient, threadId: string) =>
  client
    .request("thread/read", { threadId, includeTurns: true })
    .pipe(Effect.map((response) => response.thread));

interface CodexThreadMetadata {
  readonly thread: Readonly<Record<string, unknown>>;
  readonly historyMode: "legacy" | "paginated" | undefined;
}

const readThreadMetadata = (
  client: CodexAppServerHistoryClient,
  threadId: string,
): Effect.Effect<CodexThreadMetadata, CodexErrors.CodexAppServerError> =>
  client.raw.request("thread/read", { threadId, includeTurns: false }).pipe(
    Effect.flatMap((response) =>
      Schema.decodeUnknownEffect(CodexHistoryMetadata)(response).pipe(
        Effect.mapError((cause) => invalidPayload("thread/read", cause)),
      ),
    ),
    Effect.flatMap(({ thread }) => {
      const historyMode = thread.historyMode;
      if (historyMode === undefined || historyMode === "legacy" || historyMode === "paginated") {
        return Effect.succeed({ thread, historyMode });
      }
      return Effect.fail(
        CodexErrors.CodexAppServerRequestError.invalidParams(
          "thread/read",
          { historyMode },
          { method: "thread/read", operation: "decode-payload" },
        ),
      );
    }),
  );

const activeTurnId = (
  turns: ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn>,
): TurnId | undefined => {
  const turn = turns.findLast((entry) => entry.status === "inProgress");
  return turn === undefined ? undefined : TurnId.make(turn.id);
};

export const isCodexPaginationUnavailable = (cause: CodexErrors.CodexAppServerError): boolean =>
  cause._tag === "CodexAppServerRequestError" &&
  (cause.code === -32601 ||
    (cause.code === -32602 &&
      /thread\/(?:turns|items)\/list|paginated|history/iu.test(cause.errorMessage)));

export const readCodexAppServerHistoryMode = (
  client: CodexAppServerHistoryClient,
  threadId: string,
) => readThreadMetadata(client, threadId).pipe(Effect.map(({ historyMode }) => historyMode));

export interface CodexAppServerHistoryReadOptions {
  readonly sortDirection?: "asc" | "desc";
  readonly pageSize?: number;
  readonly itemsView?: "full" | "notLoaded";
  /** Stop after enough turns for a lightweight active-turn lookup. */
  readonly maxTurns?: number;
  /** Stop after enough user-anchored turns for a T3 detail page. */
  readonly userTurnLimit?: number;
  /** `null` preserves compatibility with older app-server implementations. */
  readonly initialCursor?: string | null;
  /**
   * With newest-first pagination, stop after including this turn. The
   * boundary turn is deliberately included because an in-progress turn can
   * change without creating a new turn id.
   */
  readonly afterTurnId?: string;
  /** With newest-first pagination, read the page strictly older than this turn. */
  readonly beforeTurnId?: string;
}

export const readCodexAppServerTurns = (
  client: CodexAppServerHistoryClient,
  threadId: string,
  options: CodexAppServerHistoryReadOptions = {},
) =>
  Effect.gen(function* () {
    type NativeTurn = CodexSchema.V2ThreadReadResponse__Turn;
    const selected: NativeTurn[] = [];
    let fallbackTurns: ReadonlyArray<NativeTurn> = [];
    const sortDirection = options.sortDirection ?? "desc";
    const pageSize = options.pageSize ?? CODEX_HISTORY_PAGE_SIZE;
    const itemsView = options.itemsView ?? "full";
    let cursor = options.initialCursor;
    const seenCursors = new Set<string>();
    let beforeBoundaryFound = options.beforeTurnId === undefined || sortDirection !== "desc";
    let userTurns = 0;

    const hasUserMessage = (turn: NativeTurn) =>
      turn.items.some((item) => item.type === "userMessage");

    const done = () =>
      (options.maxTurns !== undefined && selected.length >= options.maxTurns) ||
      (options.userTurnLimit !== undefined && userTurns >= options.userTurnLimit);

    /** Append one page in the order returned by App Server. */
    const append = (input: ReadonlyArray<NativeTurn>) => {
      const remaining =
        options.maxTurns === undefined
          ? input.length
          : Math.max(0, options.maxTurns - selected.length);
      const candidate = input.slice(0, remaining);
      let take = candidate.length;
      if (options.userTurnLimit !== undefined) {
        let pageUserTurns = 0;
        for (let index = 0; index < candidate.length; index += 1) {
          if (hasUserMessage(candidate[index]!)) pageUserTurns += 1;
          if (userTurns + pageUserTurns >= options.userTurnLimit) {
            take = index + 1;
            break;
          }
        }
      }
      const taken = candidate.slice(0, take);
      userTurns += taken.filter(hasUserMessage).length;
      selected.push(...taken);
    };

    if (done()) return [];

    for (;;) {
      const rawPage = yield* client.raw.request("thread/turns/list", {
        threadId,
        limit: Math.min(pageSize, options.maxTurns ?? pageSize),
        sortDirection,
        itemsView,
        ...(cursor === undefined ? {} : { cursor }),
      });
      const page = yield* Schema.decodeUnknownEffect(CodexTurnsPage)(rawPage).pipe(
        Effect.mapError((cause) => invalidPayload("thread/turns/list", cause)),
      );
      const decodedTurns = yield* Effect.forEach(page.data, (turn) =>
        Schema.decodeUnknownEffect(CodexSchema.V2ThreadReadResponse__Turn)(turn).pipe(
          Effect.mapError((cause) => invalidPayload("thread/turns/list", cause)),
        ),
      );
      if (fallbackTurns.length === 0) fallbackTurns = decodedTurns;

      if (options.beforeTurnId !== undefined && sortDirection === "desc" && !beforeBoundaryFound) {
        const boundaryIndex = decodedTurns.findIndex((turn) => turn.id === options.beforeTurnId);
        if (boundaryIndex >= 0) {
          beforeBoundaryFound = true;
          append(decodedTurns.slice(boundaryIndex + 1));
        }
      } else if (options.beforeTurnId === undefined || sortDirection !== "desc") {
        const boundaryIndex =
          options.afterTurnId !== undefined && sortDirection === "desc"
            ? decodedTurns.findIndex((turn) => turn.id === options.afterTurnId)
            : -1;
        append(boundaryIndex >= 0 ? decodedTurns.slice(0, boundaryIndex + 1) : decodedTurns);
        if (boundaryIndex >= 0 || done()) {
          return sortDirection === "desc" ? [...selected].reverse() : selected;
        }
      } else {
        append(decodedTurns);
      }
      if (done()) {
        return sortDirection === "desc" ? [...selected].reverse() : selected;
      }

      const nextCursor = page.nextCursor ?? undefined;
      if (nextCursor === undefined) {
        if (
          options.beforeTurnId !== undefined &&
          sortDirection === "desc" &&
          !beforeBoundaryFound
        ) {
          return [...fallbackTurns].reverse();
        }
        // The catalog path asks for newest-first pages to make the first page
        // cheap. Its public read contract is chronological, just like the
        // legacy `thread/read` response and the runtime snapshot contract.
        return sortDirection === "desc" ? [...selected].reverse() : selected;
      }
      if (seenCursors.has(nextCursor)) {
        return yield* CodexErrors.CodexAppServerRequestError.internalError(
          "Thread history pagination repeated a cursor.",
          undefined,
          { method: "thread/turns/list", operation: "decode-payload" },
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  });

/** Legacy `thread/read` returns an in-memory chronological turn array. Apply
 * the same window semantics as the paginated path after the unavoidable full
 * read, so old daemons remain compatible with the read-through boundary. */
const selectLegacyTurns = (
  turns: ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn>,
  options: CodexAppServerHistoryReadOptions,
): ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn> => {
  const hasUserMessage = (turn: CodexSchema.V2ThreadReadResponse__Turn) =>
    turn.items.some((item) => item.type === "userMessage");
  if (
    options.maxTurns === undefined &&
    options.userTurnLimit === undefined &&
    options.beforeTurnId === undefined
  ) {
    return turns;
  }
  if (options.beforeTurnId !== undefined) {
    const boundaryIndex = turns.findIndex((turn) => turn.id === options.beforeTurnId);
    const end = boundaryIndex < 0 ? turns.length : boundaryIndex;
    if (options.userTurnLimit !== undefined) {
      let userTurns = 0;
      let start = end;
      for (let index = end - 1; index >= 0; index -= 1) {
        if (hasUserMessage(turns[index]!)) userTurns += 1;
        start = index;
        if (userTurns >= options.userTurnLimit) break;
      }
      return turns.slice(start, end);
    }
    return options.maxTurns === undefined
      ? turns.slice(0, end)
      : turns.slice(Math.max(0, end - options.maxTurns), end);
  }
  if (options.userTurnLimit !== undefined) {
    let userTurns = 0;
    let start = turns.length;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      if (hasUserMessage(turns[index]!)) userTurns += 1;
      start = index;
      if (userTurns >= options.userTurnLimit) break;
    }
    return turns.slice(start);
  }
  return options.maxTurns === undefined ? turns : turns.slice(-options.maxTurns);
};

const readTurnsForMode = (
  client: CodexAppServerHistoryClient,
  threadId: string,
  historyMode: "legacy" | "paginated" | undefined,
  options: CodexAppServerHistoryReadOptions,
) =>
  historyMode === "paginated"
    ? readCodexAppServerTurns(client, threadId, options).pipe(
        Effect.catchIf(isCodexPaginationUnavailable, () =>
          readLegacyThread(client, threadId).pipe(
            Effect.map((thread) => selectLegacyTurns(thread.turns, options)),
          ),
        ),
      )
    : readLegacyThread(client, threadId).pipe(
        Effect.map((thread) => selectLegacyTurns(thread.turns, options)),
      );

const readThreadWithTurns = (
  client: CodexAppServerHistoryClient,
  threadId: string,
  options: CodexAppServerHistoryReadOptions,
) =>
  Effect.gen(function* () {
    const metadata = yield* readThreadMetadata(client, threadId);
    if (metadata.historyMode !== "paginated") {
      const thread = yield* readLegacyThread(client, threadId);
      const turns = selectLegacyTurns(thread.turns, options);
      return { metadata, thread: { ...thread, turns }, turns } as const;
    }
    return {
      metadata,
      turns: yield* readTurnsForMode(client, threadId, metadata.historyMode, options),
    } as const;
  });

export interface CodexAppServerThreadSnapshot {
  readonly threadId: string;
  readonly turns: ReadonlyArray<CodexSchema.V2ThreadReadResponse__Turn>;
}

/**
 * Read only the newest turn when a detached T3 session is reattached.
 *
 * Reattachment needs the native turn id, not the transcript. Asking for the
 * whole history here made reconnects scale with a thread's age and allowed a
 * second transcript read to race the live subscription.
 */
export const readCodexAppServerActiveTurnId = (
  client: CodexAppServerHistoryClient,
  threadId: string,
) =>
  readCodexAppServerThread(client, threadId, {
    sortDirection: "desc",
    itemsView: "notLoaded",
    maxTurns: 1,
    initialCursor: null,
  }).pipe(Effect.map((thread) => activeTurnId(thread.turns)));

export const readCodexAppServerThread = (
  client: CodexAppServerHistoryClient,
  threadId: string,
  options: CodexAppServerHistoryReadOptions = {},
) =>
  Effect.gen(function* () {
    const result = yield* readThreadWithTurns(client, threadId, options);
    if ("thread" in result) return result.thread;
    return {
      ...result.metadata.thread,
      id: typeof result.metadata.thread.id === "string" ? result.metadata.thread.id : threadId,
      turns: result.turns,
    } as CodexSchema.V2ThreadReadResponse__Thread;
  });

/** The one history read used by runtime commands and catalog recovery. */
export const readCodexAppServerThreadSnapshot = (
  client: CodexAppServerHistoryClient,
  threadId: string,
): Effect.Effect<CodexAppServerThreadSnapshot, CodexErrors.CodexAppServerError> =>
  Effect.gen(function* () {
    const result = yield* readThreadWithTurns(client, threadId, {
      initialCursor: null,
      pageSize: CODEX_HISTORY_PAGE_SIZE,
      sortDirection: "asc",
    });
    return { threadId, turns: result.turns };
  });
