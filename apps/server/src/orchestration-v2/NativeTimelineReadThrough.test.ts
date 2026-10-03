import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { adoptedProviderThread, mergeNativeTimeline } from "./NativeTimelineReadThrough.ts";
import type { NativeTimelineTurn } from "./NativeTimeline.ts";

const DRIVER = ProviderDriverKind.make("codex");
const INSTANCE = ProviderInstanceId.make("codex-default");
const THREAD_ID = ThreadId.make("thread-1");
const AT = DateTime.makeUnsafe(Date.parse("2026-10-03T00:00:00Z"));

const appThread = { id: THREAD_ID } as unknown as OrchestrationV2AppThread;

const providerThread = (nativeId: string | null): OrchestrationV2ProviderThread =>
  ({
    id: ProviderThreadId.make("provider-thread-1"),
    nativeThreadRef: nativeId === null ? null : { driver: DRIVER, nativeId, strength: "strong" },
  }) as unknown as OrchestrationV2ProviderThread;

const snapshot = (input?: {
  readonly itemIds?: ReadonlyArray<string>;
  readonly messageIds?: ReadonlyArray<string>;
}) =>
  ({
    schemaVersion: 2,
    snapshotSequence: 7,
    projection: {
      thread: appThread,
      turnItems: (input?.itemIds ?? []).map((id) => ({ id })),
      messages: (input?.messageIds ?? []).map((id) => ({ id })),
    },
  }) as unknown as ReturnType<typeof mergeNativeTimeline> extends never
    ? never
    : Parameters<typeof mergeNativeTimeline>[0]["snapshot"];

const turn = (input: {
  readonly turnId: string;
  readonly items: NativeTimelineTurn["items"];
}): NativeTimelineTurn => ({
  nativeTurnId: input.turnId,
  status: "completed",
  startedAt: "2026-10-02T00:00:00Z",
  completedAt: "2026-10-02T00:05:00Z",
  items: input.items,
});

const merge = (input: {
  readonly snapshot: Parameters<typeof mergeNativeTimeline>[0]["snapshot"];
  readonly turns: ReadonlyArray<NativeTimelineTurn>;
  readonly providerThread?: OrchestrationV2ProviderThread;
}) =>
  mergeNativeTimeline({
    snapshot: input.snapshot,
    providerThread: input.providerThread ?? providerThread("native-1"),
    driver: DRIVER,
    providerInstanceId: INSTANCE,
    turns: input.turns,
    readAt: AT,
  });

describe("adoptedProviderThread", () => {
  it("finds only a thread T3 adopted, not one it created", () => {
    expect(adoptedProviderThread([providerThread("native-1")])?.nativeThreadRef?.nativeId).toBe(
      "native-1",
    );
    // A T3-created thread has no strong native ref, so its history is already
    // local and must never be read through.
    expect(adoptedProviderThread([providerThread(null)])).toBeUndefined();
  });
});

describe("mergeNativeTimeline", () => {
  it("adds the conversation the provider owns", () => {
    const merged = merge({
      snapshot: snapshot(),
      turns: [
        turn({
          turnId: "t1",
          items: [
            { kind: "user_message", nativeItemId: "i1", text: "hello" },
            { kind: "assistant_message", nativeItemId: "i2", text: "hi", completed: true },
            { kind: "reasoning", nativeItemId: "i3", text: "thinking", completed: true },
            { kind: "tool", nativeItemId: "i4", title: null, toolName: "shell", completed: true },
          ],
        }),
      ],
    });

    expect(merged.projection.turnItems).toHaveLength(4);
    // Only the two message-bearing kinds become conversation messages.
    expect(merged.projection.messages).toHaveLength(2);
    expect(merged.projection.messages[0]?.role).toBe("user");
    expect(merged.projection.messages[1]?.role).toBe("assistant");
  });

  it("produces the same ids on a re-read, so a refresh is not a rewrite", () => {
    const turns = [
      turn({ turnId: "t1", items: [{ kind: "user_message", nativeItemId: "i1", text: "hello" }] }),
    ];
    const first = merge({ snapshot: snapshot(), turns });
    const second = merge({ snapshot: snapshot(), turns });
    expect(first.projection.turnItems.map((item) => String(item.id))).toEqual(
      second.projection.turnItems.map((item) => String(item.id)),
    );
  });

  it("does not duplicate a row the projection already has", () => {
    const first = merge({
      snapshot: snapshot(),
      turns: [
        turn({ turnId: "t1", items: [{ kind: "user_message", nativeItemId: "i1", text: "hi" }] }),
      ],
    });
    const second = merge({
      snapshot: first,
      turns: [
        turn({ turnId: "t1", items: [{ kind: "user_message", nativeItemId: "i1", text: "hi" }] }),
      ],
    });
    expect(second.projection.turnItems).toHaveLength(1);
    expect(second.projection.messages).toHaveLength(1);
  });

  it("returns the snapshot untouched when the provider had nothing readable", () => {
    const base = snapshot();
    expect(merge({ snapshot: base, turns: [] })).toBe(base);
  });

  it("continues the ordinal sequence after local rows", () => {
    const merged = merge({
      snapshot: snapshot({ itemIds: ["local-1", "local-2"] }),
      turns: [
        turn({ turnId: "t1", items: [{ kind: "user_message", nativeItemId: "i1", text: "hi" }] }),
      ],
    });
    const appended = merged.projection.turnItems.at(-1);
    expect(appended?.ordinal).toBe(2);
  });
});
