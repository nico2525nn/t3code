import { describe, expect, it } from "vitest";

import { resolveClaudeApiModelId } from "./ClaudeModelId.ts";

describe("resolveClaudeApiModelId", () => {
  it("appends [1m] for 1m context window", () => {
    expect(
      resolveClaudeApiModelId({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { contextWindow: "1m" },
      }),
    ).toBe("claude-opus-4-6[1m]");
  });

  it("returns the canonical slug for default context windows", () => {
    expect(
      resolveClaudeApiModelId({
        provider: "claudeAgent",
        model: "claude-opus-4-6",
        options: { contextWindow: "200k" },
      }),
    ).toBe("claude-opus-4-6");
    expect(resolveClaudeApiModelId({ provider: "claudeAgent", model: "claude-opus-4-6" })).toBe(
      "claude-opus-4-6",
    );
  });
});
