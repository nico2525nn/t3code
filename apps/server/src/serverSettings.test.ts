import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { ServerConfig } from "./config";
import { ServerSettingsLive, ServerSettingsService } from "./serverSettings";

const makeServerSettingsLayer = () =>
  ServerSettingsLive.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3code-server-settings-test-",
        }),
      ),
    ),
  );

it.layer(NodeServices.layer)("server settings", (it) => {
  it.effect("decodes nested settings patches", () =>
    Effect.sync(() => {
      const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

      assert.deepEqual(decodePatch({ providers: { codex: { binaryPath: "/tmp/codex" } } }), {
        providers: { codex: { binaryPath: "/tmp/codex" } },
      });

      assert.deepEqual(
        decodePatch({
          textGenerationModelSelection: {
            options: {
              fastMode: false,
            },
          },
        }),
        {
          textGenerationModelSelection: {
            options: {
              fastMode: false,
            },
          },
        },
      );
    }),
  );

  it.effect("deep merges nested settings updates without dropping siblings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/usr/local/bin/codex",
            homePath: "/Users/julius/.codex",
          },
          claudeAgent: {
            binaryPath: "/usr/local/bin/claude",
            customModels: ["claude-custom"],
          },
        },
        textGenerationModelSelection: {
          provider: "codex",
          model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
          options: {
            reasoningEffort: "high",
            fastMode: true,
          },
        },
      });

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
        textGenerationModelSelection: {
          options: {
            fastMode: false,
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "/Users/julius/.codex",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/usr/local/bin/claude",
        customModels: ["claude-custom"],
      });
      assert.deepEqual(next.textGenerationModelSelection, {
        provider: "codex",
        model: DEFAULT_SERVER_SETTINGS.textGenerationModelSelection.model,
        options: {
          reasoningEffort: "high",
          fastMode: false,
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("trims provider path settings when updates are applied", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "  /opt/homebrew/bin/codex  ",
            homePath: "   ",
          },
          claudeAgent: {
            binaryPath: "  /opt/homebrew/bin/claude  ",
          },
        },
      });

      assert.deepEqual(next.providers.codex, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/codex",
        homePath: "",
        customModels: [],
      });
      assert.deepEqual(next.providers.claudeAgent, {
        enabled: true,
        binaryPath: "/opt/homebrew/bin/claude",
        customModels: [],
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("defaults blank binary paths to provider executables", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;

      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "   ",
          },
          claudeAgent: {
            binaryPath: "",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "codex");
      assert.equal(next.providers.claudeAgent.binaryPath, "claude");
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("writes only non-default server settings to disk", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const next = yield* serverSettings.updateSettings({
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
      });

      assert.equal(next.providers.codex.binaryPath, "/opt/homebrew/bin/codex");

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        providers: {
          codex: {
            binaryPath: "/opt/homebrew/bin/codex",
          },
        },
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );

  it.effect("persists custom themes as part of server-authoritative appearance settings", () =>
    Effect.gen(function* () {
      const serverSettings = yield* ServerSettingsService;
      const serverConfig = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      const next = yield* serverSettings.updateSettings({
        activeLightThemeId: "custom-codex-light",
        activeDarkThemeId: "custom-codex-dark",
        customThemes: [
          {
            id: "custom-codex-light",
            name: "Custom Codex Light",
            version: 1,
            origin: "custom",
            mode: "light",
            radius: "0.75rem",
            fontSize: "15px",
            accent: "#0169cc",
            background: "#ffffff",
            foreground: "#0d0d0d",
            uiFontFamily: '"IBM Plex Sans", sans-serif',
            codeFontFamily: '"IBM Plex Mono", monospace',
            sidebarTranslucent: true,
            contrast: 46,
          },
          {
            id: "custom-codex-dark",
            name: "Custom Codex Dark",
            version: 1,
            origin: "custom",
            mode: "dark",
            radius: "0.75rem",
            fontSize: "15px",
            accent: "#0169cc",
            background: "#111111",
            foreground: "#fcfcfc",
            uiFontFamily: '"IBM Plex Sans", sans-serif',
            codeFontFamily: '"IBM Plex Mono", monospace',
            sidebarTranslucent: true,
            contrast: 41,
          },
        ],
      });

      assert.equal(next.activeLightThemeId, "custom-codex-light");
      assert.equal(next.activeDarkThemeId, "custom-codex-dark");
      assert.equal(next.customThemes.length, 2);

      const raw = yield* fileSystem.readFileString(serverConfig.settingsPath);
      assert.deepEqual(JSON.parse(raw), {
        activeLightThemeId: "custom-codex-light",
        activeDarkThemeId: "custom-codex-dark",
        customThemes: [
          {
            id: "custom-codex-light",
            name: "Custom Codex Light",
            version: 1,
            origin: "custom",
            mode: "light",
            radius: "0.75rem",
            fontSize: "15px",
            accent: "#0169cc",
            background: "#ffffff",
            foreground: "#0d0d0d",
            uiFontFamily: '"IBM Plex Sans", sans-serif',
            codeFontFamily: '"IBM Plex Mono", monospace',
            sidebarTranslucent: true,
            contrast: 46,
          },
          {
            id: "custom-codex-dark",
            name: "Custom Codex Dark",
            version: 1,
            origin: "custom",
            mode: "dark",
            radius: "0.75rem",
            fontSize: "15px",
            accent: "#0169cc",
            background: "#111111",
            foreground: "#fcfcfc",
            uiFontFamily: '"IBM Plex Sans", sans-serif',
            codeFontFamily: '"IBM Plex Mono", monospace',
            sidebarTranslucent: true,
            contrast: 41,
          },
        ],
      });
    }).pipe(Effect.provide(makeServerSettingsLayer())),
  );
});
