/**
 * App Settings - Backward-compatible shim.
 *
 * Re-exports the unified settings hook (`useSettings` / `useUpdateSettings`)
 * as `useAppSettings()` so existing consumers continue to work without
 * modification. New code should import from `~/hooks/useSettings` directly.
 *
 * Also re-exports type aliases and schema constants consumed by components
 * that only need the type (e.g. `TimestampFormat`).
 */
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@t3tools/contracts";
import { useSettings, useUpdateSettings, type UnifiedSettings } from "./hooks/useSettings";
import {
  DEFAULT_CLIENT_SETTINGS,
  type ClientSettings,
  type TimestampFormat,
  type SidebarProjectSortOrder,
  type SidebarThreadSortOrder,
  DEFAULT_TIMESTAMP_FORMAT,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
} from "./clientSettings";

// ── Re-exports for downstream type consumers ─────────────────────────

export type { TimestampFormat, SidebarProjectSortOrder, SidebarThreadSortOrder };
export {
  DEFAULT_TIMESTAMP_FORMAT,
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
};
export type { UnifiedSettings };

// ── Backward-compat type alias ───────────────────────────────────────

export type AppSettings = UnifiedSettings;

// ── Backward-compat hook ─────────────────────────────────────────────

export function useAppSettings() {
  const settings = useSettings();
  const { updateSettings, resetSettings, defaults } = useUpdateSettings();

  return {
    settings,
    updateSettings: (patch: Partial<AppSettings>) => updateSettings(patch),
    resetSettings,
    defaults,
  } as const;
}
