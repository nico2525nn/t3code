import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { ServerProvider } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);

describe("ServerProvider", () => {
  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes Pi provider inventory metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "pi",
      driver: "pi",
      enabled: true,
      installed: true,
      version: "0.73.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      pi: {
        extensionPaths: ["/Users/davis/.pi/agent/extensions/tps-tracker.ts"],
        tools: [
          {
            name: "search",
            description: "Search docs",
            sourceInfo: { path: "/Users/davis/.pi/agent/extensions/tps-tracker.ts" },
          },
        ],
        flags: ["verbose"],
      },
    });

    expect(parsed.pi?.extensionPaths).toEqual(["/Users/davis/.pi/agent/extensions/tps-tracker.ts"]);
    expect(parsed.pi?.tools[0]?.name).toBe("search");
    expect(parsed.pi?.tools[0]?.sourceInfo).toEqual({
      path: "/Users/davis/.pi/agent/extensions/tps-tracker.ts",
    });
    expect(parsed.pi?.flags).toEqual(["verbose"]);
  });

  it("rejects non-JSON Pi provider inventory metadata", () => {
    expect(() =>
      decodeServerProvider({
        instanceId: "pi",
        driver: "pi",
        enabled: true,
        installed: true,
        version: "0.73.0",
        status: "ready",
        auth: {
          status: "authenticated",
        },
        checkedAt: "2026-04-10T00:00:00.000Z",
        models: [],
        pi: {
          extensionPaths: ["/Users/davis/.pi/agent/extensions/pi-mcp/src/index.ts"],
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
});
