import { describe, expect, it } from "vitest";

import { deriveMobileLayout } from "./mobileLayout";

describe("deriveMobileLayout", () => {
  it("keeps phones in compact mode", () => {
    expect(deriveMobileLayout({ width: 393, height: 852 })).toEqual({
      variant: "compact",
      usesSplitView: false,
      listPaneWidth: null,
      shellPadding: 0,
    });
  });

  it("avoids split mode in short landscape phone layouts", () => {
    expect(deriveMobileLayout({ width: 852, height: 393 }).variant).toBe("compact");
  });

  it("enables split mode on tablet-sized displays", () => {
    expect(deriveMobileLayout({ width: 744, height: 1133 })).toMatchObject({
      variant: "split",
      usesSplitView: true,
      listPaneWidth: 320,
      shellPadding: 14,
    });
  });

  it("caps the sidebar width on large tablets", () => {
    expect(deriveMobileLayout({ width: 1366, height: 1024 })).toMatchObject({
      variant: "split",
      usesSplitView: true,
      listPaneWidth: 420,
      shellPadding: 20,
    });
  });
});
