import { resolveTextScaleVariables } from "./appearancePreferences";
import {
  MOBILE_THEME_IDS,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeIds,
  type MobileThemeMode,
  type MobileThemeTransition,
} from "./mobileTheme";

export type MobileUniwindThemeName = `${MobileThemeId}-${MobileThemeAppearance}`;

export interface MobileThemeRuntimeState {
  readonly baseFontSize: number;
  readonly themeAppearance: MobileThemeAppearance;
  readonly themeIds: MobileThemeIds;
  readonly themeMode: MobileThemeMode;
}

export type MobileThemeRuntimeOperation =
  | {
      readonly kind: "update-text-variables";
      readonly themeName: "light" | "dark" | MobileUniwindThemeName;
      readonly variables: Readonly<Record<string, number>>;
    }
  | {
      readonly kind: "set-theme";
      readonly appearance: MobileThemeAppearance;
      readonly themeMode: MobileThemeMode;
      readonly themeName: MobileUniwindThemeName;
      readonly transition: MobileThemeTransition | null;
    }
  | {
      readonly kind: "set-appearance-mode";
      readonly appearance: MobileThemeAppearance;
      readonly themeMode: MobileThemeMode;
    };

const UNIWIND_THEME_NAMES: ReadonlyArray<"light" | "dark" | MobileUniwindThemeName> = [
  "light",
  "dark",
  ...MOBILE_THEME_IDS.flatMap((themeId) => [
    `${themeId}-light` as const,
    `${themeId}-dark` as const,
  ]),
];

export function getMobileUniwindThemeName(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): MobileUniwindThemeName {
  return `${themeId}-${appearance}`;
}

function activeThemeName(state: MobileThemeRuntimeState): MobileUniwindThemeName {
  return getMobileUniwindThemeName(state.themeIds[state.themeAppearance], state.themeAppearance);
}

/**
 * Plans native theme work separately from preference persistence. Palette colors
 * are compiled as registered themes, so visible color changes use setTheme and
 * Uniwind Pro can synchronize them through one native ShadowTree transition.
 */
export function createMobileThemeRuntimeOperations(
  previous: MobileThemeRuntimeState | null,
  next: MobileThemeRuntimeState,
  options: { readonly transition?: MobileThemeTransition } = {},
): ReadonlyArray<MobileThemeRuntimeOperation> {
  const operations: MobileThemeRuntimeOperation[] = [];
  const nextThemeName = activeThemeName(next);

  if (previous === null || previous.baseFontSize !== next.baseFontSize) {
    const variables = resolveTextScaleVariables(next.baseFontSize);
    const orderedThemeNames = [
      ...UNIWIND_THEME_NAMES.filter((themeName) => themeName !== nextThemeName),
      nextThemeName,
    ];
    for (const themeName of orderedThemeNames) {
      operations.push({ kind: "update-text-variables", themeName, variables });
    }
  }

  const previousThemeName = previous === null ? null : activeThemeName(previous);
  const setsTheme = previousThemeName !== nextThemeName;
  if (setsTheme) {
    operations.push({
      kind: "set-theme",
      appearance: next.themeAppearance,
      themeMode: next.themeMode,
      themeName: nextThemeName,
      transition: previous === null ? null : (options.transition ?? null),
    });
  }

  if (
    !setsTheme &&
    (previous === null ||
      previous.themeAppearance !== next.themeAppearance ||
      previous.themeMode !== next.themeMode)
  ) {
    operations.push({
      kind: "set-appearance-mode",
      appearance: next.themeAppearance,
      themeMode: next.themeMode,
    });
  }

  return operations;
}
