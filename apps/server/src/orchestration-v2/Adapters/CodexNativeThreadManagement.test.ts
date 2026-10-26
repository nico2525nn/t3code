import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import * as CodexNativeThreadManagement from "./CodexNativeThreadManagement.ts";

function makeClient(
  respond: (method: string, params: unknown) => unknown,
  calls: Array<{ readonly method: string; readonly params: unknown }>,
) {
  return {
    request: (method: string, params: unknown) => {
      calls.push({ method, params });
      return Effect.sync(() => respond(method, params)) as never;
    },
    notify: () => Effect.void,
  } as unknown as CodexClient.CodexAppServerClient["Service"];
}

function nativeThread(input: {
  readonly id: string;
  readonly updatedAt: number;
  readonly ephemeral?: boolean;
  readonly archived?: boolean;
  readonly forkedFromId?: string;
}): CodexSchema.V2ThreadListResponse__Thread {
  return {
    id: input.id,
    cwd: "/repo",
    title: undefined,
    preview: input.id,
    createdAt: 1,
    updatedAt: input.updatedAt,
    model: null,
    reasoningEffort: null,
    status: { type: "idle" },
    ephemeral: input.ephemeral ?? false,
    turns: [],
    cliVersion: "test",
    modelProvider: "openai",
    projectId: null,
    sessionId: input.id,
    source: "cli",
    historyMode: "paginated",
    ...(input.forkedFromId === undefined ? {} : { forkedFromId: input.forkedFromId }),
    ...(input.archived === undefined ? {} : { archived: input.archived }),
  } as unknown as CodexSchema.V2ThreadListResponse__Thread;
}

it.effect("paginates active and archived threads while excluding ephemeral threads", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = makeClient((method, params) => {
      if (method === "initialize") return {};
      if (method !== "thread/list") throw new Error(`Unexpected RPC: ${method}`);
      const input = params as { readonly archived: boolean; readonly cursor?: string };
      if (input.archived) return { data: [nativeThread({ id: "archived", updatedAt: 2 })] };
      if (input.cursor === "next") {
        return { data: [nativeThread({ id: "older", updatedAt: 1 })] };
      }
      return {
        data: [
          nativeThread({ id: "newest", updatedAt: 3, forkedFromId: "source" }),
          nativeThread({ id: "ephemeral", updatedAt: 4, ephemeral: true }),
        ],
        nextCursor: "next",
      };
    }, calls);
    const management = CodexNativeThreadManagement.makeCodexNativeThreadManagement(() =>
      Effect.succeed(client),
    );

    const threads = yield* management.listThreads();
    assert.deepEqual(
      threads.map((thread) => thread.nativeId),
      ["newest", "archived", "older"],
    );
    assert.equal(threads[0]?.forkedFromNativeId, "source");
    assert.equal(calls.filter((call) => call.method === "thread/list").length, 3);
  }),
);

it.effect("uses the native updated time to avoid paging unchanged history", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = makeClient((method) => {
      if (method === "initialize") return {};
      if (method === "thread/read") {
        return {
          thread: {
            ...nativeThread({ id: "thread", updatedAt: 123.125 }),
            historyMode: "paginated",
          },
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }, calls);
    const management = CodexNativeThreadManagement.makeCodexNativeThreadManagement(() =>
      Effect.succeed(client),
    );

    const result = yield* management.readThread({
      nativeThreadId: "thread",
      knownUpdatedAt: 123.125,
    });
    assert.deepEqual(result.turns, []);
    assert.deepEqual(
      calls.filter((call) => call.method !== "initialize").map((call) => call.method),
      ["thread/read"],
    );
  }),
);

it.effect("reads legacy turn items and maps them into the normalized thread history", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const base = nativeThread({ id: "legacy", updatedAt: 10 });
    const legacyThread = {
      ...base,
      historyMode: "legacy",
      turns: [
        {
          id: "turn-1",
          rootTurnId: "turn-root",
          status: "completed",
          startedAt: 2,
          completedAt: 4,
          items: [{ id: "message-1", type: "agentMessage", text: "done" }],
        },
      ],
    } as unknown as CodexSchema.V2ThreadReadResponse__Thread;
    const client = makeClient((method, params) => {
      if (method === "initialize") return {};
      if (method === "thread/read") {
        const input = params as { readonly includeTurns: boolean };
        return { thread: input.includeTurns ? legacyThread : { ...legacyThread, turns: [] } };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }, calls);
    const management = CodexNativeThreadManagement.makeCodexNativeThreadManagement(() =>
      Effect.succeed(client),
    );

    const result = yield* management.readThread({ nativeThreadId: "legacy" });
    assert.equal(result.thread.nativeId, "legacy");
    assert.equal(result.turns[0]?.nativeId, "turn-1");
    assert.equal(result.turns[0]?.rootNativeId, "turn-root");
    assert.equal(result.turns[0]?.items[0]?.nativeId, "message-1");
    assert.deepEqual(
      calls
        .filter((call) => call.method === "thread/read")
        .map((call) => (call.params as { readonly includeTurns: boolean }).includeTurns),
      [false, true],
    );
  }),
);

it.effect("paginates native turn and item history into the same ordered turns", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = makeClient((method, params) => {
      if (method === "initialize") return {};
      if (method === "thread/read") {
        return {
          thread: { ...nativeThread({ id: "paged", updatedAt: 20 }), historyMode: "paginated" },
        };
      }
      if (method === "thread/turns/list") {
        const input = params as { readonly cursor?: string };
        if (input.cursor === "next-turns") {
          return {
            data: [
              {
                id: "turn-2",
                rootTurnId: "turn-1",
                status: "inProgress",
                startedAt: 3,
                completedAt: null,
              },
            ],
          };
        }
        return {
          data: [
            {
              id: "turn-1",
              rootTurnId: "turn-1",
              status: "completed",
              startedAt: 1,
              completedAt: 2,
            },
          ],
          nextCursor: "next-turns",
        };
      }
      if (method === "thread/items/list") {
        const input = params as { readonly cursor?: string; readonly turnId: string };
        if (input.turnId === "turn-1" && input.cursor === "next-turn-1-items") {
          return {
            data: [
              {
                turnId: "turn-1",
                item: { id: "assistant-1-later", type: "agentMessage", text: "older follow-up" },
                startedAtMs: 2_500,
                completedAtMs: 2_750,
              },
            ],
          };
        }
        if (input.turnId === "turn-2") {
          return {
            data: [
              {
                turnId: "turn-2",
                item: { id: "assistant-2", type: "agentMessage", text: "newer" },
                startedAtMs: 3_500,
                completedAtMs: null,
              },
            ],
          };
        }
        return {
          data: [
            {
              turnId: "turn-1",
              item: { id: "assistant-1", type: "agentMessage", text: "older" },
              startedAtMs: 1_500,
              completedAtMs: 2_000,
            },
          ],
          nextCursor: "next-turn-1-items",
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }, calls);
    const management = CodexNativeThreadManagement.makeCodexNativeThreadManagement(() =>
      Effect.succeed(client),
    );

    const history = yield* management.readThread({ nativeThreadId: "paged" });
    assert.deepEqual(
      history.turns.map((turn) => [
        turn.nativeId,
        turn.rootNativeId,
        turn.items.map((item) => item.nativeId),
      ]),
      [
        ["turn-1", "turn-1", ["assistant-1", "assistant-1-later"]],
        ["turn-2", "turn-1", ["assistant-2"]],
      ],
    );
    assert.deepEqual(
      calls
        .filter((call) => call.method === "thread/turns/list")
        .map((call) => (call.params as { readonly cursor?: string }).cursor),
      [undefined, "next-turns"],
    );
    const itemCalls = calls
      .filter((call) => call.method === "thread/items/list")
      .map((call) => call.params as { readonly cursor?: string; readonly turnId: string });
    assert.equal(itemCalls.length, 3);
    assert.deepEqual(
      itemCalls.filter((call) => call.turnId === "turn-1").map((call) => call.cursor),
      [undefined, "next-turn-1-items"],
    );
    assert.deepEqual(
      itemCalls.filter((call) => call.turnId === "turn-2").map((call) => call.cursor),
      [undefined],
    );
  }),
);

it.effect("does not reload items for turns already mapped into T3", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = makeClient((method, params) => {
      if (method === "initialize") return {};
      if (method === "thread/read") {
        return {
          thread: {
            ...nativeThread({ id: "incremental", updatedAt: 30 }),
            historyMode: "paginated",
          },
        };
      }
      if (method === "thread/turns/list") {
        return {
          data: [
            { id: "existing-turn", status: "completed", startedAt: 1, completedAt: 2 },
            { id: "missing-turn", status: "completed", startedAt: 3, completedAt: 4 },
          ],
        };
      }
      if (method === "thread/items/list") {
        const input = params as { readonly turnId: string };
        if (input.turnId !== "missing-turn") throw new Error("Existing turn items were reloaded");
        return {
          data: [
            {
              turnId: "missing-turn",
              item: { id: "missing-item", type: "agentMessage", text: "continuation" },
              startedAtMs: 3_500,
              completedAtMs: 4_000,
            },
          ],
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }, calls);
    const management = CodexNativeThreadManagement.makeCodexNativeThreadManagement(() =>
      Effect.succeed(client),
    );

    const history = yield* management.readThread({
      nativeThreadId: "incremental",
      knownNativeTurnIds: ["existing-turn"],
    });
    assert.deepEqual(
      history.turns.map((turn) => [turn.nativeId, turn.items.map((item) => item.nativeId)]),
      [
        ["existing-turn", []],
        ["missing-turn", ["missing-item"]],
      ],
    );
    assert.deepEqual(
      calls
        .filter((call) => call.method === "thread/items/list")
        .map((call) => (call.params as { readonly turnId: string }).turnId),
      ["missing-turn"],
    );
  }),
);

it.effect("loads only the newest native turn when latestTurnOnly is requested", () =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly params: unknown }> = [];
    const client = makeClient((method, params) => {
      if (method === "initialize") return {};
      if (method === "thread/read") {
        return {
          thread: {
            ...nativeThread({ id: "active-large", updatedAt: 40 }),
            historyMode: "paginated",
          },
        };
      }
      if (method === "thread/turns/list") {
        return {
          data: [
            { id: "old-turn", status: "completed", startedAt: 1, completedAt: 2 },
            { id: "latest-turn", status: "inProgress", startedAt: 3, completedAt: null },
          ],
        };
      }
      if (method === "thread/items/list") {
        const input = params as { readonly turnId: string };
        return {
          data: [
            {
              turnId: input.turnId,
              item: {
                id: `${input.turnId}-item`,
                type: "agentMessage",
                text: input.turnId,
              },
              startedAtMs: 3_500,
              completedAtMs: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected RPC: ${method}`);
    }, calls);
    const management = CodexNativeThreadManagement.makeCodexNativeThreadManagement(() =>
      Effect.succeed(client),
    );

    const history = yield* management.readThread({
      nativeThreadId: "active-large",
      latestTurnOnly: true,
    });
    assert.deepEqual(
      history.turns.map((turn) => [turn.nativeId, turn.items.map((item) => item.nativeId)]),
      [
        ["old-turn", []],
        ["latest-turn", ["latest-turn-item"]],
      ],
    );
    assert.deepEqual(
      calls
        .filter((call) => call.method === "thread/items/list")
        .map((call) => (call.params as { readonly turnId: string }).turnId),
      ["latest-turn"],
    );
  }),
);

it.effect("writes thread metadata changes through the native App Server RPCs", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<Array<{ readonly method: string; readonly params: unknown }>>([]);
    const recordingClient = {
      request: (method: string, params: unknown) =>
        Effect.gen(function* () {
          yield* Ref.update(calls, (current) => [...current, { method, params }]);
          if (method === "initialize") return {};
          return {};
        }) as never,
      notify: () => Effect.void,
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    const management = CodexNativeThreadManagement.makeCodexNativeThreadManagement(() =>
      Effect.succeed(recordingClient),
    );

    yield* management.setName({ nativeThreadId: "thread", name: "Renamed" });
    yield* management.archive("thread");
    yield* management.unarchive("thread");
    yield* management.delete("thread");
    assert.deepEqual(
      (yield* Ref.get(calls))
        .filter((call) => call.method !== "initialize")
        .map((call) => call.method),
      ["thread/name/set", "thread/archive", "thread/unarchive", "thread/delete"],
    );
  }),
);
