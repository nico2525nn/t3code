import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderRuntimeEvent } from "./providerRuntime.ts";

const decodeRuntimeEvent = Schema.decodeUnknownSync(ProviderRuntimeEvent);

describe("ProviderRuntimeEvent", () => {
  it("accepts fork-provided driver kinds as branded slugs", () => {
    const parsed = decodeRuntimeEvent({
      type: "session.started",
      eventId: "event-ollama-session",
      provider: "ollama",
      providerInstanceId: "ollama_local",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      payload: {
        message: "started",
      },
    });

    expect(parsed.provider).toBe("ollama");
    expect(parsed.providerInstanceId).toBe("ollama_local");
  });

  it("decodes turn.plan.updated for plan rendering", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.plan.updated",
      eventId: "event-1",
      provider: "claudeAgent",
      sessionId: "runtime-session-1",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        explanation: "Implement schema updates",
        plan: [
          { step: "Define event union", status: "completed" },
          { step: "Wire adapter mapping", status: "inProgress" },
        ],
      },
    });

    expect(parsed.type).toBe("turn.plan.updated");
    if (parsed.type !== "turn.plan.updated") {
      throw new Error("expected turn.plan.updated");
    }
    expect(parsed.payload.plan).toHaveLength(2);
    expect(parsed.payload.plan[1]?.status).toBe("inProgress");
  });

  it("decodes proposed-plan completion events", () => {
    const parsed = decodeRuntimeEvent({
      type: "turn.proposed.completed",
      eventId: "event-proposed-plan-1",
      provider: "codex",
      createdAt: "2026-02-28T00:00:00.000Z",
      threadId: "thread-1",
      turnId: "turn-1",
      payload: {
        planMarkdown: "# Ship it",
      },
    });

    expect(parsed.type).toBe("turn.proposed.completed");
    if (parsed.type !== "turn.proposed.completed") {
      throw new Error("expected turn.proposed.completed");
    }
    expect(parsed.payload.planMarkdown).toBe("# Ship it");
  });

  it("decodes user-input.requested with structured questions", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-2",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "sandbox_mode",
            header: "Sandbox",
            question: "Which mode should be used?",
            options: [
              {
                label: "workspace-write",
                description: "Allow edits in workspace only",
              },
              {
                label: "danger-full-access",
                description: "Allow unrestricted access",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.id).toBe("sandbox_mode");
    expect(parsed.payload.questions[0]?.options).toHaveLength(2);
  });

  it("decodes Pi text and textarea user-input questions without options", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.requested",
      eventId: "event-pi-input-1",
      provider: "pi",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        questions: [
          {
            id: "token",
            header: "Token",
            question: "Enter token",
            inputKind: "text",
            options: [],
            placeholder: "sk-...",
          },
          {
            id: "notes",
            header: "Notes",
            question: "Edit notes",
            inputKind: "textarea",
            options: [],
            prefill: "Existing notes",
          },
        ],
      },
    });

    expect(parsed.type).toBe("user-input.requested");
    if (parsed.type !== "user-input.requested") {
      throw new Error("expected user-input.requested");
    }
    expect(parsed.payload.questions[0]?.options).toEqual([]);
    expect(parsed.payload.questions[1]?.prefill).toBe("Existing notes");
  });

  it("decodes non-fatal extension activity events", () => {
    const parsed = decodeRuntimeEvent({
      type: "extension.activity",
      eventId: "event-pi-activity-1",
      provider: "pi",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      payload: {
        source: "pi.extension.ui",
        activityType: "notify",
        message: "Copied thread",
        severity: "info",
        uiOnly: true,
      },
    });

    expect(parsed.type).toBe("extension.activity");
    if (parsed.type !== "extension.activity") {
      throw new Error("expected extension.activity");
    }
    expect(parsed.payload.uiOnly).toBe(true);
  });

  it("decodes Pi panel state updates", () => {
    const parsed = decodeRuntimeEvent({
      type: "pi.ui.state.updated",
      eventId: "event-pi-ui-1",
      provider: "pi",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      payload: {
        source: "pi.extension.ui",
        surface: "status",
        key: "tps",
        label: "tps",
        text: "42 tok/s",
        state: "set",
        uiOnly: true,
      },
    });

    expect(parsed.type).toBe("pi.ui.state.updated");
    if (parsed.type !== "pi.ui.state.updated") {
      throw new Error("expected pi.ui.state.updated");
    }
    expect(parsed.payload.state).toBe("set");
    expect(parsed.payload.uiOnly).toBe(true);
  });

  it("decodes Pi extension configured snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "pi.extension.configured",
      eventId: "event-pi-config-1",
      provider: "pi",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      payload: {
        source: "pi.extension",
        extensionPaths: ["/Users/davis/.pi/agent/extensions/tps-tracker.ts"],
        slashCommands: [
          {
            name: "usage",
            description: "Show usage",
            source: "extension",
            sourceInfo: { path: "/Users/davis/.pi/agent/extensions/tps-tracker.ts" },
          },
        ],
        tools: [
          {
            name: "search",
            description: "Search",
            sourceInfo: { path: "/Users/davis/.pi/agent/extensions/tps-tracker.ts" },
          },
        ],
        flags: ["verbose"],
        models: [{ slug: "extension/model", name: "Extension Model" }],
      },
    });

    expect(parsed.type).toBe("pi.extension.configured");
    if (parsed.type !== "pi.extension.configured") {
      throw new Error("expected pi.extension.configured");
    }
    expect(parsed.payload.slashCommands[0]?.name).toBe("usage");
    expect(parsed.payload.tools[0]?.sourceInfo).toEqual({
      path: "/Users/davis/.pi/agent/extensions/tps-tracker.ts",
    });
  });

  it("rejects non-JSON Pi extension configured metadata", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "pi.extension.configured",
        eventId: "event-pi-config-unsafe-1",
        provider: "pi",
        createdAt: "2026-02-28T00:00:01.000Z",
        threadId: "thread-2",
        payload: {
          source: "pi.extension",
          extensionPaths: ["/Users/davis/.pi/agent/extensions/pi-mcp/src/index.ts"],
          slashCommands: [],
          tools: [
            {
              name: "search",
              sourceInfo: {
                path: "/Users/davis/.pi/agent/extensions/pi-mcp/src/index.ts",
                baseDir: undefined,
              },
            },
          ],
          flags: [],
        },
      }),
    ).toThrow();
  });

  it("decodes Pi extension diagnostics with repeat counts", () => {
    const parsed = decodeRuntimeEvent({
      type: "pi.extension.diagnostic",
      eventId: "event-pi-diagnostic-1",
      provider: "pi",
      createdAt: "2026-02-28T00:00:01.000Z",
      threadId: "thread-2",
      payload: {
        source: "pi.extension",
        message: "tps-tracker.ts failed during message_update",
        severity: "error",
        visibility: "pi-panel",
        event: "message_update",
        diagnosticKey: "tps-tracker :: message_update :: theme.fg is not a function",
        repeatCount: 100,
        hiddenCount: 99,
      },
    });

    expect(parsed.type).toBe("pi.extension.diagnostic");
    if (parsed.type !== "pi.extension.diagnostic") {
      throw new Error("expected pi.extension.diagnostic");
    }
    expect(parsed.payload.visibility).toBe("pi-panel");
    expect(parsed.payload.hiddenCount).toBe(99);
  });

  it("decodes user-input.resolved with answer map", () => {
    const parsed = decodeRuntimeEvent({
      type: "user-input.resolved",
      eventId: "event-3",
      provider: "claudeAgent",
      sessionId: "runtime-session-2",
      createdAt: "2026-02-28T00:00:02.000Z",
      threadId: "thread-2",
      requestId: "request-1",
      payload: {
        answers: {
          sandbox_mode: "workspace-write",
        },
      },
    });

    expect(parsed.type).toBe("user-input.resolved");
    if (parsed.type !== "user-input.resolved") {
      throw new Error("expected user-input.resolved");
    }
    expect(parsed.payload.answers.sandbox_mode).toBe("workspace-write");
  });

  it("rejects legacy message.delta type", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "message.delta",
        eventId: "event-4",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        payload: { delta: "legacy" },
      }),
    ).toThrow();
  });

  it("rejects empty branded canonical ids", () => {
    expect(() =>
      decodeRuntimeEvent({
        type: "runtime.error",
        eventId: "event-5",
        provider: "codex",
        sessionId: "runtime-session-3",
        createdAt: "2026-02-28T00:00:03.000Z",
        threadId: "   ",
        payload: { message: "boom" },
      }),
    ).toThrow();
  });

  it("decodes normalized thread token usage snapshots", () => {
    const parsed = decodeRuntimeEvent({
      type: "thread.token-usage.updated",
      eventId: "event-token-usage-1",
      provider: "claudeAgent",
      createdAt: "2026-02-28T00:00:04.000Z",
      threadId: "thread-1",
      payload: {
        usage: {
          usedTokens: 31251,
          maxTokens: 200000,
          toolUses: 25,
          durationMs: 43567,
        },
      },
    });

    expect(parsed.type).toBe("thread.token-usage.updated");
    if (parsed.type !== "thread.token-usage.updated") {
      throw new Error("expected thread.token-usage.updated");
    }
    expect(parsed.payload.usage.maxTokens).toBe(200000);
    expect(parsed.payload.usage.usedTokens).toBe(31251);
  });
});
