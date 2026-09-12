import { expect, it } from "@effect/vitest";

import { ThreadId } from "@t3tools/contracts";

import { shouldReplaceCodexHistorySnapshot, shouldSendCodexHistoryRepairSnapshot } from "./ws.ts";

const codexThreadId = ThreadId.make("codex:native-thread");
const otherThreadId = ThreadId.make("thread:other");

it("replaces a Codex cache with a snapshot when its cursor predates repair", () => {
  expect(shouldReplaceCodexHistorySnapshot(codexThreadId, 99, 100)).toBe(true);
  expect(shouldReplaceCodexHistorySnapshot(codexThreadId, 100, 100)).toBe(false);
  expect(shouldReplaceCodexHistorySnapshot(codexThreadId, 101, 100)).toBe(false);
});

it("forces a first snapshot when a repaired Codex binding has no watermark yet", () => {
  expect(shouldReplaceCodexHistorySnapshot(codexThreadId, 99, undefined)).toBe(true);
});

it("heals a warm Codex cache once per WebSocket repair generation", () => {
  expect(shouldSendCodexHistoryRepairSnapshot(codexThreadId, 101, 100, false)).toBe(true);
  expect(shouldSendCodexHistoryRepairSnapshot(codexThreadId, 101, 100, true)).toBe(false);
  expect(shouldSendCodexHistoryRepairSnapshot(codexThreadId, 99, 100, true)).toBe(true);
});

it("does not change non-Codex or initial subscriptions", () => {
  expect(shouldReplaceCodexHistorySnapshot(otherThreadId, 99, 100)).toBe(false);
  expect(shouldReplaceCodexHistorySnapshot(codexThreadId, undefined, 100)).toBe(false);
  expect(shouldSendCodexHistoryRepairSnapshot(codexThreadId, undefined, 100, false)).toBe(false);
  expect(shouldSendCodexHistoryRepairSnapshot(otherThreadId, 99, 100, false)).toBe(false);
});
