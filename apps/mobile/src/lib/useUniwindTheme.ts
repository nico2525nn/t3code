import { useMemo } from "react";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { getMobileThemeVariables, type MobileThemeVariables } from "./mobileTheme";

/**
 * Complete JS palette for native and third-party APIs that cannot consume a
 * Uniwind className (React Navigation, native editors, Markdown, SVG gradients,
 * Reanimated worklets). Ordinary React Native rendering must use className.
 *
 * This bridge intentionally follows the persisted preference context instead
 * of useCSSVariable. Uniwind Pro mutates the native ShadowTree first; the
 * provider publishes this palette afterward in one atomic React commit.
 */
export function useUniwindTheme(): MobileThemeVariables {
  const { themeAppearance, themeId } = useAppearancePreferences();
  return useMemo(
    () => getMobileThemeVariables(themeId, themeAppearance),
    [themeAppearance, themeId],
  );
}
