import { describe, expect, it } from "@effect/vitest";

import {
  dedupeCodexHistoryMessages,
  isDuplicateCodexHistoryMessageForExisting,
} from "./codexMessageReconciliation.ts";

const userAt = (messageId: string, createdAt: string, text = "same prompt") => ({
  messageId,
  role: "user",
  text,
  createdAt,
});

const assistantAt = (messageId: string, text = "same answer") => ({
  messageId,
  role: "assistant",
  text,
  createdAt: "2026-09-09T08:48:40.000Z",
});

describe("Codex message reconciliation", () => {
  it("removes Codex history copies while retaining the live T3 rows", () => {
    const messages = [
      userAt("import:codex:thread:turn:user", "2026-09-09T08:48:00.000Z"),
      userAt("live-user", "2026-09-09T08:48:00.208Z"),
      assistantAt("import:codex:thread:turn:item"),
      assistantAt("assistant:item"),
      assistantAt("import:codex:thread:turn:other", "history-only answer"),
    ];

    expect(dedupeCodexHistoryMessages(messages).map((message) => message.messageId)).toEqual([
      "live-user",
      "assistant:item",
      "import:codex:thread:turn:other",
    ]);
  });

  it("matches repeated identical prompts one-to-one", () => {
    const messages = [
      userAt("import:codex:thread:turn-1:user", "2026-09-09T08:48:00.000Z"),
      userAt("import:codex:thread:turn-2:user", "2026-09-09T08:48:01.000Z"),
      userAt("live-user-1", "2026-09-09T08:48:00.200Z"),
      userAt("live-user-2", "2026-09-09T08:48:01.200Z"),
    ];

    expect(dedupeCodexHistoryMessages(messages).map((message) => message.messageId)).toEqual([
      "live-user-1",
      "live-user-2",
    ]);
  });

  it("does not treat a distant or differently worded prompt as the same message", () => {
    const existing = [userAt("live-user", "2026-09-09T08:48:10.000Z")];
    expect(
      isDuplicateCodexHistoryMessageForExisting(
        userAt("import:codex:thread:turn:user", "2026-09-09T08:48:00.000Z"),
        existing,
      ),
    ).toBe(false);
    expect(
      isDuplicateCodexHistoryMessageForExisting(
        userAt("import:codex:thread:turn:user", "2026-09-09T08:48:00.000Z", "different"),
        existing,
      ),
    ).toBe(false);
  });

  it("does not collapse imported history from another provider namespace", () => {
    const messages = [
      userAt("import:claude:thread:turn:user", "2026-09-09T08:48:00.000Z"),
      userAt("live-user", "2026-09-09T08:48:00.200Z"),
    ];
    expect(dedupeCodexHistoryMessages(messages).map((message) => message.messageId)).toEqual([
      "import:claude:thread:turn:user",
      "live-user",
    ]);
  });
});
