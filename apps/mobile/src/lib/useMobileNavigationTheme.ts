import { DarkTheme, DefaultTheme, type Theme } from "@react-navigation/native";
import { useMemo } from "react";

import {
  getMobileThemeVariables,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "./mobileTheme";

/**
 * React Navigation requires a JS theme object. Derive it from the same palette
 * source as Uniwind instead of subscribing the app root to CSS variables. The
 * preferences provider publishes this bridge after Uniwind has mutated the
 * native ShadowTree, so it cannot delay or cancel the Pro transition.
 */
export function useMobileNavigationTheme(
  themeId: MobileThemeId,
  appearance: MobileThemeAppearance,
): Theme {
  return useMemo(() => {
    const base = appearance === "dark" ? DarkTheme : DefaultTheme;
    const variables = getMobileThemeVariables(themeId, appearance);
    return {
      ...base,
      colors: {
        ...base.colors,
        primary: variables["--color-primary"],
        background: variables["--color-screen"],
        card: variables["--color-sheet-solid"],
        text: variables["--color-foreground"],
        border: variables["--color-header-border"],
        notification: variables["--color-danger-foreground"],
      },
    };
  }, [appearance, themeId]);
}
