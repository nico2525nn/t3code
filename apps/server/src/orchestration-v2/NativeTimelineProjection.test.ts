import { describe, expect, it } from "@effect/vitest";

import { chronological } from "./NativeTimeline.ts";
import { partitionTimelineItems, toNativeTimelineItem } from "./NativeTimelineProjection.ts";

const entry = (item: unknown, turnId = "turn-1") => ({ item, turnId });

describe("toNativeTimelineItem", () => {
  it("keeps a user message's text", () => {
    const mapped = toNativeTimelineItem({
      id: "i1",
      type: "userMessage",
      content: [{ type: "text", text: "hello" }],
    } as never);
    expect(mapped).toEqual({ kind: "user_message", nativeItemId: "i1", text: "hello" });
  });

  it("keeps an agent message", () => {
    const mapped = toNativeTimelineItem({
      id: "i2",
      type: "agentMessage",
      text: "done",
    } as never);
    expect(mapped).toMatchObject({ kind: "assistant_message", nativeItemId: "i2", text: "done" });
  });

  it("skips control-flow items that carry no conversation", () => {
    // Compaction markers, image views and sleepers would grow a page without
    // adding anything a reader can see.
    for (const type of ["contextCompaction", "imageView", "sleep", "subAgentActivity"]) {
      expect(toNativeTimelineItem({ id: `x-${type}`, type } as never)).toBeUndefined();
    }
  });

  it("does not fail on an item shape a newer provider adds", () => {
    expect(
      toNativeTimelineItem({ id: "i3", type: "someFutureItem", extra: 1 } as never),
    ).toBeUndefined();
  });

  it("labels a tool without a recorded title", () => {
    const mapped = toNativeTimelineItem({ id: "i4", type: "commandExecution" } as never);
    expect(mapped).toMatchObject({ kind: "tool", toolName: "shell", title: null });
  });
});

describe("partitionTimelineItems", () => {
  it("groups items by turn and measures the payload", () => {
    const { byTurn, approximateBytes } = partitionTimelineItems([
      entry({ id: "a", type: "userMessage", content: [{ type: "text", text: "one" }] }),
      entry({ id: "b", type: "agentMessage", text: "two" }),
      entry({ id: "c", type: "webSearch", query: "q" }, "turn-2"),
    ]);

    expect([...byTurn.keys()].toSorted()).toEqual(["turn-1", "turn-2"]);
    expect(byTurn.get("turn-1")).toHaveLength(2);
    expect(byTurn.get("turn-2")).toHaveLength(1);
    // The budget is what stops one page from outgrowing the window it fills.
    expect(approximateBytes).toBeGreaterThan(0);
  });

  it("drops malformed rows instead of failing the page", () => {
    const { byTurn } = partitionTimelineItems([
      null,
      42,
      entry({ id: "ok", type: "plan", text: "p" }),
    ]);
    expect(byTurn.get("turn-1")).toHaveLength(1);
  });
});

describe("chronological", () => {
  it("reverses newest-first turns so a timeline reads oldest-first", () => {
    const turns = [
      {
        nativeTurnId: "t3",
        status: "completed",
        startedAt: undefined,
        completedAt: undefined,
        items: [],
      },
      {
        nativeTurnId: "t2",
        status: "completed",
        startedAt: undefined,
        completedAt: undefined,
        items: [],
      },
      {
        nativeTurnId: "t1",
        status: "completed",
        startedAt: undefined,
        completedAt: undefined,
        items: [],
      },
    ] as const;
    expect(chronological(turns).map((turn) => turn.nativeTurnId)).toEqual(["t1", "t2", "t3"]);
  });
});
