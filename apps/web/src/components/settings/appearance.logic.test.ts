import { describe, expect, it } from "vitest";
import { BUILTIN_THEME_DOCUMENTS } from "@t3tools/shared/appearance/registry";
import {
  createDuplicateTheme,
  ensureUniqueThemeId,
  normalizeImportedThemeDocument,
  updateThemeDocument,
} from "./appearance.logic";

describe("appearance.logic", () => {
  it("deduplicates conflicting theme ids", () => {
    expect(ensureUniqueThemeId("codex", new Set(["codex", "codex-2"]))).toBe("codex-3");
  });

  it("normalizes imported themes into custom documents with unique ids", () => {
    const imported = normalizeImportedThemeDocument(
      BUILTIN_THEME_DOCUMENTS[0]!,
      new Set(["t3code-light"]),
    );
    expect(imported.origin).toBe("custom");
    expect(imported.id).toBe("t3code-light-2");
  });

  it("duplicates builtin themes before editing", () => {
    const duplicate = createDuplicateTheme(BUILTIN_THEME_DOCUMENTS[0]!, []);
    expect(duplicate.origin).toBe("custom");
    expect(duplicate.id).toBe("t3code-light-copy");
    expect(duplicate.radius).toBe(BUILTIN_THEME_DOCUMENTS[0]!.radius);
    expect(duplicate.fontSize).toBe(BUILTIN_THEME_DOCUMENTS[0]!.fontSize);
  });

  it("updates flat theme documents", () => {
    const updated = updateThemeDocument(BUILTIN_THEME_DOCUMENTS[0]!, (themeDocument) => ({
      ...themeDocument,
      contrast: 99,
    }));

    expect(updated.contrast).toBe(99);
    expect(updated.mode).toBe(BUILTIN_THEME_DOCUMENTS[0]!.mode);
  });
});
