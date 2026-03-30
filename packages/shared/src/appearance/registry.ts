import {
  DEFAULT_ACTIVE_DARK_THEME_ID,
  DEFAULT_ACTIVE_LIGHT_THEME_ID,
  DEFAULT_THEME_FONT_SIZE,
  DEFAULT_THEME_RADIUS,
  type ThemeDocument,
  type ThemeMode,
  type ThemeOrigin,
} from "@t3tools/contracts";
import { serializeThemeDerivedOverrides } from "./derive";

export interface BuiltinThemePreset {
  readonly description: string;
  readonly theme: ThemeDocument;
}

const DEFAULT_UI_FONT = '"DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
const DEFAULT_CODE_FONT =
  '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace';

type ThemeDocumentInput = {
  id: string;
  name: string;
  description: string;
  mode: ThemeMode;
  radius?: string;
  fontSize?: string;
  accent: string;
  background: string;
  foreground: string;
  uiFontFamily: string;
  codeFontFamily: string;
  sidebarTranslucent: boolean;
  contrast: number;
  overrides?: ThemeDocument["overrides"];
};

function makeThemeDocument(input: ThemeDocumentInput): BuiltinThemePreset {
  return {
    description: input.description,
    theme: {
      id: input.id,
      name: input.name,
      version: 1,
      origin: "builtin",
      mode: input.mode,
      radius: input.radius ?? DEFAULT_THEME_RADIUS,
      fontSize: input.fontSize ?? DEFAULT_THEME_FONT_SIZE,
      accent: input.accent,
      background: input.background,
      foreground: input.foreground,
      uiFontFamily: input.uiFontFamily,
      codeFontFamily: input.codeFontFamily,
      sidebarTranslucent: input.sidebarTranslucent,
      contrast: input.contrast,
      ...(input.overrides ? { overrides: input.overrides } : {}),
    },
  };
}

export const BUILTIN_THEME_PRESETS: readonly BuiltinThemePreset[] = [
  makeThemeDocument({
    id: DEFAULT_ACTIVE_LIGHT_THEME_ID,
    name: "T3Code Light",
    mode: "light",
    description: "Clean neutral foundations with a sharper blue accent.",
    accent: "#0169cc",
    background: "#ffffff",
    foreground: "#262626",
    uiFontFamily: DEFAULT_UI_FONT,
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: false,
    contrast: 46,
    overrides: {
      background: "#fff",
      foreground: "oklch(26.9% 0 0)",
      card: "#fff",
      cardForeground: "oklch(26.9% 0 0)",
      popover: "#fff",
      popoverForeground: "oklch(26.9% 0 0)",
      primary: "oklch(0.488 0.217 264)",
      primaryForeground: "#fff",
      secondary: "color-mix(in oklab, #000 4%, transparent)",
      secondaryForeground: "oklch(26.9% 0 0)",
      muted: "color-mix(in oklab, #000 4%, transparent)",
      mutedForeground: "color-mix(in srgb, oklch(55.6% 0 0) 90%, #000)",
      accentSurface: "color-mix(in oklab, #000 4%, transparent)",
      accentForeground: "oklch(26.9% 0 0)",
      border: "color-mix(in oklab, #000 8%, transparent)",
      input: "color-mix(in oklab, #000 10%, transparent)",
      ring: "oklch(0.488 0.217 264)",
      destructive: "oklch(63.7% 0.237 25.331)",
      destructiveForeground: "oklch(50.5% 0.213 27.518)",
      info: "oklch(62.3% 0.214 259.815)",
      infoForeground: "oklch(48.8% 0.243 264.376)",
      success: "oklch(69.6% 0.17 162.48)",
      successForeground: "oklch(50.8% 0.118 165.612)",
      warning: "oklch(76.9% 0.188 70.08)",
      warningForeground: "oklch(55.5% 0.163 48.998)",
      sidebar: "transparent",
      sidebarForeground: "oklch(26.9% 0 0)",
      sidebarAccent: "color-mix(in oklab, #000 4%, transparent)",
      sidebarAccentForeground: "oklch(26.9% 0 0)",
      sidebarBorder: "color-mix(in oklab, #000 8%, transparent)",
    },
  }),
  makeThemeDocument({
    id: DEFAULT_ACTIVE_DARK_THEME_ID,
    name: "T3Code Dark",
    mode: "dark",
    description: "Clean neutral foundations with a sharper blue accent.",
    accent: "#0169cc",
    background: "#17171a",
    foreground: "#f5f5f5",
    uiFontFamily: DEFAULT_UI_FONT,
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: false,
    contrast: 41,
    overrides: {
      background: "color-mix(in srgb, oklch(14.5% 0 0) 95%, #fff)",
      foreground: "oklch(97% 0 0)",
      card: "color-mix(in srgb, color-mix(in srgb, oklch(14.5% 0 0) 95%, #fff) 98%, #fff)",
      cardForeground: "oklch(97% 0 0)",
      popover: "color-mix(in srgb, color-mix(in srgb, oklch(14.5% 0 0) 95%, #fff) 98%, #fff)",
      popoverForeground: "oklch(97% 0 0)",
      primary: "oklch(0.588 0.217 264)",
      primaryForeground: "#fff",
      secondary: "color-mix(in oklab, #fff 4%, transparent)",
      secondaryForeground: "oklch(97% 0 0)",
      muted: "color-mix(in oklab, #fff 4%, transparent)",
      mutedForeground: "color-mix(in srgb, oklch(55.6% 0 0) 90%, #fff)",
      accentSurface: "color-mix(in oklab, #fff 4%, transparent)",
      accentForeground: "oklch(97% 0 0)",
      border: "color-mix(in oklab, #fff 6%, transparent)",
      input: "color-mix(in oklab, #fff 8%, transparent)",
      ring: "oklch(0.588 0.217 264)",
      destructive: "color-mix(in srgb, oklch(63.7% 0.237 25.331) 90%, #fff)",
      destructiveForeground: "oklch(70.4% 0.191 22.216)",
      info: "oklch(62.3% 0.214 259.815)",
      infoForeground: "oklch(70.7% 0.165 254.624)",
      success: "oklch(69.6% 0.17 162.48)",
      successForeground: "oklch(76.5% 0.177 163.223)",
      warning: "oklch(76.9% 0.188 70.08)",
      warningForeground: "oklch(82.8% 0.189 84.429)",
      sidebar: "transparent",
      sidebarForeground: "oklch(97% 0 0)",
      sidebarAccent: "color-mix(in oklab, #fff 4%, transparent)",
      sidebarAccentForeground: "oklch(97% 0 0)",
      sidebarBorder: "color-mix(in oklab, #fff 6%, transparent)",
    },
  }),
  makeThemeDocument({
    id: "warm-ledger-light",
    name: "Warm Ledger Light",
    mode: "light",
    description: "Editorial warmth with paper-like light mode.",
    accent: "#b35b2c",
    background: "#f7f0e8",
    foreground: "#201814",
    uiFontFamily: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: false,
    contrast: 56,
  }),
  makeThemeDocument({
    id: "warm-ledger-dark",
    name: "Warm Ledger Dark",
    mode: "dark",
    description: "Editorial warmth with a coffee-toned dark mode.",
    accent: "#e58d54",
    background: "#1b1411",
    foreground: "#f5ede6",
    uiFontFamily: '"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif',
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: true,
    contrast: 52,
  }),
  makeThemeDocument({
    id: "cool-current-light",
    name: "Cool Current Light",
    mode: "light",
    description: "Crystalline teals with a cooler edge.",
    accent: "#00827a",
    background: "#f2fbfb",
    foreground: "#11232b",
    uiFontFamily: '"Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: true,
    contrast: 40,
  }),
  makeThemeDocument({
    id: "cool-current-dark",
    name: "Cool Current Dark",
    mode: "dark",
    description: "Crystalline teals on deep slate surfaces.",
    accent: "#19b8b0",
    background: "#09161d",
    foreground: "#ebfbff",
    uiFontFamily: '"Avenir Next", "Segoe UI", "Helvetica Neue", Arial, sans-serif',
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: true,
    contrast: 48,
  }),
  makeThemeDocument({
    id: "editorial-signal-light",
    name: "Editorial Signal Light",
    mode: "light",
    description: "Minimal black-and-cream contrast with sharper serif typography.",
    accent: "#7f1933",
    background: "#fffaf2",
    foreground: "#121212",
    uiFontFamily: '"Charter", "Bitstream Charter", "Sitka Text", Cambria, serif',
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: false,
    contrast: 64,
  }),
  makeThemeDocument({
    id: "editorial-signal-dark",
    name: "Editorial Signal Dark",
    mode: "dark",
    description: "Minimal black-and-cream contrast with sharper serif typography.",
    accent: "#f05d7a",
    background: "#111114",
    foreground: "#f7f4ef",
    uiFontFamily: '"Charter", "Bitstream Charter", "Sitka Text", Cambria, serif',
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: false,
    contrast: 58,
  }),
  makeThemeDocument({
    id: "accessibility-spectrum-light",
    name: "Accessibility Spectrum Light",
    mode: "light",
    description: "High-legibility neutrals with color-blind friendly diff colors.",
    accent: "#245dce",
    background: "#ffffff",
    foreground: "#101828",
    uiFontFamily: DEFAULT_UI_FONT,
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: false,
    contrast: 68,
    overrides: {
      diffAddition: "#0969da",
      diffDeletion: "#bc4c00",
    },
  }),
  makeThemeDocument({
    id: "accessibility-spectrum-dark",
    name: "Accessibility Spectrum Dark",
    mode: "dark",
    description: "High-legibility neutrals with color-blind friendly diff colors.",
    accent: "#58a6ff",
    background: "#0d1117",
    foreground: "#f0f6fc",
    uiFontFamily: DEFAULT_UI_FONT,
    codeFontFamily: DEFAULT_CODE_FONT,
    sidebarTranslucent: false,
    contrast: 64,
    overrides: {
      diffAddition: "#388bfd",
      diffDeletion: "#db6d28",
    },
  }),
] as const;

export const DEFAULT_LIGHT_THEME_ID = DEFAULT_ACTIVE_LIGHT_THEME_ID;
export const DEFAULT_DARK_THEME_ID = DEFAULT_ACTIVE_DARK_THEME_ID;
export const BUILTIN_THEME_DOCUMENTS: readonly ThemeDocument[] = BUILTIN_THEME_PRESETS.map(
  (preset) => preset.theme,
);

const BUILTIN_THEME_ID_SET = new Set(BUILTIN_THEME_DOCUMENTS.map((theme) => theme.id));

export function getDefaultThemeId(mode: ThemeMode): string {
  return mode === "dark" ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
}

export function isBuiltinThemeId(themeId: string): boolean {
  return BUILTIN_THEME_ID_SET.has(themeId);
}

export function getBuiltinThemePreset(themeId: string): BuiltinThemePreset | undefined {
  return BUILTIN_THEME_PRESETS.find((preset) => preset.theme.id === themeId);
}

export function getBuiltinThemeDocument(themeId: string): ThemeDocument | undefined {
  return getBuiltinThemePreset(themeId)?.theme;
}

export function getThemeDocumentsForMode(
  mode: ThemeMode,
  customThemes: ReadonlyArray<ThemeDocument>,
): ReadonlyArray<ThemeDocument> {
  return [...BUILTIN_THEME_DOCUMENTS, ...customThemes].filter((theme) => theme.mode === mode);
}

export function resolveThemeDocument(
  themeId: string,
  customThemes: ReadonlyArray<ThemeDocument>,
  mode: ThemeMode,
): ThemeDocument {
  const resolved =
    getBuiltinThemeDocument(themeId) ?? customThemes.find((theme) => theme.id === themeId);

  if (resolved && resolved.mode === mode) {
    return resolved;
  }

  return (
    getBuiltinThemeDocument(getDefaultThemeId(mode)) ??
    BUILTIN_THEME_DOCUMENTS.find((theme) => theme.mode === mode)!
  );
}

export function canonicalizeThemeDocument(
  themeDocument: ThemeDocument,
  origin: ThemeOrigin = themeDocument.origin,
): ThemeDocument {
  const overrides = serializeThemeDerivedOverrides(themeDocument.overrides);
  return {
    id: themeDocument.id,
    name: themeDocument.name,
    version: 1,
    origin,
    mode: themeDocument.mode,
    radius: themeDocument.radius,
    fontSize: themeDocument.fontSize,
    accent: themeDocument.accent,
    background: themeDocument.background,
    foreground: themeDocument.foreground,
    uiFontFamily: themeDocument.uiFontFamily,
    codeFontFamily: themeDocument.codeFontFamily,
    sidebarTranslucent: themeDocument.sidebarTranslucent,
    contrast: themeDocument.contrast,
    ...(overrides ? { overrides } : {}),
  };
}

export function serializeThemeDocument(themeDocument: ThemeDocument): string {
  return `${JSON.stringify(canonicalizeThemeDocument(themeDocument), null, 2)}\n`;
}

export function serializeAppearanceSnapshot(snapshot: {
  colorMode: "light" | "dark" | "system";
  activeLightThemeId: string;
  activeDarkThemeId: string;
  customThemes: ReadonlyArray<ThemeDocument>;
}): string {
  return JSON.stringify({
    colorMode: snapshot.colorMode,
    activeLightThemeId: snapshot.activeLightThemeId,
    activeDarkThemeId: snapshot.activeDarkThemeId,
    customThemes: snapshot.customThemes.map((theme) => canonicalizeThemeDocument(theme, "custom")),
  });
}

export function duplicateThemeDocument(
  themeDocument: ThemeDocument,
  nextId: string,
  nextName: string,
): ThemeDocument {
  return canonicalizeThemeDocument(
    {
      ...themeDocument,
      id: nextId,
      name: nextName,
      origin: "custom",
    },
    "custom",
  );
}

export function getReservedThemeIds(): ReadonlySet<string> {
  return BUILTIN_THEME_ID_SET;
}
