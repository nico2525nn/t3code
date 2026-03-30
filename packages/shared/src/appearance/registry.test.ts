import { describe, expect, it } from "vitest";
import {
  BUILTIN_THEME_DOCUMENTS,
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  duplicateThemeDocument,
  resolveThemeDocument,
  serializeAppearanceSnapshot,
  serializeThemeDocument,
} from "./registry";

describe("appearance registry", () => {
  it("resolves builtin themes before falling back to custom themes", () => {
    const resolved = resolveThemeDocument(
      DEFAULT_LIGHT_THEME_ID,
      [duplicateThemeDocument(BUILTIN_THEME_DOCUMENTS[0]!, DEFAULT_LIGHT_THEME_ID, "Custom Clash")],
      "light",
    );

    expect(resolved.origin).toBe("builtin");
    expect(resolved.id).toBe(DEFAULT_LIGHT_THEME_ID);
  });

  it("duplicates builtin themes into custom theme documents", () => {
    const duplicated = duplicateThemeDocument(
      BUILTIN_THEME_DOCUMENTS[0]!,
      "custom-copy",
      "Custom Copy",
    );

    expect(duplicated.origin).toBe("custom");
    expect(duplicated.id).toBe("custom-copy");
    expect(duplicated.accent).toBe(BUILTIN_THEME_DOCUMENTS[0]!.accent);
    expect(duplicated.mode).toBe(BUILTIN_THEME_DOCUMENTS[0]!.mode);
  });

  it("serializes themes and appearance snapshots deterministically", () => {
    const theme = duplicateThemeDocument(BUILTIN_THEME_DOCUMENTS[0]!, "custom-copy", "Custom Copy");
    const themeJson = serializeThemeDocument(theme);
    const snapshotJson = serializeAppearanceSnapshot({
      colorMode: "system",
      activeLightThemeId: "custom-copy",
      activeDarkThemeId: DEFAULT_DARK_THEME_ID,
      customThemes: [theme],
    });

    expect(themeJson).toContain('"id": "custom-copy"');
    expect(themeJson).toContain('"radius": "0.625rem"');
    expect(themeJson).toContain('"fontSize": "16px"');
    expect(snapshotJson).toContain('"activeLightThemeId":"custom-copy"');
    expect(snapshotJson).toContain(`"activeDarkThemeId":"${DEFAULT_DARK_THEME_ID}"`);
  });
});
