import { describe, expect, it } from "@effect/vitest";

import {
  dedupeCodexHistoryMessages,
  reconcileCodexHistoryMessages,
  findCodexHistoryMessagesDuplicatedByLiveMessage,
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
        userAt("import:codex:thread:turn:user", "2026-09-10T08:00:00.000Z"),
        existing,
      ),
    ).toBe(false);
    expect(
      isDuplicateCodexHistoryMessageForExisting(
        userAt("import:codex:thread:turn:user", "2026-09-10T08:00:00.000Z", "different"),
        existing,
      ),
    ).toBe(false);
  });

  it("matches a live prompt when App Server history arrives several minutes later", () => {
    const imported = userAt("import:codex:thread:turn:user", "2026-09-09T08:53:15.000Z");
    const live = userAt("live-user", "2026-09-09T08:48:00.000Z");

    expect(isDuplicateCodexHistoryMessageForExisting(imported, [live])).toBe(true);
  });

  it("uses the native turn when both sides have one", () => {
    const imported = {
      ...userAt("import:codex:thread:turn:user", "2026-09-09T08:48:00.000Z"),
      turnId: "turn-2",
    };
    const sameTurn = { ...userAt("live-user-1", "2026-09-09T08:55:00.000Z"), turnId: "turn-2" };
    const differentTurn = {
      ...userAt("live-user-2", "2026-09-09T08:48:00.000Z"),
      turnId: "turn-1",
    };

    expect(isDuplicateCodexHistoryMessageForExisting(imported, [sameTurn])).toBe(true);
    expect(isDuplicateCodexHistoryMessageForExisting(imported, [differentTurn])).toBe(false);
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

  it("finds a history copy when the live message arrives after it", () => {
    const imported = assistantAt("import:codex:thread:turn:item");
    const live = assistantAt("assistant:item");

    expect(findCodexHistoryMessagesDuplicatedByLiveMessage(live, [imported])).toEqual([
      imported.messageId,
    ]);
    expect(findCodexHistoryMessagesDuplicatedByLiveMessage(live, [])).toEqual([]);
  });

  it("replaces doubled live text with the completed native item and removes extra segments", () => {
    const imported = {
      ...assistantAt("import:codex:thread:turn:item-1", "completed answer"),
      createdAt: "2026-09-09T08:48:41.000Z",
      turnId: "turn",
      phase: "final_answer",
      streaming: false,
    };
    const live = {
      ...assistantAt("assistant:item-1", "completed answercompleted answer"),
      createdAt: "2026-09-09T08:48:42.000Z",
      turnId: "turn",
      streaming: true,
    };
    const duplicateSegment = {
      ...assistantAt("assistant:item-1:segment:1", "answer"),
      streaming: true,
    };

    const reconciled = reconcileCodexHistoryMessages([imported, live, duplicateSegment]);

    expect(reconciled).toHaveLength(1);
    expect(reconciled[0]).toMatchObject({
      messageId: "assistant:item-1",
      text: "completed answer",
      createdAt: imported.createdAt,
      turnId: imported.turnId,
      phase: imported.phase,
      streaming: imported.streaming,
    });
  });
});
