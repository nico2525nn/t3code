import { describe, expect, it } from "vitest";
import { deriveThemeCssVariables, deriveThemeTokens } from "./derive";
import { BUILTIN_THEME_DOCUMENTS } from "./registry";

const t3codeLightTheme = BUILTIN_THEME_DOCUMENTS.find((theme) => theme.id === "t3code-light")!;
const t3codeDarkTheme = BUILTIN_THEME_DOCUMENTS.find((theme) => theme.id === "t3code-dark")!;
const warmLedgerDarkTheme = BUILTIN_THEME_DOCUMENTS.find(
  (theme) => theme.id === "warm-ledger-dark",
)!;
const coolCurrentLightTheme = BUILTIN_THEME_DOCUMENTS.find(
  (theme) => theme.id === "cool-current-light",
)!;

describe("deriveThemeTokens", () => {
  it("derives the full semantic token set from a light theme", () => {
    const tokens = deriveThemeTokens(t3codeLightTheme);

    expect(tokens.background).toBe("#fff");
    expect(tokens.foreground).toBe("oklch(26.9% 0 0)");
    expect(tokens.primary).toBe("oklch(0.488 0.217 264)");
    expect(tokens.accent).toBe("color-mix(in oklab, #000 4%, transparent)");
    expect(tokens.border).toBe("color-mix(in oklab, #000 8%, transparent)");
    expect(tokens["sidebar-blur"]).toBe("0px");
  });

  it("preserves the exact main-branch dark baseline for the default theme", () => {
    const tokens = deriveThemeTokens(t3codeDarkTheme);

    expect(tokens.background).toBe("color-mix(in srgb, oklch(14.5% 0 0) 95%, #fff)");
    expect(tokens.foreground).toBe("oklch(97% 0 0)");
    expect(tokens.primary).toBe("oklch(0.588 0.217 264)");
    expect(tokens.accent).toBe("color-mix(in oklab, #fff 4%, transparent)");
    expect(tokens.border).toBe("color-mix(in oklab, #fff 6%, transparent)");
    expect(tokens["sidebar-blur"]).toBe("0px");
  });

  it("strengthens borders and inputs at higher contrast", () => {
    const lowContrast = deriveThemeTokens({
      ...warmLedgerDarkTheme,
      contrast: 10,
    });
    const highContrast = deriveThemeTokens({
      ...warmLedgerDarkTheme,
      contrast: 90,
    });

    expect(highContrast.border).not.toBe(lowContrast.border);
    expect(highContrast.input).not.toBe(lowContrast.input);
  });

  it("applies overrides after derivation", () => {
    const tokens = deriveThemeTokens({
      ...coolCurrentLightTheme,
      overrides: {
        border: "#222222",
        diffAddition: "#123456",
      },
    });

    expect(tokens.border).toBe("#222222");
    expect(tokens["diff-addition"]).toBe("#123456");
  });

  it("exports css variable names in the expected format", () => {
    const variables = deriveThemeCssVariables(t3codeDarkTheme);

    expect(variables["--background"]).toBe("color-mix(in srgb, oklch(14.5% 0 0) 95%, #fff)");
    expect(variables["--ui-font-family"]).toContain("DM Sans");
  });
});
