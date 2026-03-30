import { describe, expect, it } from "vitest";
import { parseAppearanceCache, resolveAppearanceMode } from "./useAppearance";

describe("resolveAppearanceMode", () => {
  it("resolves explicit modes without consulting system preference", () => {
    expect(resolveAppearanceMode("light", true)).toBe("light");
    expect(resolveAppearanceMode("dark", false)).toBe("dark");
  });

  it("resolves system mode from the current platform preference", () => {
    expect(resolveAppearanceMode("system", true)).toBe("dark");
    expect(resolveAppearanceMode("system", false)).toBe("light");
  });
});

describe("parseAppearanceCache", () => {
  it("decodes valid cached appearance snapshots", () => {
    const parsed = parseAppearanceCache(
      JSON.stringify({
        colorMode: "system",
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
      }),
    );

    expect(parsed?.activeLightThemeId).toBe("custom-codex-light");
    expect(parsed?.activeDarkThemeId).toBe("custom-codex-dark");
    expect(parsed?.customThemes[0]?.id).toBe("custom-codex-light");
    expect(parsed?.customThemes[0]?.radius).toBe("0.75rem");
    expect(parsed?.customThemes[0]?.fontSize).toBe("15px");
  });

  it("drops invalid cache payloads", () => {
    expect(
      parseAppearanceCache(
        JSON.stringify({
          colorMode: "system",
          activeLightThemeId: "custom-codex-light",
          activeDarkThemeId: "custom-codex-dark",
          customThemes: [{ id: "bad" }],
        }),
      ),
    ).toBeNull();
  });
});
