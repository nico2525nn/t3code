import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import { Schema } from "effect";
import type { DesktopAppearance } from "@t3tools/contracts";
import {
  ColorMode,
  ThemeDocumentSchema,
  type ThemeMode,
  type ColorMode as AppearanceColorMode,
} from "@t3tools/contracts";
import {
  applyThemeDocumentStyles,
  applyThemeVariant,
  clearThemeCssVariables,
} from "@t3tools/shared/appearance/apply";
import {
  type ResolvedThemeMode,
  type ThemeCssVariableMap,
} from "@t3tools/shared/appearance/derive";
import {
  DEFAULT_DARK_THEME_ID,
  DEFAULT_LIGHT_THEME_ID,
  resolveThemeDocument,
  serializeAppearanceSnapshot,
} from "@t3tools/shared/appearance/registry";
import { useSettings, useUpdateSettings } from "./useSettings";

const APPEARANCE_CACHE_KEY = "t3code:appearance-cache";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const AppearanceCacheSchema = Schema.Struct({
  colorMode: ColorMode,
  activeLightThemeId: Schema.String,
  activeDarkThemeId: Schema.String,
  customThemes: Schema.Array(ThemeDocumentSchema),
});
type AppearanceCache = typeof AppearanceCacheSchema.Type;

let appliedVariableNames: ReadonlyArray<keyof ThemeCssVariableMap> = [];
let lastDesktopAppearance: string | null = null;

function getSystemDark(): boolean {
  return typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY).matches : false;
}

export function resolveAppearanceMode(
  colorMode: AppearanceColorMode,
  systemDark: boolean,
): ResolvedThemeMode {
  if (colorMode === "system") {
    return systemDark ? "dark" : "light";
  }
  return colorMode;
}

export function parseAppearanceCache(raw: string | null): AppearanceCache | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return Schema.decodeUnknownSync(AppearanceCacheSchema)(parsed);
  } catch {
    return null;
  }
}

function resolveActiveThemeId(appearance: AppearanceCache, resolvedTheme: ThemeMode): string {
  return resolvedTheme === "dark" ? appearance.activeDarkThemeId : appearance.activeLightThemeId;
}

function applyResolvedAppearance(
  appearance: AppearanceCache,
  resolvedTheme: ResolvedThemeMode,
): void {
  const themeDocument = resolveThemeDocument(
    resolveActiveThemeId(appearance, resolvedTheme),
    appearance.customThemes,
    resolvedTheme,
  );
  const root = document.documentElement;

  root.classList.toggle("dark", resolvedTheme === "dark");
  root.style.colorScheme = resolvedTheme;
  root.dataset.sidebarTranslucent = String(themeDocument.sidebarTranslucent);
  applyThemeDocumentStyles(root.style, themeDocument);

  clearThemeCssVariables(root.style, appliedVariableNames);
  appliedVariableNames = applyThemeVariant(root.style, themeDocument);
}

function suppressTransitions(fn: () => void) {
  document.documentElement.classList.add("no-transitions");
  fn();
  void document.documentElement.offsetHeight;
  requestAnimationFrame(() => {
    document.documentElement.classList.remove("no-transitions");
  });
}

function syncDesktopAppearance(appearance: DesktopAppearance): void {
  const bridge = window.desktopBridge;
  if (!bridge) return;

  const key = JSON.stringify(appearance);
  if (lastDesktopAppearance === key) return;
  lastDesktopAppearance = key;

  if (typeof bridge.setAppearance === "function") {
    void bridge.setAppearance(appearance).catch(() => {
      if (lastDesktopAppearance === key) lastDesktopAppearance = null;
    });
  } else {
    // Fallback for older Electron builds that only expose setTheme
    void bridge.setTheme(appearance.mode).catch(() => {
      if (lastDesktopAppearance === key) lastDesktopAppearance = null;
    });
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  const cachedAppearance = parseAppearanceCache(localStorage.getItem(APPEARANCE_CACHE_KEY));
  const initialAppearance =
    cachedAppearance ??
    ({
      colorMode: "system",
      activeLightThemeId: DEFAULT_LIGHT_THEME_ID,
      activeDarkThemeId: DEFAULT_DARK_THEME_ID,
      customThemes: [],
    } satisfies AppearanceCache);
  const resolvedTheme = resolveAppearanceMode(initialAppearance.colorMode, getSystemDark());

  try {
    applyResolvedAppearance(initialAppearance, resolvedTheme);
  } catch {
    // The cache is best-effort. React will reconcile once settings load.
  }
}

let systemDarkListeners: Array<() => void> = [];
let cachedSystemDark: boolean | null = null;

function getSystemDarkSnapshot(): boolean {
  if (cachedSystemDark === null) cachedSystemDark = getSystemDark();
  return cachedSystemDark;
}

function subscribeSystemDark(listener: () => void): () => void {
  systemDarkListeners.push(listener);
  const mq = window.matchMedia(MEDIA_QUERY);
  const handler = () => {
    cachedSystemDark = mq.matches;
    for (const l of systemDarkListeners) l();
  };
  mq.addEventListener("change", handler);
  return () => {
    systemDarkListeners = systemDarkListeners.filter((l) => l !== listener);
    mq.removeEventListener("change", handler);
  };
}

export function useAppearance() {
  const { colorMode, activeLightThemeId, activeDarkThemeId, customThemes } = useSettings((s) => ({
    colorMode: s.colorMode,
    activeLightThemeId: s.activeLightThemeId,
    activeDarkThemeId: s.activeDarkThemeId,
    customThemes: s.customThemes,
  }));
  const { updateSettings } = useUpdateSettings();
  const activeLightTheme = useMemo(
    () => resolveThemeDocument(activeLightThemeId, customThemes, "light"),
    [activeLightThemeId, customThemes],
  );
  const activeDarkTheme = useMemo(
    () => resolveThemeDocument(activeDarkThemeId, customThemes, "dark"),
    [activeDarkThemeId, customThemes],
  );

  const systemDark = useSyncExternalStore(subscribeSystemDark, getSystemDarkSnapshot);

  const resolvedTheme = useMemo(
    () => resolveAppearanceMode(colorMode, systemDark),
    [colorMode, systemDark],
  );
  const activeResolvedTheme = resolvedTheme === "dark" ? activeDarkTheme : activeLightTheme;

  useEffect(() => {
    suppressTransitions(() => {
      applyResolvedAppearance(
        { colorMode, activeLightThemeId, activeDarkThemeId, customThemes },
        resolvedTheme,
      );
    });

    localStorage.setItem(
      APPEARANCE_CACHE_KEY,
      serializeAppearanceSnapshot({
        colorMode,
        activeLightThemeId,
        activeDarkThemeId,
        customThemes,
      }),
    );

    syncDesktopAppearance({ mode: colorMode, themeId: activeResolvedTheme.id });
  }, [
    resolvedTheme,
    activeResolvedTheme,
    activeLightThemeId,
    activeDarkThemeId,
    colorMode,
    customThemes,
  ]);

  const setColorMode = useCallback(
    (mode: AppearanceColorMode) => updateSettings({ colorMode: mode }),
    [updateSettings],
  );

  const setThemeId = useCallback(
    (mode: ThemeMode, id: string) =>
      updateSettings(mode === "dark" ? { activeDarkThemeId: id } : { activeLightThemeId: id }),
    [updateSettings],
  );

  const setCustomThemes = useCallback(
    (themes: AppearanceCache["customThemes"]) => updateSettings({ customThemes: themes }),
    [updateSettings],
  );

  return {
    colorMode,
    resolvedTheme,
    activeLightTheme,
    activeDarkTheme,
    activeResolvedTheme,
    activeLightThemeId,
    activeDarkThemeId,
    customThemes,
    setColorMode,
    setThemeId,
    setCustomThemes,
  } as const;
}
