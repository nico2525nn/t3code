import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ThemeDocumentSchema } from "./appearanceTheme";
import { DEFAULT_CLIENT_SETTINGS, ServerSettingsPatch } from "./settings";

describe("DEFAULT_CLIENT_SETTINGS", () => {
  it("includes archive confirmation with a false default", () => {
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadArchive).toBe(false);
  });
});

describe("ThemeDocumentSchema", () => {
  it("decodes a valid custom theme document", () => {
    const theme = Schema.decodeUnknownSync(ThemeDocumentSchema)({
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
      contrast: 44,
      overrides: {
        diffAddition: "#0969da",
        diffDeletion: "#bc4c00",
      },
    });

    expect(theme.overrides?.diffAddition).toBe("#0969da");
    expect(theme.mode).toBe("light");
    expect(theme.radius).toBe("0.75rem");
    expect(theme.fontSize).toBe("15px");
  });

  it("rejects invalid seed colors", () => {
    expect(() =>
      Schema.decodeUnknownSync(ThemeDocumentSchema)({
        id: "bad-theme",
        name: "Bad Theme",
        version: 1,
        origin: "custom",
        mode: "light",
        accent: "blue",
        background: "#ffffff",
        foreground: "#0d0d0d",
        uiFontFamily: "sans-serif",
        codeFontFamily: "monospace",
        sidebarTranslucent: false,
        contrast: 40,
      }),
    ).toThrow();
  });
});

describe("ServerSettingsPatch", () => {
  it("accepts customThemes updates", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      activeLightThemeId: "custom-codex-light",
      activeDarkThemeId: "t3code-dark",
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
          sidebarTranslucent: false,
          contrast: 38,
        },
      ],
    });

    expect(patch.activeLightThemeId).toBe("custom-codex-light");
    expect(patch.customThemes?.[0]?.id).toBe("custom-codex-light");
  });
});
