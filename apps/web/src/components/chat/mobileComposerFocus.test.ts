import { describe, expect, it, vi } from "vitest";
import { expandMobileComposerForKeyboard } from "./mobileComposerFocus";

describe("expandMobileComposerForKeyboard", () => {
  it("focuses after the expanded composer is committed and before release is scheduled", () => {
    const calls: string[] = [];

    expandMobileComposerForKeyboard({
      cancelPendingBlur: vi.fn(() => calls.push("cancel-blur")),
      cancelPendingExpandFocus: vi.fn(() => calls.push("cancel-expand-focus")),
      cancelPendingRelease: vi.fn(() => calls.push("cancel-release")),
      setExpandInFlight: vi.fn((inFlight) => calls.push(`in-flight:${inFlight}`)),
      commitExpandedState: vi.fn(() => calls.push("commit-expanded")),
      focusEditorAtEnd: vi.fn(() => calls.push("focus")),
      scheduleRelease: vi.fn(() => calls.push("schedule-release")),
    });

    expect(calls).toEqual([
      "cancel-blur",
      "cancel-expand-focus",
      "cancel-release",
      "in-flight:true",
      "commit-expanded",
      "focus",
      "schedule-release",
    ]);
  });
});
