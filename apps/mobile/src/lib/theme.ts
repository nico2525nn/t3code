import { useColorScheme } from "react-native";

/**
 * Centralized app color palette that adapts to light/dark system appearance.
 * Modeled after the `makeConnectionSheetPalette` pattern used in connection sheets.
 *
 * Usage:
 *   const isDarkMode = useColorScheme() === "dark";
 *   const palette = makeAppPalette(isDarkMode);
 */
export function makeAppPalette(isDarkMode: boolean) {
  if (isDarkMode) {
    return {
      // Page backgrounds — matches web's neutral-950 dark palette
      screenBackground: "#0a0a0a",
      sheetBackground: "rgba(14,14,14,0.98)",

      // Card / surface
      card: "#171717",
      cardAlt: "#1c1c1c",
      cardTranslucent: "rgba(17,17,17,0.94)",

      // Text — neutral scale (matches web's neutral-100 / neutral-500)
      text: "#f5f5f5",
      textSecondary: "#a3a3a3",
      textMuted: "#737373",
      textTertiary: "#525252",

      // Borders & separators — matches web's --border (white/6%) / --input (white/8%)
      border: "rgba(255,255,255,0.06)",
      borderSubtle: "rgba(255,255,255,0.04)",
      separator: "rgba(255,255,255,0.03)",

      // Subtle backgrounds (badges, pills, overlays)
      subtleBg: "rgba(255,255,255,0.04)",
      subtleBgStrong: "rgba(255,255,255,0.08)",

      // Primary action (inverted in dark mode)
      primaryButton: "#f5f5f5",
      primaryButtonText: "#0a0a0a",
      primaryButtonShadow: "rgba(0,0,0,0.22)",

      // Secondary action
      secondaryButton: "rgba(255,255,255,0.04)",
      secondaryButtonText: "#f5f5f5",
      secondaryButtonBorder: "rgba(255,255,255,0.06)",

      // Danger
      dangerButton: "rgba(239,68,68,0.14)",
      dangerBorder: "rgba(248,113,113,0.18)",
      dangerText: "#fca5a5",

      // Inputs
      inputBackground: "#141414",
      inputBorder: "rgba(255,255,255,0.08)",
      placeholder: "#737373",

      // Icons
      icon: "#f5f5f5",
      iconMuted: "#a3a3a3",
      iconSubtle: "#737373",

      // Header / glass chrome — fully opaque to prevent content bleed-through
      headerBackground: "rgba(10,10,10,0.97)",
      headerBorder: "rgba(255,255,255,0.06)",

      // StatusBar
      statusBarBackground: "#0a0a0a",
      statusBarStyle: "light-content" as const,

      // Markdown
      markdownBody: "#e5e5e5",
      markdownStrong: "#f5f5f5",
      markdownLink: "#60a5fa",
      markdownBlockquoteBorder: "rgba(255,255,255,0.08)",
      markdownCodeBg: "rgba(255,255,255,0.06)",
      markdownCodeText: "#e5e5e5",
      markdownUserCodeBg: "rgba(255,255,255,0.08)",
      markdownUserCodeText: "#e5e5e5",

      // Drawer / modal backdrop
      backdrop: "rgba(0,0,0,0.48)",
      drawerBackground: "rgba(14,14,14,0.99)",
      drawerShadow: "rgba(0,0,0,0.32)",

      // Dot separator
      dotSeparator: "rgba(255,255,255,0.20)",

      // SVG / wordmark fill
      wordmarkFill: "#f5f5f5",

      // Chevron / disclosure
      chevronColor: "rgba(255,255,255,0.20)",
    } as const;
  }

  return {
    // Page backgrounds — matches web's white/neutral palette
    screenBackground: "#ffffff",
    sheetBackground: "rgba(255,255,255,0.98)",

    // Card / surface
    card: "#ffffff",
    cardAlt: "#f5f5f5",
    cardTranslucent: "rgba(255,255,255,0.94)",

    // Text — neutral scale (matches web's neutral-800 / neutral-500)
    text: "#262626",
    textSecondary: "#525252",
    textMuted: "#737373",
    textTertiary: "#a3a3a3",

    // Borders & separators — matches web's --border / --input
    border: "rgba(0,0,0,0.08)",
    borderSubtle: "rgba(0,0,0,0.06)",
    separator: "rgba(0,0,0,0.04)",

    // Subtle backgrounds (badges, pills, overlays)
    subtleBg: "rgba(0,0,0,0.04)",
    subtleBgStrong: "rgba(0,0,0,0.08)",

    // Primary action
    primaryButton: "#262626",
    primaryButtonText: "#ffffff",
    primaryButtonShadow: "rgba(0,0,0,0.18)",

    // Secondary action
    secondaryButton: "#ffffff",
    secondaryButtonText: "#262626",
    secondaryButtonBorder: "rgba(0,0,0,0.08)",

    // Danger
    dangerButton: "#fef2f2",
    dangerBorder: "rgba(239,68,68,0.12)",
    dangerText: "#dc2626",

    // Inputs
    inputBackground: "#ffffff",
    inputBorder: "rgba(0,0,0,0.10)",
    placeholder: "#a3a3a3",

    // Icons
    icon: "#262626",
    iconMuted: "#525252",
    iconSubtle: "#a3a3a3",

    // Header / glass chrome — fully opaque to prevent content bleed-through
    headerBackground: "rgba(255,255,255,0.97)",
    headerBorder: "rgba(0,0,0,0.06)",

    // StatusBar
    statusBarBackground: "#ffffff",
    statusBarStyle: "dark-content" as const,

    // Markdown
    markdownBody: "#262626",
    markdownStrong: "#171717",
    markdownLink: "#2563eb",
    markdownBlockquoteBorder: "rgba(0,0,0,0.08)",
    markdownCodeBg: "rgba(0,0,0,0.04)",
    markdownCodeText: "#262626",
    markdownUserCodeBg: "rgba(255,255,255,0.55)",
    markdownUserCodeText: "#262626",

    // Drawer / modal backdrop
    backdrop: "rgba(0,0,0,0.22)",
    drawerBackground: "rgba(255,255,255,0.99)",
    drawerShadow: "rgba(0,0,0,0.12)",

    // Dot separator
    dotSeparator: "rgba(0,0,0,0.20)",

    // SVG / wordmark fill
    wordmarkFill: "#262626",

    // Chevron / disclosure
    chevronColor: "rgba(0,0,0,0.20)",
  } as const;
}

export type AppPalette = ReturnType<typeof makeAppPalette>;

/** Convenience hook that returns the palette for the current color scheme. */
export function useAppPalette(): AppPalette {
  const isDarkMode = useColorScheme() === "dark";
  return makeAppPalette(isDarkMode);
}
