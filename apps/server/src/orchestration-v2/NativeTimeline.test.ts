import { assert, it } from "@effect/vitest";

import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import {
  adoptedProviderThread,
  mergeNativeTimeline,
  type NativeTimelineSnapshot,
} from "./NativeTimeline.ts";

const snapshot = (turnItems: NativeTimelineSnapshot["projection"]["turnItems"]) =>
  ({
    schemaVersion: 1,
    snapshotSequence: 7,
    projection: {
      thread: { id: "thread:test" },
      providerThreads: [
        {
          id: "provider-thread:test",
          appThreadId: "thread:test",
          driver: "codex",
          providerInstanceId: "codex",
          nativeThreadRef: { driver: "codex", nativeId: "native-1", strength: "strong" },
        },
      ],
      turnItems,
      messages: [],
    },
  }) as unknown as NativeTimelineSnapshot;

it("adopts only strong native refs", () => {
  assert.strictEqual(
    adoptedProviderThread(snapshot([]).projection.providerThreads)?.id,
    "provider-thread:test",
  );
  assert.strictEqual(
    adoptedProviderThread([
      {
        nativeThreadRef: { driver: "codex", nativeId: "x", strength: "weak" },
      },
    ] as never),
    undefined,
  );
});

it("merges turns oldest-first with deterministic ids", async () => {
  const merged = await Effect.runPromise(
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      return mergeNativeTimeline({
        snapshot: snapshot([]),
        providerThread: snapshot([]).projection.providerThreads[0]!,
        driver: "codex",
        providerInstanceId: "codex",
        turns: [
          {
            nativeTurnId: "turn-new",
            status: "completed",
            startedAt: "2026-06-02T00:00:00.000Z",
            completedAt: "2026-06-02T00:01:00.000Z",
            items: [
              {
                kind: "assistant_message",
                nativeItemId: "item-2",
                text: "second",
                completed: true,
              },
            ],
          },
          {
            nativeTurnId: "turn-old",
            status: "completed",
            startedAt: "2026-06-01T00:00:00.000Z",
            completedAt: "2026-06-01T00:01:00.000Z",
            items: [{ kind: "user_message", nativeItemId: "item-1", text: "first" }],
          },
        ],
        readAt,
      });
    }),
  );
  assert.deepStrictEqual(
    merged.projection.turnItems.map((item) => item.id),
    ["native-item:codex:codex:item-1", "native-item:codex:codex:item-2"],
  );
  assert.deepStrictEqual(
    merged.projection.messages.map((message) => message.id),
    ["native-message:codex:codex:item-1", "native-message:codex:codex:item-2"],
  );
  assert.strictEqual(merged.snapshotSequence, 7);
});
