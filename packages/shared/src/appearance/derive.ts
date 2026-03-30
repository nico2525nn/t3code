import type { ThemeDerivedOverrides, ThemeVariant } from "@t3tools/contracts/appearanceTheme";

export type ResolvedThemeMode = "light" | "dark";

export const THEME_TOKEN_ORDER = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "border",
  "input",
  "ring",
  "destructive",
  "destructive-foreground",
  "info",
  "info-foreground",
  "success",
  "success-foreground",
  "warning",
  "warning-foreground",
  "diff-addition",
  "diff-deletion",
  "sidebar",
  "sidebar-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "ui-font-family",
  "code-font-family",
  "sidebar-blur",
] as const;

export type ThemeTokenName = (typeof THEME_TOKEN_ORDER)[number];
export type ThemeTokenMap = Record<ThemeTokenName, string>;
export type ThemeCssVariableMap = Record<`--${ThemeTokenName}`, string>;

type Rgb = {
  r: number;
  g: number;
  b: number;
};

function transformGammaChannel(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

const STATUS_PALETTE = {
  light: {
    destructive: "#c53b2c",
    info: "#0b6bcb",
    success: "#0a7d5d",
    warning: "#a95a00",
  },
  dark: {
    destructive: "#ff7b72",
    info: "#58a6ff",
    success: "#3fb950",
    warning: "#d29922",
  },
} as const;

const OVERRIDE_TOKEN_MAP: Record<keyof ThemeDerivedOverrides, ThemeTokenName> = {
  background: "background",
  foreground: "foreground",
  card: "card",
  cardForeground: "card-foreground",
  popover: "popover",
  popoverForeground: "popover-foreground",
  primary: "primary",
  primaryForeground: "primary-foreground",
  secondary: "secondary",
  secondaryForeground: "secondary-foreground",
  muted: "muted",
  mutedForeground: "muted-foreground",
  accentSurface: "accent",
  accentForeground: "accent-foreground",
  border: "border",
  input: "input",
  ring: "ring",
  destructive: "destructive",
  destructiveForeground: "destructive-foreground",
  info: "info",
  infoForeground: "info-foreground",
  success: "success",
  successForeground: "success-foreground",
  warning: "warning",
  warningForeground: "warning-foreground",
  diffAddition: "diff-addition",
  diffDeletion: "diff-deletion",
  sidebar: "sidebar",
  sidebarForeground: "sidebar-foreground",
  sidebarAccent: "sidebar-accent",
  sidebarAccentForeground: "sidebar-accent-foreground",
  sidebarBorder: "sidebar-border",
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function parseHexColor(hex: string): Rgb {
  const normalized = hex.replace("#", "");
  const expanded =
    normalized.length === 8 ? normalized.slice(0, 6) : normalized.length === 6 ? normalized : "";
  if (!expanded) {
    throw new Error(`Invalid hex color: ${hex}`);
  }
  return {
    r: Number.parseInt(expanded.slice(0, 2), 16),
    g: Number.parseInt(expanded.slice(2, 4), 16),
    b: Number.parseInt(expanded.slice(4, 6), 16),
  };
}

function toHexColor({ r, g, b }: Rgb): string {
  const channel = (value: number) =>
    Math.round(clamp(value, 0, 255))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function mixColors(left: string, right: string, ratio: number): string {
  const from = parseHexColor(left);
  const to = parseHexColor(right);
  const amount = clamp(ratio, 0, 1);
  return toHexColor({
    r: from.r + (to.r - from.r) * amount,
    g: from.g + (to.g - from.g) * amount,
    b: from.b + (to.b - from.b) * amount,
  });
}

function withAlpha(color: string, alpha: number): string {
  const { r, g, b } = parseHexColor(color);
  return `rgb(${r} ${g} ${b} / ${clamp(alpha, 0, 1).toFixed(3)})`;
}

function getRelativeLuminance(color: string): number {
  const { r, g, b } = parseHexColor(color);
  return (
    0.2126 * transformGammaChannel(r) +
    0.7152 * transformGammaChannel(g) +
    0.0722 * transformGammaChannel(b)
  );
}

function getContrastRatio(left: string, right: string): number {
  const leftLuminance = getRelativeLuminance(left);
  const rightLuminance = getRelativeLuminance(right);
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function pickReadableText(background: string, candidates: ReadonlyArray<string>): string {
  return (
    candidates
      .toSorted(
        (left, right) => getContrastRatio(background, right) - getContrastRatio(background, left),
      )
      .at(0) ?? candidates[0]!
  );
}

function stripUndefinedKeys<T extends Record<string, string | undefined>>(
  value: T,
): Record<string, string> {
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return Object.fromEntries(entries);
}

export function deriveThemeTokens(themeVariant: ThemeVariant): ThemeTokenMap {
  const contrastFactor = clamp(themeVariant.contrast / 100, 0, 1);
  const isDark =
    getRelativeLuminance(themeVariant.background) < getRelativeLuminance(themeVariant.foreground);

  const card = mixColors(
    themeVariant.background,
    themeVariant.foreground,
    isDark ? 0.02 + contrastFactor * 0.04 : 0.006 + contrastFactor * 0.016,
  );
  const popover = mixColors(
    themeVariant.background,
    themeVariant.foreground,
    isDark ? 0.035 + contrastFactor * 0.05 : 0.012 + contrastFactor * 0.02,
  );
  const secondary = withAlpha(themeVariant.foreground, 0.03 + contrastFactor * 0.035);
  const muted = withAlpha(themeVariant.foreground, 0.04 + contrastFactor * 0.03);
  const accentSurface = mixColors(
    themeVariant.background,
    themeVariant.accent,
    0.11 + contrastFactor * 0.09,
  );
  const border = withAlpha(themeVariant.foreground, 0.08 + contrastFactor * 0.18);
  const input = withAlpha(themeVariant.foreground, 0.1 + contrastFactor * 0.2);
  const mutedForeground = mixColors(
    themeVariant.foreground,
    themeVariant.background,
    0.38 - contrastFactor * 0.14,
  );
  const sidebarBase = mixColors(
    themeVariant.background,
    themeVariant.foreground,
    isDark ? 0.055 + contrastFactor * 0.055 : 0.045 + contrastFactor * 0.05,
  );

  const statusPalette = isDark ? STATUS_PALETTE.dark : STATUS_PALETTE.light;
  const primaryForeground = pickReadableText(themeVariant.accent, [
    themeVariant.foreground,
    themeVariant.background,
    "#0d0d0d",
    "#ffffff",
  ]);
  const accentForeground = pickReadableText(accentSurface, [
    themeVariant.foreground,
    themeVariant.background,
    "#0d0d0d",
    "#ffffff",
  ]);
  const destructiveForeground = pickReadableText(statusPalette.destructive, [
    themeVariant.background,
    themeVariant.foreground,
    "#ffffff",
    "#0d0d0d",
  ]);
  const infoForeground = pickReadableText(statusPalette.info, [
    themeVariant.background,
    themeVariant.foreground,
    "#ffffff",
    "#0d0d0d",
  ]);
  const successForeground = pickReadableText(statusPalette.success, [
    themeVariant.background,
    themeVariant.foreground,
    "#ffffff",
    "#0d0d0d",
  ]);
  const warningForeground = pickReadableText(statusPalette.warning, [
    themeVariant.background,
    themeVariant.foreground,
    "#ffffff",
    "#0d0d0d",
  ]);

  const tokens: ThemeTokenMap = {
    background: themeVariant.background,
    foreground: themeVariant.foreground,
    card,
    "card-foreground": themeVariant.foreground,
    popover,
    "popover-foreground": themeVariant.foreground,
    primary: themeVariant.accent,
    "primary-foreground": primaryForeground,
    secondary,
    "secondary-foreground": themeVariant.foreground,
    muted,
    "muted-foreground": mutedForeground,
    accent: accentSurface,
    "accent-foreground": accentForeground,
    border,
    input,
    ring: mixColors(themeVariant.accent, themeVariant.foreground, isDark ? 0.12 : 0.08),
    destructive: statusPalette.destructive,
    "destructive-foreground": destructiveForeground,
    info: statusPalette.info,
    "info-foreground": infoForeground,
    success: statusPalette.success,
    "success-foreground": successForeground,
    warning: statusPalette.warning,
    "warning-foreground": warningForeground,
    "diff-addition": statusPalette.success,
    "diff-deletion": statusPalette.destructive,
    sidebar: themeVariant.sidebarTranslucent
      ? withAlpha(sidebarBase, isDark ? 0.84 : 0.94)
      : sidebarBase,
    "sidebar-foreground": themeVariant.foreground,
    "sidebar-accent": mixColors(sidebarBase, themeVariant.accent, 0.16 + contrastFactor * 0.1),
    "sidebar-accent-foreground": accentForeground,
    "sidebar-border": border,
    "ui-font-family": themeVariant.uiFontFamily,
    "code-font-family": themeVariant.codeFontFamily,
    "sidebar-blur": themeVariant.sidebarTranslucent ? "18px" : "0px",
  };

  if (themeVariant.overrides) {
    for (const [overrideKey, overrideValue] of Object.entries(themeVariant.overrides) as Array<
      [keyof ThemeDerivedOverrides, string | undefined]
    >) {
      if (!overrideValue) continue;
      const tokenName = OVERRIDE_TOKEN_MAP[overrideKey];
      tokens[tokenName] = overrideValue;
    }
  }

  return tokens;
}

export function deriveThemeCssVariables(themeVariant: ThemeVariant): ThemeCssVariableMap {
  const tokens = deriveThemeTokens(themeVariant);
  const entries = THEME_TOKEN_ORDER.map((tokenName) => [`--${tokenName}`, tokens[tokenName]]);
  return Object.fromEntries(entries) as ThemeCssVariableMap;
}

export function serializeThemeDerivedOverrides(
  overrides: ThemeDerivedOverrides | undefined,
): ThemeDerivedOverrides | undefined {
  if (!overrides) return undefined;
  const next = stripUndefinedKeys(overrides);
  return Object.keys(next).length === 0 ? undefined : (next as ThemeDerivedOverrides);
}
