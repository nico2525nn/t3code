import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { derivePiRuntimePanelState } from "./PiRuntimePanel";

function makeActivity(overrides: {
  readonly id: string;
  readonly createdAt?: string;
  readonly kind: string;
  readonly summary?: string;
  readonly tone?: OrchestrationThreadActivity["tone"];
  readonly payload: Record<string, unknown>;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(overrides.id),
    createdAt: overrides.createdAt ?? "2026-02-23T00:00:00.000Z",
    kind: overrides.kind,
    summary: overrides.summary ?? overrides.kind,
    tone: overrides.tone ?? "info",
    payload: overrides.payload,
    turnId: null,
  };
}

describe("derivePiRuntimePanelState", () => {
  it("derives status summaries, extension inventory, and deduped diagnostics", () => {
    const state = derivePiRuntimePanelState({
      activities: [
        makeActivity({
          id: "config",
          kind: "pi.extension.configured",
          payload: {
            source: "pi.extension",
            extensionPaths: ["/Users/davis/.pi/agent/extensions/tps-tracker.ts"],
            slashCommands: [{ name: "usage", description: "Show usage" }],
            tools: [{ name: "search" }],
            flags: [],
            models: [
              {
                slug: "extension/model",
                name: "Extension Model",
                isCustom: false,
                capabilities: null,
              },
            ],
          },
        }),
        makeActivity({
          id: "status",
          kind: "pi.ui.state.updated",
          payload: {
            source: "pi.extension.ui",
            surface: "status",
            key: "tps",
            label: "tps",
            text: "42 tok/s",
          },
        }),
        makeActivity({
          id: "diag-1",
          createdAt: "2026-02-23T00:00:01.000Z",
          kind: "pi.extension.diagnostic",
          tone: "error",
          payload: {
            source: "pi.extension",
            message: "message_update failed",
            severity: "error",
            diagnosticKey: "tps :: message_update :: theme",
            extensionPath: "/Users/davis/.pi/agent/extensions/tps-tracker.ts",
            event: "message_update",
            hiddenCount: 1,
          },
        }),
        makeActivity({
          id: "diag-2",
          createdAt: "2026-02-23T00:00:02.000Z",
          kind: "pi.extension.diagnostic",
          tone: "error",
          payload: {
            source: "pi.extension",
            message: "message_update failed",
            severity: "error",
            diagnosticKey: "tps :: message_update :: theme",
            extensionPath: "/Users/davis/.pi/agent/extensions/tps-tracker.ts",
            event: "message_update",
            hiddenCount: 99,
          },
        }),
      ],
      provider: null,
      skills: [],
      cwd: "/Users/davis/project",
      branch: "main",
      model: "openai/gpt-5.5",
    });

    expect(state.summaryStatus).toBe("tps 42 tok/s");
    expect(state.extensions[0]?.name).toBe("tps-tracker.ts");
    expect(state.slashCommands[0]?.name).toBe("usage");
    expect(state.models[0]?.slug).toBe("extension/model");
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]?.hiddenCount).toBe(99);
  });

  it("uses provider snapshot metadata before Pi session activity exists", () => {
    const state = derivePiRuntimePanelState({
      activities: [],
      provider: {
        instanceId: ProviderInstanceId.make("pi"),
        driver: ProviderDriverKind.make("pi"),
        displayName: "Pi",
        enabled: true,
        installed: true,
        version: "0.73.0",
        status: "ready",
        auth: { status: "authenticated", type: "pi", label: "Pi" },
        checkedAt: "2026-02-23T00:00:00.000Z",
        models: [
          {
            slug: "openai/gpt-5.5",
            name: "GPT-5.5",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [
          { name: "reload", description: "Reload extensions, skills, prompts, and themes" },
          { name: "usage", description: "Show usage" },
        ],
        skills: [
          {
            name: "review",
            displayName: "review",
            path: "/Users/davis/.pi/agent/skills/review/SKILL.md",
            enabled: true,
          },
        ],
        pi: {
          extensionPaths: ["/Users/davis/.pi/agent/extensions/tps-tracker.ts"],
          tools: [{ name: "search" }],
          flags: ["verbose"],
        },
      },
      skills: undefined,
      cwd: "/Users/davis/project",
      branch: "main",
      model: "openai/gpt-5.5",
    });

    expect(state.extensions[0]?.name).toBe("tps-tracker.ts");
    expect(state.skills[0]?.name).toBe("review");
    expect(state.slashCommands.map((command) => command.name)).toEqual(["reload", "usage"]);
    expect(state.models[0]?.slug).toBe("openai/gpt-5.5");
  });
});
