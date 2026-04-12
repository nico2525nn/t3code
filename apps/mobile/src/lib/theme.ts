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
      // Page backgrounds
      screenBackground: "#0c1118",
      sheetBackground: "rgba(18,20,23,0.98)",

      // Card / surface
      card: "#161b22",
      cardAlt: "#1f2329",
      cardTranslucent: "rgba(22,27,34,0.94)",

      // Text
      text: "#f8fafc",
      textSecondary: "#94a3b8",
      textMuted: "#64748b",
      textTertiary: "#78716c",

      // Borders & separators
      border: "rgba(255,255,255,0.08)",
      borderSubtle: "rgba(255,255,255,0.06)",
      separator: "rgba(255,255,255,0.04)",

      // Subtle backgrounds (badges, pills, overlays)
      subtleBg: "rgba(255,255,255,0.06)",
      subtleBgStrong: "rgba(255,255,255,0.10)",

      // Primary action (inverted in dark mode)
      primaryButton: "#f8fafc",
      primaryButtonText: "#0c1118",
      primaryButtonShadow: "rgba(0,0,0,0.22)",

      // Secondary action
      secondaryButton: "rgba(255,255,255,0.06)",
      secondaryButtonText: "#f8fafc",
      secondaryButtonBorder: "rgba(255,255,255,0.08)",

      // Danger
      dangerButton: "rgba(190,24,93,0.14)",
      dangerBorder: "rgba(244,114,182,0.18)",
      dangerText: "#fda4af",

      // Inputs
      inputBackground: "#111827",
      inputBorder: "rgba(255,255,255,0.08)",
      placeholder: "#64748b",

      // Icons
      icon: "#f8fafc",
      iconMuted: "#94a3b8",
      iconSubtle: "#64748b",

      // Header / glass chrome
      headerBackground: "rgba(12,17,24,0.94)",
      headerBorder: "rgba(255,255,255,0.08)",

      // StatusBar
      statusBarBackground: "#0c1118",
      statusBarStyle: "light-content" as const,

      // Markdown
      markdownBody: "#e2e8f0",
      markdownStrong: "#f8fafc",
      markdownLink: "#7dd3fc",
      markdownBlockquoteBorder: "rgba(148,163,184,0.35)",
      markdownCodeBg: "rgba(255,255,255,0.08)",
      markdownCodeText: "#e2e8f0",
      markdownUserCodeBg: "rgba(255,255,255,0.10)",
      markdownUserCodeText: "#e2e8f0",

      // Drawer / modal backdrop
      backdrop: "rgba(2,6,23,0.48)",
      drawerBackground: "rgba(18,20,23,0.99)",
      drawerShadow: "rgba(0,0,0,0.32)",

      // Dot separator
      dotSeparator: "rgba(148,163,184,0.45)",

      // SVG / wordmark fill
      wordmarkFill: "#f8fafc",

      // Chevron / disclosure
      chevronColor: "rgba(255,255,255,0.25)",
    } as const;
  }

  return {
    // Page backgrounds
    screenBackground: "#f6f4ef",
    sheetBackground: "rgba(250,248,242,0.98)",

    // Card / surface
    card: "#ffffff",
    cardAlt: "#f8f4ec",
    cardTranslucent: "rgba(255,255,255,0.94)",

    // Text
    text: "#171717",
    textSecondary: "#57534e",
    textMuted: "#78716c",
    textTertiary: "#a8a29e",

    // Borders & separators
    border: "rgba(23,23,23,0.08)",
    borderSubtle: "rgba(23,23,23,0.06)",
    separator: "rgba(23,23,23,0.04)",

    // Subtle backgrounds (badges, pills, overlays)
    subtleBg: "rgba(23,23,23,0.06)",
    subtleBgStrong: "rgba(23,23,23,0.10)",

    // Primary action
    primaryButton: "#171717",
    primaryButtonText: "#fafaf9",
    primaryButtonShadow: "rgba(23,23,23,0.18)",

    // Secondary action
    secondaryButton: "#ffffff",
    secondaryButtonText: "#171717",
    secondaryButtonBorder: "rgba(23,23,23,0.08)",

    // Danger
    dangerButton: "#fff1f2",
    dangerBorder: "rgba(225,29,72,0.12)",
    dangerText: "#be123c",

    // Inputs
    inputBackground: "#ffffff",
    inputBorder: "rgba(23,23,23,0.06)",
    placeholder: "#94a3b8",

    // Icons
    icon: "#171717",
    iconMuted: "#57534e",
    iconSubtle: "#a8a29e",

    // Header / glass chrome
    headerBackground: "rgba(247,247,245,0.94)",
    headerBorder: "rgba(23,23,23,0.06)",

    // StatusBar
    statusBarBackground: "#f6f4ef",
    statusBarStyle: "dark-content" as const,

    // Markdown
    markdownBody: "#020617",
    markdownStrong: "#020617",
    markdownLink: "#0369a1",
    markdownBlockquoteBorder: "rgba(100,116,139,0.35)",
    markdownCodeBg: "rgba(15,23,42,0.08)",
    markdownCodeText: "#0f172a",
    markdownUserCodeBg: "rgba(255,255,255,0.55)",
    markdownUserCodeText: "#0f172a",

    // Drawer / modal backdrop
    backdrop: "rgba(15,23,42,0.22)",
    drawerBackground: "rgba(250,248,242,0.99)",
    drawerShadow: "rgba(15,23,42,0.12)",

    // Dot separator
    dotSeparator: "rgba(120,113,108,0.45)",

    // SVG / wordmark fill
    wordmarkFill: "#171717",

    // Chevron / disclosure
    chevronColor: "rgba(23,23,23,0.25)",
  } as const;
}

export type AppPalette = ReturnType<typeof makeAppPalette>;

/** Convenience hook that returns the palette for the current color scheme. */
export function useAppPalette(): AppPalette {
  const isDarkMode = useColorScheme() === "dark";
  return makeAppPalette(isDarkMode);
}
