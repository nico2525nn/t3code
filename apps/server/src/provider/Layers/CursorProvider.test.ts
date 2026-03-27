import { describe, expect, it } from "vitest";

import { getCursorModelCapabilities, resolveCursorDispatchModel } from "./CursorProvider.ts";

describe("resolveCursorDispatchModel", () => {
  it("builds bracket notation from canonical base slugs and capabilities", () => {
    expect(resolveCursorDispatchModel("composer-2", { fastMode: true })).toBe(
      "composer-2[fast=true]",
    );
    expect(resolveCursorDispatchModel("gpt-5.4", undefined)).toBe(
      "gpt-5.4[reasoning=medium,context=272k,fast=false]",
    );
    expect(
      resolveCursorDispatchModel("claude-opus-4-6", {
        reasoning: "high",
        thinking: true,
        contextWindow: "1m",
      }),
    ).toBe("claude-opus-4-6[effort=high,thinking=true,context=1m]");
  });

  it("maps legacy cursor aliases onto the canonical base slug", () => {
    expect(resolveCursorDispatchModel("gpt-5.4-1m", undefined)).toBe(
      "gpt-5.4[reasoning=medium,context=272k,fast=false]",
    );
    expect(resolveCursorDispatchModel("auto", undefined)).toBe("default[]");
    expect(resolveCursorDispatchModel("claude-4.6-opus", undefined)).toBe(
      "claude-opus-4-6[effort=high,thinking=true,context=200k]",
    );
  });

  it("passes custom models through unchanged", () => {
    expect(resolveCursorDispatchModel("custom/internal-model", undefined)).toBe(
      "custom/internal-model[]",
    );
  });
});

describe("getCursorModelCapabilities", () => {
  it("resolves capabilities from canonical cursor base slugs", () => {
    expect(getCursorModelCapabilities("gpt-5.4").contextWindowOptions).toEqual([
      { value: "272k", label: "272k", isDefault: true },
      { value: "1m", label: "1M" },
    ]);
    expect(getCursorModelCapabilities("claude-opus-4-6").supportsThinkingToggle).toBe(true);
  });
});
