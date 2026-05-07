import { ProviderInstanceId, ThreadId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { makePiExtensionUiBridge } from "./PiExtensionUiBridge.ts";

describe("makePiExtensionUiBridge", () => {
  it("provides a Pi-compatible plain-text theme and routes status to Pi panel state", async () => {
    const events: ProviderRuntimeEvent[] = [];
    const bridge = makePiExtensionUiBridge({
      getContext: () => ({
        threadId: ThreadId.make("thread-1"),
        providerInstanceId: ProviderInstanceId.make("pi"),
        activeTurnId: undefined,
      }),
      publishRuntimeEvent: async (event) => {
        events.push(event);
      },
    });

    expect(bridge.uiContext.theme.fg("dim", "generating")).toBe("generating");

    bridge.uiContext.setStatus("tps", bridge.uiContext.theme.fg("accent", "42 tok/s"));
    await Promise.resolve();

    expect(events[0]?.type).toBe("pi.ui.state.updated");
    const [event] = events;
    if (event?.type !== "pi.ui.state.updated") {
      throw new Error("expected pi.ui.state.updated");
    }
    expect(event.payload.surface).toBe("status");
    expect(event.payload.key).toBe("tps");
    expect(event.payload.text).toBe("42 tok/s");
  });

  it("publishes only JSON-safe extension activity data", async () => {
    const events: ProviderRuntimeEvent[] = [];
    const bridge = makePiExtensionUiBridge({
      getContext: () => ({
        threadId: ThreadId.make("thread-1"),
        providerInstanceId: ProviderInstanceId.make("pi"),
        activeTurnId: undefined,
      }),
      publishRuntimeEvent: async (event) => {
        events.push(event);
      },
    });

    await bridge.publishActivity({
      activityType: "widget",
      message: "Widget updated",
      data: {
        path: "/tmp/pi-extension.ts",
        baseDir: undefined,
        render: () => undefined,
        nested: { ok: true, missing: undefined },
      },
    });

    expect(events[0]?.type).toBe("extension.activity");
    const [event] = events;
    if (event?.type !== "extension.activity") {
      throw new Error("expected extension.activity");
    }
    expect(event.payload.data).toEqual({
      path: "/tmp/pi-extension.ts",
      nested: { ok: true },
    });
  });
});
