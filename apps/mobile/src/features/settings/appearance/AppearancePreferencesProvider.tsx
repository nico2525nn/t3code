import {
  createContext,
  startTransition,
  use,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { Appearance, useColorScheme } from "react-native";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/unstable/reactivity";

import { ThemeTransitionPreset, Uniwind } from "uniwind";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  type ResolvedAppearance,
} from "../../../lib/appearancePreferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../state/preferences";
import type { Preferences } from "../../../persistence/mobile-preferences";
import {
  createMobileThemePairPatch,
  createMobileThemeSelectionPatch,
  normalizeMobileThemeMode,
  normalizeMobileThemeTransition,
  resolveMobileThemeIds,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeIds,
  type MobileThemeMode,
  type MobileThemeTransition,
} from "../../../lib/mobileTheme";
import {
  createMobileThemeRuntimeOperations,
  type MobileThemeRuntimeState,
} from "../../../lib/mobileThemeRuntime";
import { cacheTerminalFontSize } from "../../terminal/terminalUiState";

interface AppearancePreferencesContextValue {
  /** Effective values with base-size derivation applied. Use this for rendering. */
  readonly appearance: ResolvedAppearance;
  readonly themeId: MobileThemeId;
  readonly themeIds: MobileThemeIds;
  readonly themeMode: MobileThemeMode;
  readonly themeTransition: MobileThemeTransition;
  readonly themeAppearance: MobileThemeAppearance;
  readonly isReady: boolean;
  readonly setThemeIdForAppearance: (
    appearance: MobileThemeAppearance,
    value: MobileThemeId,
  ) => void;
  readonly setThemeIdForBothAppearances: (value: MobileThemeId) => void;
  readonly setThemeMode: (value: MobileThemeMode) => void;
  readonly setThemeTransition: (value: MobileThemeTransition) => void;
  readonly setBaseFontSize: (value: number) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setTerminalFontSize: (value: number | null) => void;
  /** Pass null to clear the override and follow the base font size. */
  readonly setCodeFontSize: (value: number | null) => void;
  readonly setCodeWordBreak: (value: boolean) => void;
}

const AppearancePreferencesContext = createContext<AppearancePreferencesContextValue | null>(null);

const UNIWIND_THEME_TRANSITION_PRESETS: Readonly<
  Record<MobileThemeTransition, ThemeTransitionPreset>
> = {
  none: ThemeTransitionPreset.None,
  fade: ThemeTransitionPreset.Fade,
  "slide-right-to-left": ThemeTransitionPreset.SlideRightToLeft,
  "slide-left-to-right": ThemeTransitionPreset.SlideLeftToRight,
  "circle-top-right": ThemeTransitionPreset.CircleTopRight,
  "circle-top-left": ThemeTransitionPreset.CircleTopLeft,
  "circle-bottom-right": ThemeTransitionPreset.CircleBottomRight,
  "circle-bottom-left": ThemeTransitionPreset.CircleBottomLeft,
  "circle-center": ThemeTransitionPreset.CircleCenter,
  blur: ThemeTransitionPreset.Blur,
  "blur-right-to-left": ThemeTransitionPreset.BlurRightToLeft,
  "blur-left-to-right": ThemeTransitionPreset.BlurLeftToRight,
};

interface IdleDeadlineLike {
  readonly didTimeout: boolean;
  timeRemaining(): number;
}

type IdleCallback = (deadline: IdleDeadlineLike) => void;

function scheduleIdle(callback: IdleCallback): number {
  if (typeof globalThis.requestIdleCallback === "function") {
    return globalThis.requestIdleCallback(callback, { timeout: 250 });
  }

  return setTimeout(
    () => callback({ didTimeout: true, timeRemaining: () => 0 }),
    0,
  ) as unknown as number;
}

function cancelIdle(handle: number): void {
  if (typeof globalThis.cancelIdleCallback === "function") {
    globalThis.cancelIdleCallback(handle);
    return;
  }
  clearTimeout(handle);
}

function scheduleFrame(callback: () => void): number {
  if (typeof globalThis.requestAnimationFrame === "function") {
    return globalThis.requestAnimationFrame(callback);
  }
  return setTimeout(callback, 0) as unknown as number;
}

function cancelFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === "function") {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle);
}

export function AppearancePreferencesProvider(props: { readonly children: ReactNode }) {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const systemColorScheme = useColorScheme() === "dark" ? "dark" : "light";
  const storedPreferences = AsyncResult.isSuccess(preferencesResult)
    ? preferencesResult.value
    : null;
  const preferences = useMemo(
    () => resolveAppearancePreferences(storedPreferences),
    [storedPreferences],
  );
  const themeMode = normalizeMobileThemeMode(storedPreferences?.themeMode);
  const themeTransition = normalizeMobileThemeTransition(storedPreferences?.themeTransition);
  const themeAppearance = themeMode === "system" ? systemColorScheme : themeMode;
  const themeIds = useMemo(
    () => resolveMobileThemeIds(storedPreferences ?? {}),
    [storedPreferences],
  );
  const themeId = themeIds[themeAppearance];
  // Preference patches are optimistic. Keep controls interactive while a save is
  // in flight so rapid theme choices can supersede one another immediately.
  const isReady = AsyncResult.isSuccess(preferencesResult);
  const runtimeState = useMemo<MobileThemeRuntimeState>(
    () => ({
      baseFontSize: preferences.baseFontSize,
      themeAppearance,
      themeIds,
      themeMode,
    }),
    [preferences.baseFontSize, themeAppearance, themeIds, themeMode],
  );
  const appliedRuntimeStateRef = useRef<MobileThemeRuntimeState | null>(null);
  const themeTransitionRef = useRef(themeTransition);
  const pendingThemePreferencesRef = useRef<Partial<Preferences> | null>(null);
  const postThemeIdleHandleRef = useRef<number | null>(null);
  const postThemeFrameHandleRef = useRef<number | null>(null);
  const postThemeGenerationRef = useRef(0);

  const schedulePostThemeCommit = useCallback(() => {
    if (postThemeIdleHandleRef.current !== null || postThemeFrameHandleRef.current !== null) {
      return;
    }
    const generation = postThemeGenerationRef.current;

    // Pro queues its ShadowTree mutation from setTheme on the idle queue. Our
    // JS interop state waits behind that callback and one frame, guaranteeing
    // the native transition is already underway before React reconciles.
    postThemeIdleHandleRef.current = scheduleIdle(() => {
      postThemeIdleHandleRef.current = null;
      postThemeFrameHandleRef.current = scheduleFrame(() => {
        postThemeFrameHandleRef.current = null;
        if (generation !== postThemeGenerationRef.current) {
          schedulePostThemeCommit();
          return;
        }
        const pendingPreferences = pendingThemePreferencesRef.current;
        pendingThemePreferencesRef.current = null;
        if (pendingPreferences) savePreferences(pendingPreferences);
      });
    });
  }, [savePreferences]);

  const applyThemeRuntime = useCallback(
    (next: MobileThemeRuntimeState, options?: { readonly transition?: MobileThemeTransition }) => {
      const operations = createMobileThemeRuntimeOperations(
        appliedRuntimeStateRef.current,
        next,
        options,
      );
      for (const operation of operations) {
        if (operation.kind === "update-text-variables") {
          Uniwind.updateCSSVariables(operation.themeName, operation.variables);
          continue;
        }
        if (operation.kind === "set-appearance-mode") {
          Appearance.setColorScheme(
            operation.themeMode === "system" ? "unspecified" : operation.appearance,
          );
          continue;
        }
        postThemeGenerationRef.current += 1;
        Uniwind.setTheme(
          operation.themeName,
          operation.transition === null
            ? undefined
            : { preset: UNIWIND_THEME_TRANSITION_PRESETS[operation.transition] },
        );
        // A custom Uniwind theme resets React Native's appearance override to
        // `unspecified`. Restore it in the same event so native-stack headers,
        // form-sheet chrome, and system controls cannot land one frame later on
        // the opposite appearance.
        Appearance.setColorScheme(
          operation.themeMode === "system" ? "unspecified" : operation.appearance,
        );
      }
      appliedRuntimeStateRef.current = next;
    },
    [],
  );

  const syncThemeRuntime = useCallback(
    (next: MobileThemeRuntimeState, options?: { readonly transition?: MobileThemeTransition }) => {
      applyThemeRuntime(next, options);
    },
    [applyThemeRuntime],
  );

  const saveThemePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      pendingThemePreferencesRef.current = {
        ...pendingThemePreferencesRef.current,
        ...patch,
      };
      schedulePostThemeCommit();
    },
    [schedulePostThemeCommit],
  );

  useEffect(
    () => () => {
      if (postThemeIdleHandleRef.current !== null) {
        cancelIdle(postThemeIdleHandleRef.current);
      }
      if (postThemeFrameHandleRef.current !== null) {
        cancelFrame(postThemeFrameHandleRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    themeTransitionRef.current = themeTransition;
    syncThemeRuntime(runtimeState);
    cacheTerminalFontSize(resolveAppearance(preferences).terminalFontSize);
  }, [preferences, runtimeState, syncThemeRuntime, themeTransition]);

  const updatePreferences = useCallback(
    (patch: Partial<Preferences>) => {
      startTransition(() => savePreferences(patch));
    },
    [savePreferences],
  );

  const setThemeIdForAppearance = useCallback(
    (appearance: MobileThemeAppearance, value: MobileThemeId) => {
      const current = appliedRuntimeStateRef.current ?? runtimeState;
      const patch = createMobileThemeSelectionPatch(
        current.themeIds,
        current.themeAppearance,
        appearance,
        value,
      );
      syncThemeRuntime(
        {
          ...current,
          themeIds: resolveMobileThemeIds(patch),
        },
        { transition: themeTransitionRef.current },
      );
      saveThemePreferences(patch);
    },
    [runtimeState, saveThemePreferences, syncThemeRuntime],
  );

  const setThemeIdForBothAppearances = useCallback(
    (value: MobileThemeId) => {
      const current = appliedRuntimeStateRef.current ?? runtimeState;
      const patch = createMobileThemePairPatch(value);
      syncThemeRuntime(
        {
          ...current,
          themeIds: resolveMobileThemeIds(patch),
        },
        { transition: themeTransitionRef.current },
      );
      saveThemePreferences(patch);
    },
    [runtimeState, saveThemePreferences, syncThemeRuntime],
  );

  const setThemeMode = useCallback(
    (value: MobileThemeMode) => {
      const current = appliedRuntimeStateRef.current ?? runtimeState;
      const nextAppearance =
        value === "system" ? (Appearance.getColorScheme() === "dark" ? "dark" : "light") : value;
      syncThemeRuntime(
        {
          ...current,
          themeAppearance: nextAppearance,
          themeMode: value,
        },
        { transition: themeTransitionRef.current },
      );
      saveThemePreferences({ themeMode: value });
    },
    [runtimeState, saveThemePreferences, syncThemeRuntime],
  );

  const setBaseFontSize = useCallback(
    (value: number) => {
      const current = appliedRuntimeStateRef.current ?? runtimeState;
      syncThemeRuntime({ ...current, baseFontSize: value });
      updatePreferences({ baseFontSize: value });
    },
    [runtimeState, syncThemeRuntime, updatePreferences],
  );

  const setThemeTransition = useCallback(
    (value: MobileThemeTransition) => {
      themeTransitionRef.current = value;
      updatePreferences({ themeTransition: value });
    },
    [updatePreferences],
  );

  const setTerminalFontSize = useCallback(
    (value: number | null) => {
      updatePreferences({ terminalFontSize: value });
    },
    [updatePreferences],
  );

  const setCodeFontSize = useCallback(
    (value: number | null) => {
      updatePreferences({ codeFontSize: value });
    },
    [updatePreferences],
  );

  const setCodeWordBreak = useCallback(
    (value: boolean) => {
      updatePreferences({ codeWordBreak: value });
    },
    [updatePreferences],
  );

  const value = useMemo(
    (): AppearancePreferencesContextValue => ({
      appearance: resolveAppearance(preferences),
      themeId,
      themeIds,
      themeMode,
      themeTransition,
      themeAppearance,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      setThemeMode,
      setThemeTransition,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    }),
    [
      preferences,
      themeId,
      themeIds,
      themeMode,
      themeTransition,
      themeAppearance,
      isReady,
      setThemeIdForAppearance,
      setThemeIdForBothAppearances,
      setThemeMode,
      setThemeTransition,
      setBaseFontSize,
      setTerminalFontSize,
      setCodeFontSize,
      setCodeWordBreak,
    ],
  );

  return (
    <AppearancePreferencesContext.Provider value={value}>
      {props.children}
    </AppearancePreferencesContext.Provider>
  );
}

export function useAppearancePreferences(): AppearancePreferencesContextValue {
  const context = use(AppearancePreferencesContext);
  if (!context) {
    throw new Error("useAppearancePreferences must be used within AppearancePreferencesProvider");
  }
  return context;
}
