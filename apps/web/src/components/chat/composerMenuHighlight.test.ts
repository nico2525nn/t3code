import { describe, expect, it } from "vitest";

import {
  resolveComposerMenuActiveItemId,
  resolveComposerMenuNudgedItemId,
} from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
  const items = [{ id: "top" }, { id: "second" }, { id: "third" }] as const;

  it("defaults to the first item when nothing is highlighted", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: null,
        currentSearchKey: "skill:u",
        highlightedSearchKey: null,
      }),
    ).toBe("top");
  });

  it("preserves the highlighted item within the same query", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "skill:u",
        highlightedSearchKey: "skill:u",
      }),
    ).toBe("second");
  });

  it("resets to the top result when the query changes", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "second",
        currentSearchKey: "skill:ui",
        highlightedSearchKey: "skill:u",
      }),
    ).toBe("top");
  });

  it("falls back to the first item when the highlighted item disappears", () => {
    expect(
      resolveComposerMenuActiveItemId({
        items,
        highlightedItemId: "missing",
        currentSearchKey: "skill:ui",
        highlightedSearchKey: "skill:ui",
      }),
    ).toBe("top");
  });
});

describe("resolveComposerMenuNudgedItemId", () => {
  const items = [{ id: "top" }, { id: "second" }, { id: "third" }] as const;

  it("moves from the active item", () => {
    expect(
      resolveComposerMenuNudgedItemId({
        items,
        activeItemId: "second",
        direction: "next",
      }),
    ).toBe("third");

    expect(
      resolveComposerMenuNudgedItemId({
        items,
        activeItemId: "second",
        direction: "previous",
      }),
    ).toBe("top");
  });

  it("wraps around at either edge", () => {
    expect(
      resolveComposerMenuNudgedItemId({
        items,
        activeItemId: "third",
        direction: "next",
      }),
    ).toBe("top");

    expect(
      resolveComposerMenuNudgedItemId({
        items,
        activeItemId: "top",
        direction: "previous",
      }),
    ).toBe("third");
  });

  it("starts from the first visible item when active state is stale", () => {
    expect(
      resolveComposerMenuNudgedItemId({
        items,
        activeItemId: "missing",
        direction: "next",
      }),
    ).toBe("top");

    expect(
      resolveComposerMenuNudgedItemId({
        items,
        activeItemId: "missing",
        direction: "previous",
      }),
    ).toBe("third");
  });
});
