import type { ThemeDocument } from "@t3tools/contracts";
import {
  canonicalizeThemeDocument,
  duplicateThemeDocument,
  getReservedThemeIds,
} from "@t3tools/shared/appearance/registry";

function toKebabCase(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function slugifyThemeId(value: string): string {
  return toKebabCase(value) || "custom-theme";
}

export function ensureUniqueThemeId(baseId: string, existingIds: ReadonlySet<string>): string {
  if (!existingIds.has(baseId)) {
    return baseId;
  }

  let index = 2;
  while (existingIds.has(`${baseId}-${index}`)) {
    index += 1;
  }
  return `${baseId}-${index}`;
}

export function normalizeImportedThemeDocument(
  themeDocument: ThemeDocument,
  existingThemeIds: ReadonlySet<string>,
): ThemeDocument {
  const baseId = slugifyThemeId(themeDocument.id || themeDocument.name);
  const uniqueId = ensureUniqueThemeId(baseId, existingThemeIds);

  return canonicalizeThemeDocument(
    {
      ...themeDocument,
      id: uniqueId,
      origin: "custom",
    },
    "custom",
  );
}

export function createDuplicateTheme(
  themeDocument: ThemeDocument,
  customThemes: ReadonlyArray<ThemeDocument>,
) {
  const existingThemeIds = new Set<string>([
    ...getReservedThemeIds(),
    ...customThemes.map((theme) => theme.id),
  ]);
  const baseId = slugifyThemeId(`${themeDocument.id}-copy`);
  const nextId = ensureUniqueThemeId(baseId, existingThemeIds);
  const nextName =
    nextId === `${themeDocument.id}-copy`
      ? `${themeDocument.name} Copy`
      : `${themeDocument.name} Copy ${nextId.split("-").at(-1)}`;
  return duplicateThemeDocument(themeDocument, nextId, nextName);
}

export function replaceCustomTheme(
  customThemes: ReadonlyArray<ThemeDocument>,
  nextTheme: ThemeDocument,
): Array<ThemeDocument> {
  const next = customThemes.filter((theme) => theme.id !== nextTheme.id);
  next.push(canonicalizeThemeDocument(nextTheme, "custom"));
  return next;
}

export function updateThemeDocument(
  themeDocument: ThemeDocument,
  updater: (themeDocument: ThemeDocument) => ThemeDocument,
): ThemeDocument {
  return updater(themeDocument);
}
