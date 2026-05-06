# T3 Code VS Code Compatible Themes Plan

## Goal

Add custom themes to T3 Code that are compatible with VS Code and Cursor color
themes.

The target user experience:

1. T3 Code auto-detects VS Code and Cursor themes installed on the local machine.
2. The user selects one from Settings.
3. T3 Code applies the selected theme across the whole app: shell, sidebar,
   chat, settings, dialogs, terminal, code blocks, and diffs.
4. T3 Code can optionally detect and follow the currently configured VS Code or
   Cursor theme.
5. Built-in `system`, `light`, and `dark` remain available and stable.

This document is a read-only planning artifact. It intentionally does not
implement the feature yet.

## Current Repo Context

Relevant existing surfaces:

- `apps/web/src/index.css`
  - Defines the current Tailwind v4 CSS variable bridge via `@theme inline`.
  - Current semantic app tokens are:
    - `--background`
    - `--app-chrome-background`
    - `--foreground`
    - `--card`
    - `--card-foreground`
    - `--popover`
    - `--popover-foreground`
    - `--primary`
    - `--primary-foreground`
    - `--secondary`
    - `--secondary-foreground`
    - `--muted`
    - `--muted-foreground`
    - `--accent`
    - `--accent-foreground`
    - `--destructive`
    - `--destructive-foreground`
    - `--border`
    - `--input`
    - `--ring`
    - `--info`
    - `--info-foreground`
    - `--success`
    - `--success-foreground`
    - `--warning`
    - `--warning-foreground`

- `apps/web/src/hooks/useTheme.ts`
  - Current type is only `Theme = "light" | "dark" | "system"`.
  - Persists to `localStorage` key `t3code:theme`.
  - Toggles `.dark` on `document.documentElement`.
  - Calls `window.desktopBridge.setTheme(theme)` to sync Electron native theme.

- `apps/web/src/components/settings/SettingsPanels.tsx`
  - `THEME_OPTIONS` contains only `system`, `light`, `dark`.
  - General settings row renders a single theme select.

- `packages/contracts/src/ipc.ts`
  - `DesktopTheme = "light" | "dark" | "system"`.
  - `DesktopBridge` exposes `setTheme(theme)`, but no theme discovery/load API.

- `apps/desktop/src/main.ts`
  - Receives `desktop:set-theme`, validates with `getSafeTheme`, and sets
    `nativeTheme.themeSource`.
  - Window background and titlebar overlay still derive from
    `nativeTheme.shouldUseDarkColors`, not from app theme colors.

- `apps/desktop/src/preload.ts`
  - Exposes the desktop bridge to the web app.

- `packages/contracts/src/settings.ts`
  - Client settings are persisted locally.
  - Theme is not currently part of `ClientSettings`; it is separate localStorage
    state in `useTheme.ts`.

- `apps/web/src/components/ThreadTerminalDrawer.tsx`
  - `terminalThemeFromApp` samples app background/foreground, then hardcodes
    ANSI palettes for light/dark.

- `apps/web/src/components/ChatMarkdown.tsx`
  - Code blocks use `@pierre/diffs` shared highlighter.
  - Theme selection is hardcoded through `resolveDiffThemeName("light"|"dark")`.

- `apps/web/src/lib/diffRendering.ts`
  - `DIFF_THEME_NAMES = { light: "pierre-light", dark: "pierre-dark" }`.

- `apps/web/src/components/DiffWorkerPoolProvider.tsx`
  - Worker highlighter options use only `pierre-light` / `pierre-dark`.

## VS Code Theme Shape

Official references:

- Theme contribution point:
  https://code.visualstudio.com/api/references/contribution-points#contributes.themes
- Color theme guide:
  https://code.visualstudio.com/api/extension-guides/color-theme
- Workbench color IDs:
  https://code.visualstudio.com/api/references/theme-color
- Semantic token colors:
  https://code.visualstudio.com/api/language-extensions/semantic-highlight-guide

VS Code themes are usually discovered through extension `package.json` files:

```json
{
  "contributes": {
    "themes": [
      {
        "label": "GitHub Dark Default",
        "uiTheme": "vs-dark",
        "path": "./themes/dark-default.json"
      }
    ]
  }
}
```

Theme JSON files commonly look like:

```json
{
  "name": "GitHub Dark Default",
  "type": "dark",
  "colors": {
    "editor.background": "#0d1117",
    "editor.foreground": "#e6edf3",
    "sideBar.background": "#010409",
    "button.background": "#238636",
    "terminal.ansiGreen": "#3fb950"
  },
  "semanticHighlighting": true,
  "tokenColors": [
    {
      "scope": ["comment", "punctuation.definition.comment"],
      "settings": {
        "foreground": "#8b949e",
        "fontStyle": "italic"
      }
    }
  ],
  "semanticTokenColors": {
    "variable.readonly": "#79c0ff"
  }
}
```

Important details:

- `contributes.themes[].uiTheme` uses:
  - `vs`: light
  - `vs-dark`: dark
  - `hc-light`: high contrast light
  - `hc-black`: high contrast dark
- `colors` is the workbench/UI layer.
- `tokenColors` is TextMate syntax highlighting.
- `semanticHighlighting` and `semanticTokenColors` are semantic syntax rules.
- `tokenColors` can be an array or a path to a `.tmTheme` file.
- User settings files are JSONC, not strict JSON, so use a real JSONC parser.
- User overrides can include:
  - `workbench.colorTheme`
  - `workbench.preferredLightColorTheme`
  - `workbench.preferredDarkColorTheme`
  - `window.autoDetectColorScheme`
  - `workbench.colorCustomizations`
  - `editor.tokenColorCustomizations`

Local discovery during research found GitHub Theme installed in both VS Code and
Cursor on this machine. Both apps currently point at `GitHub Dark Default`.

## Design Decision

Keep the T3 Code app contract semantic.

Do not make every component directly consume hundreds of VS Code color IDs.
Instead:

1. Discover and parse VS Code themes.
2. Resolve a selected VS Code theme into a normalized `ResolvedAppTheme`.
3. Apply the resolved app theme as CSS variables.
4. Keep existing Tailwind classes like `bg-background`, `text-foreground`, and
   `border-border` working.
5. Add focused app tokens only where T3 has a first-class surface:
   sidebar, terminal, diff, code blocks, chat, and browser/desktop chrome.

This keeps T3 Code themable without binding every UI component to the VS Code
workbench taxonomy forever.

## Proposed Data Model

Add a new contracts file, likely `packages/contracts/src/theme.ts`, exported
from `packages/contracts/src/index.ts`.

```ts
import * as Schema from "effect/Schema";

export const ThemeSource = Schema.Literals(["builtin", "vscode", "cursor", "vscode-insiders"]);
export type ThemeSource = typeof ThemeSource.Type;

export const ThemeKind = Schema.Literals([
  "light",
  "dark",
  "high-contrast-light",
  "high-contrast-dark",
]);
export type ThemeKind = typeof ThemeKind.Type;

export const ThemeId = Schema.TemplateLiteral(Schema.String);
export type ThemeId = typeof ThemeId.Type;

export const DiscoveredColorTheme = Schema.Struct({
  id: ThemeId,
  source: ThemeSource,
  extensionId: Schema.String,
  extensionDisplayName: Schema.optional(Schema.String),
  label: Schema.String,
  kind: ThemeKind,
  themePath: Schema.String,
  packagePath: Schema.String,
  publisher: Schema.optional(Schema.String),
});
export type DiscoveredColorTheme = typeof DiscoveredColorTheme.Type;

export const ResolvedColorTheme = Schema.Struct({
  id: ThemeId,
  label: Schema.String,
  source: ThemeSource,
  kind: ThemeKind,
  colors: Schema.Record(Schema.String, Schema.String),
  tokenColors: Schema.Unknown,
  semanticHighlighting: Schema.optional(Schema.Boolean),
  semanticTokenColors: Schema.optional(Schema.Unknown),
  appVariables: Schema.Record(Schema.String, Schema.String),
});
export type ResolvedColorTheme = typeof ResolvedColorTheme.Type;

export const ThemePreference = Schema.Union(
  Schema.Struct({ mode: Schema.Literal("system") }),
  Schema.Struct({ mode: Schema.Literal("builtin"), theme: Schema.Literals(["light", "dark"]) }),
  Schema.Struct({ mode: Schema.Literal("external"), themeId: ThemeId }),
  Schema.Struct({
    mode: Schema.Literal("follow-editor"),
    source: Schema.Literals(["vscode", "cursor", "vscode-insiders"]),
  }),
);
export type ThemePreference = typeof ThemePreference.Type;
```

Use simpler hand-written types if the Schema type ergonomics are not worth it,
but keep the bridge payloads runtime-validated at the process boundary.

## Persistence Decision

Move theme preference into `ClientSettings` eventually, but preserve the existing
`t3code:theme` localStorage key as a migration input.

Why:

- Client settings already support Electron-backed persistence via
  `apps/desktop/src/clientPersistence.ts`.
- Browser fallback already persists client settings via
  `apps/web/src/clientPersistenceStorage.ts`.
- Theme is a client preference, not server-authoritative state.
- A migration can read old `t3code:theme` and write the equivalent
  `ThemePreference`.

Suggested schema addition:

```ts
export const DEFAULT_THEME_PREFERENCE = {
  mode: "system",
} as const satisfies ThemePreference;

export const ClientSettingsSchema = Schema.Struct({
  // existing settings...
  themePreference: ThemePreference.pipe(
    Schema.withDecodingDefault(Effect.succeed(DEFAULT_THEME_PREFERENCE)),
  ),
});
```

## Desktop Bridge API

Extend `DesktopBridge` in `packages/contracts/src/ipc.ts`:

```ts
export interface DesktopBridge {
  // existing methods...
  discoverColorThemes: () => Promise<readonly DiscoveredColorTheme[]>;
  loadColorTheme: (themeId: ThemeId) => Promise<ResolvedColorTheme | null>;
  getEditorThemePreferences: () => Promise<readonly EditorThemePreference[]>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  setWindowThemeColors: (input: {
    backgroundColor: string;
    titleBarColor?: string;
    titleBarSymbolColor?: string;
  }) => Promise<void>;
}
```

`setTheme` should remain for Electron native light/dark behavior. The new
`setWindowThemeColors` lets the renderer pass resolved actual colors for
window background/titlebar overlay.

`preload.ts` adds matching IPC channels:

```ts
const DISCOVER_COLOR_THEMES_CHANNEL = "desktop:discover-color-themes";
const LOAD_COLOR_THEME_CHANNEL = "desktop:load-color-theme";
const GET_EDITOR_THEME_PREFERENCES_CHANNEL = "desktop:get-editor-theme-preferences";
const SET_WINDOW_THEME_COLORS_CHANNEL = "desktop:set-window-theme-colors";

contextBridge.exposeInMainWorld("desktopBridge", {
  // existing bridge...
  discoverColorThemes: () => ipcRenderer.invoke(DISCOVER_COLOR_THEMES_CHANNEL),
  loadColorTheme: (themeId) => ipcRenderer.invoke(LOAD_COLOR_THEME_CHANNEL, themeId),
  getEditorThemePreferences: () => ipcRenderer.invoke(GET_EDITOR_THEME_PREFERENCES_CHANNEL),
  setWindowThemeColors: (input) => ipcRenderer.invoke(SET_WINDOW_THEME_COLORS_CHANNEL, input),
});
```

## Dependency

Use a real JSONC parser for VS Code/Cursor settings files.

Add by command, not manual `package.json` edits:

```sh
bun --cwd apps/desktop add jsonc-parser
```

If the package is needed in shared code instead of desktop-only code, add it to
the owning workspace with the same command style.

## Theme Discovery

Create `apps/desktop/src/vscodeThemeDiscovery.ts`.

Responsibilities:

- Know editor roots by platform:
  - macOS:
    - `~/.vscode/extensions`
    - `~/.vscode-insiders/extensions`
    - `~/.cursor/extensions`
    - `~/Library/Application Support/Code/User/settings.json`
    - `~/Library/Application Support/Code - Insiders/User/settings.json`
    - `~/Library/Application Support/Cursor/User/settings.json`
  - Linux:
    - `~/.vscode/extensions`
    - `~/.vscode-insiders/extensions`
    - `~/.cursor/extensions`
    - `~/.config/Code/User/settings.json`
    - `~/.config/Code - Insiders/User/settings.json`
    - `~/.config/Cursor/User/settings.json`
  - Windows:
    - `%USERPROFILE%\\.vscode\\extensions`
    - `%USERPROFILE%\\.vscode-insiders\\extensions`
    - `%USERPROFILE%\\.cursor\\extensions`
    - `%APPDATA%\\Code\\User\\settings.json`
    - `%APPDATA%\\Code - Insiders\\User\\settings.json`
    - `%APPDATA%\\Cursor\\User\\settings.json`
- Scan direct child directories for `package.json`.
- Parse `contributes.themes`.
- Resolve relative paths safely under the extension directory.
- Ignore missing or malformed themes.
- Dedupe duplicate themes from VS Code/Cursor by source plus extension plus label,
  or keep both if source matters to the user.

Core scanner sketch:

```ts
import * as FS from "node:fs";
import * as Path from "node:path";
import * as OS from "node:os";
import { parse as parseJsonc } from "jsonc-parser";
import type { DiscoveredColorTheme, ThemeKind, ThemeSource } from "@t3tools/contracts";

function kindFromUiTheme(uiTheme: unknown): ThemeKind {
  if (uiTheme === "hc-light") return "high-contrast-light";
  if (uiTheme === "hc-black") return "high-contrast-dark";
  if (uiTheme === "vs") return "light";
  return "dark";
}

function readJsonFile(filePath: string): unknown | null {
  try {
    return JSON.parse(FS.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function safeResolveChild(root: string, relativePath: string): string | null {
  const resolved = Path.resolve(root, relativePath);
  const normalizedRoot = Path.resolve(root);
  return resolved.startsWith(`${normalizedRoot}${Path.sep}`) ? resolved : null;
}

export function discoverEditorColorThemes(): readonly DiscoveredColorTheme[] {
  const roots = resolveExtensionRoots({
    platform: process.platform,
    homedir: OS.homedir(),
    appData: process.env.APPDATA,
  });

  const themes: DiscoveredColorTheme[] = [];

  for (const root of roots) {
    if (!FS.existsSync(root.extensionsPath)) continue;

    for (const entry of FS.readdirSync(root.extensionsPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const extensionDir = Path.join(root.extensionsPath, entry.name);
      const packagePath = Path.join(extensionDir, "package.json");
      const packageJson = readJsonFile(packagePath);
      if (!isObject(packageJson)) continue;

      const contributedThemes = packageJson.contributes?.themes;
      if (!Array.isArray(contributedThemes)) continue;

      for (const theme of contributedThemes) {
        if (!isObject(theme) || typeof theme.label !== "string" || typeof theme.path !== "string") {
          continue;
        }

        const themePath = safeResolveChild(extensionDir, theme.path);
        if (!themePath || !FS.existsSync(themePath)) continue;

        themes.push({
          id: `${root.source}:${entry.name}:${theme.label}`,
          source: root.source,
          extensionId: entry.name,
          extensionDisplayName:
            typeof packageJson.displayName === "string" ? packageJson.displayName : undefined,
          label: theme.label,
          kind: kindFromUiTheme(theme.uiTheme),
          themePath,
          packagePath,
          publisher: typeof packageJson.publisher === "string" ? packageJson.publisher : undefined,
        });
      }
    }
  }

  return themes;
}
```

Avoid `as any`. Use small type guards:

```ts
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
```

## Settings JSONC Parsing

Read active VS Code/Cursor theme preferences:

```ts
import { parse as parseJsonc } from "jsonc-parser";

export interface EditorThemePreference {
  readonly source: "vscode" | "cursor" | "vscode-insiders";
  readonly colorTheme: string | null;
  readonly preferredLightColorTheme: string | null;
  readonly preferredDarkColorTheme: string | null;
  readonly autoDetectColorScheme: boolean;
  readonly workbenchColorCustomizations: Record<string, string>;
  readonly editorTokenColorCustomizations: unknown;
}

function readEditorSettings(settingsPath: string): Record<string, unknown> {
  try {
    const errors: unknown[] = [];
    const parsed = parseJsonc(FS.readFileSync(settingsPath, "utf8"), errors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
```

Do not fail the whole discovery call if settings are malformed.

## Theme File Loading

Load a theme by `themeId`:

```ts
export function loadEditorColorTheme(themeId: string): ResolvedColorTheme | null {
  const theme = discoverEditorColorThemes().find((entry) => entry.id === themeId);
  if (!theme) return null;

  const rawTheme = readJsonOrJsoncFile(theme.themePath);
  if (!isObject(rawTheme)) return null;

  const colors = normalizeThemeColors(rawTheme.colors);
  const appVariables = mapVscodeColorsToAppVariables({
    kind: theme.kind,
    colors,
  });

  return {
    id: theme.id,
    label: theme.label,
    source: theme.source,
    kind: theme.kind,
    colors,
    tokenColors: rawTheme.tokenColors ?? [],
    semanticHighlighting:
      typeof rawTheme.semanticHighlighting === "boolean"
        ? rawTheme.semanticHighlighting
        : undefined,
    semanticTokenColors: rawTheme.semanticTokenColors,
    appVariables,
  };
}
```

Support JSON theme files first. Treat `.tmTheme` and remote URL `tokenColors`
as phase 2 unless common installed themes require them.

## Color Normalization

VS Code supports:

- `#RGB`
- `#RGBA`
- `#RRGGBB`
- `#RRGGBBAA`

Normalize all hex values to browser-safe CSS strings. Preserve alpha when
present.

```ts
const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function normalizeCssColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!HEX_COLOR_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function normalizeThemeColors(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};

  const colors: Record<string, string> = {};
  for (const [key, rawColor] of Object.entries(value)) {
    const color = normalizeCssColor(rawColor);
    if (color) {
      colors[key] = color;
    }
  }
  return colors;
}
```

If support for `rgb(...)`, `rgba(...)`, or named colors appears in real themes,
add it deliberately with tests.

## Mapping VS Code Colors To T3 Tokens

Create a pure shared mapper, probably `packages/shared/src/themeMapping.ts`, if
both desktop and web need it. Otherwise keep it in web if desktop only loads
raw theme data.

Priority mapping:

| T3 variable                | VS Code priority                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `--background`             | `editor.background`, `sideBar.background`, default built-in                             |
| `--app-chrome-background`  | `titleBar.activeBackground`, `sideBar.background`, `--background`                       |
| `--foreground`             | `foreground`, `editor.foreground`                                                       |
| `--card`                   | `editorGroupHeader.tabsBackground`, `sideBarSectionHeader.background`, mixed background |
| `--card-foreground`        | `foreground`, `editor.foreground`                                                       |
| `--popover`                | `quickInput.background`, `editorWidget.background`, `dropdown.background`, `--card`     |
| `--popover-foreground`     | `quickInput.foreground`, `editorWidget.foreground`, `foreground`                        |
| `--primary`                | `button.background`, `activityBarBadge.background`, `focusBorder`                       |
| `--primary-foreground`     | `button.foreground`, contrast of primary                                                |
| `--secondary`              | `button.secondaryBackground`, `badge.background`, transparent mix                       |
| `--secondary-foreground`   | `button.secondaryForeground`, `foreground`                                              |
| `--muted`                  | `editor.lineHighlightBackground`, `list.hoverBackground`, transparent mix               |
| `--muted-foreground`       | `descriptionForeground`, `disabledForeground`, mixed foreground                         |
| `--accent`                 | `list.activeSelectionBackground`, `list.hoverBackground`, `toolbar.hoverBackground`     |
| `--accent-foreground`      | `list.activeSelectionForeground`, `list.hoverForeground`, `foreground`                  |
| `--destructive`            | `errorForeground`, `editorError.foreground`, `notificationsErrorIcon.foreground`        |
| `--destructive-foreground` | `errorForeground`, `editorError.foreground`                                             |
| `--border`                 | `widget.border`, `sideBar.border`, `editorGroup.border`, `panel.border`                 |
| `--input`                  | `input.background`, `dropdown.background`, `settings.textInputBackground`               |
| `--ring`                   | `focusBorder`, `inputOption.activeBorder`, `button.background`                          |
| `--info`                   | `textLink.foreground`, `terminal.ansiBlue`                                              |
| `--info-foreground`        | `textLink.foreground`, `terminal.ansiBrightBlue`, `--info`                              |
| `--success`                | `gitDecoration.addedResourceForeground`, `terminal.ansiGreen`                           |
| `--success-foreground`     | `gitDecoration.addedResourceForeground`, `terminal.ansiBrightGreen`                     |
| `--warning`                | `notificationsWarningIcon.foreground`, `terminal.ansiYellow`                            |
| `--warning-foreground`     | `notificationsWarningIcon.foreground`, `terminal.ansiBrightYellow`                      |

Additional app tokens to add:

| T3 variable                       | VS Code priority                                                              |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `--sidebar`                       | `sideBar.background`, `activityBar.background`, `--background`                |
| `--sidebar-foreground`            | `sideBar.foreground`, `foreground`                                            |
| `--sidebar-accent`                | `list.activeSelectionBackground`, `activityBar.activeBackground`, `--accent`  |
| `--sidebar-accent-foreground`     | `list.activeSelectionForeground`, `sideBar.foreground`                        |
| `--sidebar-border`                | `sideBar.border`, `activityBar.border`, `--border`                            |
| `--terminal-background`           | `terminal.background`, `panel.background`, `--background`                     |
| `--terminal-foreground`           | `terminal.foreground`, `foreground`                                           |
| `--terminal-cursor`               | `terminalCursor.foreground`, `editorCursor.foreground`, `--ring`              |
| `--terminal-selection-background` | `terminal.selectionBackground`, `editor.selectionBackground`                  |
| `--diff-inserted`                 | `diffEditor.insertedTextBackground`, `gitDecoration.addedResourceForeground`  |
| `--diff-removed`                  | `diffEditor.removedTextBackground`, `gitDecoration.deletedResourceForeground` |
| `--chat-request-background`       | `chat.requestBackground`, `--card`                                            |
| `--chat-request-border`           | `chat.requestBorder`, `--border`                                              |

Mapper sketch:

```ts
function firstColor(colors: Record<string, string>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const color = colors[key];
    if (color) return color;
  }
  return null;
}

function mapVscodeColorsToAppVariables(input: {
  readonly kind: ThemeKind;
  readonly colors: Record<string, string>;
}): Record<string, string> {
  const fallback = input.kind.includes("dark") ? DARK_FALLBACKS : LIGHT_FALLBACKS;
  const colors = input.colors;

  const background =
    firstColor(colors, ["editor.background", "sideBar.background"]) ?? fallback.background;
  const foreground = firstColor(colors, ["foreground", "editor.foreground"]) ?? fallback.foreground;
  const primary =
    firstColor(colors, ["button.background", "activityBarBadge.background", "focusBorder"]) ??
    fallback.primary;
  const border =
    firstColor(colors, ["widget.border", "sideBar.border", "editorGroup.border", "panel.border"]) ??
    fallback.border;

  return {
    "--background": background,
    "--app-chrome-background":
      firstColor(colors, ["titleBar.activeBackground", "sideBar.background"]) ?? background,
    "--foreground": foreground,
    "--card":
      firstColor(colors, ["editorGroupHeader.tabsBackground", "sideBarSectionHeader.background"]) ??
      `color-mix(in srgb, ${background} 94%, ${foreground})`,
    "--card-foreground": foreground,
    "--popover":
      firstColor(colors, [
        "quickInput.background",
        "editorWidget.background",
        "dropdown.background",
      ]) ?? background,
    "--popover-foreground":
      firstColor(colors, [
        "quickInput.foreground",
        "editorWidget.foreground",
        "dropdown.foreground",
      ]) ?? foreground,
    "--primary": primary,
    "--primary-foreground":
      firstColor(colors, ["button.foreground"]) ?? readableForeground(primary),
    "--border": border,
    "--ring": firstColor(colors, ["focusBorder", "inputOption.activeBorder"]) ?? primary,
    "--sidebar": firstColor(colors, ["sideBar.background", "activityBar.background"]) ?? background,
    "--sidebar-foreground": firstColor(colors, ["sideBar.foreground"]) ?? foreground,
    "--sidebar-border": firstColor(colors, ["sideBar.border", "activityBar.border"]) ?? border,
  };
}
```

Use CSS `color-mix(...)` where reasonable so the browser can evaluate colors
without bundling a large color library. For contrast-dependent values, a tiny
hex luminance helper is enough.

## CSS Changes

Add the sidebar/app-specific variables to `@theme inline`:

```css
@theme inline {
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
}
```

Add defaults under `:root` and `@variant dark`:

```css
:root {
  --sidebar: var(--background);
  --sidebar-foreground: var(--foreground);
  --sidebar-accent: var(--accent);
  --sidebar-accent-foreground: var(--accent-foreground);
  --sidebar-border: var(--border);

  --terminal-background: var(--background);
  --terminal-foreground: var(--foreground);
  --terminal-cursor: var(--ring);
  --terminal-selection-background: color-mix(in srgb, var(--ring) 24%, transparent);
}
```

This also fixes the current shadcn-style sidebar classes that reference
`bg-sidebar` and `text-sidebar-foreground` without explicit tokens in
`index.css`.

## Web Theme Hook Refactor

Replace `Theme = "light" | "dark" | "system"` with `ThemePreference` plus a
resolved theme snapshot.

Suggested structure:

```ts
type ThemeSnapshot = {
  preference: ThemePreference;
  resolvedKind: "light" | "dark";
  resolvedTheme: ResolvedColorTheme | null;
  discoveredThemes: readonly DiscoveredColorTheme[];
  status: "idle" | "loading" | "ready" | "error";
};
```

Apply CSS variables:

```ts
function applyResolvedTheme(theme: ResolvedColorTheme | null, suppressTransitions = false) {
  if (typeof document === "undefined") return;

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }

  const root = document.documentElement;

  if (theme) {
    for (const [name, value] of Object.entries(theme.appVariables)) {
      root.style.setProperty(name, value);
    }
  } else {
    clearExternalThemeVariables(root);
  }

  const isDark = theme
    ? theme.kind === "dark" || theme.kind === "high-contrast-dark"
    : getBuiltInDark();
  root.classList.toggle("dark", isDark);
  root.dataset.themeSource = theme?.source ?? "builtin";
  root.dataset.themeId = theme?.id ?? "";

  syncBrowserChromeTheme();
  syncDesktopTheme(isDark ? "dark" : "light");
  syncDesktopWindowColors(theme);

  if (suppressTransitions) {
    root.offsetHeight;
    requestAnimationFrame(() => root.classList.remove("no-transitions"));
  }
}
```

Keep a minimal synchronous bootstrap cache:

```ts
const BOOTSTRAP_THEME_CACHE_KEY = "t3code:resolved-theme-cache:v1";

// On successful external theme load, persist only:
// - theme id
// - kind
// - appVariables
// This prevents first paint flash without needing filesystem access before React.
```

## Settings UI

Replace the single theme select in General settings with a richer Appearance
section. Keep it compact and workmanlike.

Suggested layout:

- `Theme`
  - Select:
    - `System`
    - `Light`
    - `Dark`
    - separator/group: `VS Code`
    - discovered VS Code themes
    - separator/group: `Cursor`
    - discovered Cursor themes
- `Follow editor theme`
  - Select or segmented control:
    - Off
    - VS Code
    - Cursor
- `Refresh themes`
  - Small icon button.
- Status text:
  - `Detected 18 themes from VS Code and Cursor.`
  - `Using GitHub Dark Default from Cursor.`
  - Missing theme fallback:
    - `Selected theme is unavailable. Falling back to System.`

Pseudo-component:

```tsx
function ThemeSettingsRow() {
  const { preference, setThemePreference, discoveredThemes, refreshThemes } = useTheme();

  return (
    <SettingsRow
      title="Theme"
      description="Use built-in themes or a detected VS Code/Cursor color theme."
      control={
        <Select
          value={themePreferenceToSelectValue(preference)}
          onValueChange={(value) => setThemePreference(selectValueToThemePreference(value))}
        >
          <SelectTrigger className="w-full sm:w-64" aria-label="Theme preference">
            <SelectValue>{themePreferenceLabel(preference, discoveredThemes)}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem hideIndicator value="system">
              System
            </SelectItem>
            <SelectItem hideIndicator value="builtin:light">
              Light
            </SelectItem>
            <SelectItem hideIndicator value="builtin:dark">
              Dark
            </SelectItem>
            {discoveredThemes.map((theme) => (
              <SelectItem hideIndicator key={theme.id} value={`external:${theme.id}`}>
                {theme.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}
```

If `Select` does not support headings/separators, either add that to the UI
component or split into source-filtered rows. Do not jam labels like
`VS Code - GitHub Dark` into the only affordance if grouping can be done cleanly.

## Terminal Theme

Replace hardcoded ANSI palettes with VS Code terminal colors when available.

Mapping:

```ts
const TERMINAL_COLOR_KEYS = {
  background: "terminal.background",
  foreground: "terminal.foreground",
  cursor: "terminalCursor.foreground",
  selectionBackground: "terminal.selectionBackground",
  black: "terminal.ansiBlack",
  red: "terminal.ansiRed",
  green: "terminal.ansiGreen",
  yellow: "terminal.ansiYellow",
  blue: "terminal.ansiBlue",
  magenta: "terminal.ansiMagenta",
  cyan: "terminal.ansiCyan",
  white: "terminal.ansiWhite",
  brightBlack: "terminal.ansiBrightBlack",
  brightRed: "terminal.ansiBrightRed",
  brightGreen: "terminal.ansiBrightGreen",
  brightYellow: "terminal.ansiBrightYellow",
  brightBlue: "terminal.ansiBrightBlue",
  brightMagenta: "terminal.ansiBrightMagenta",
  brightCyan: "terminal.ansiBrightCyan",
  brightWhite: "terminal.ansiBrightWhite",
} as const;
```

Sketch:

```ts
function terminalThemeFromResolvedTheme(
  theme: ResolvedColorTheme | null,
  mountElement?: HTMLElement | null,
): ITheme {
  const appTheme = terminalThemeFromApp(mountElement);
  const colors = theme?.colors ?? {};

  return {
    ...appTheme,
    background:
      colors["terminal.background"] ??
      theme?.appVariables["--terminal-background"] ??
      appTheme.background,
    foreground:
      colors["terminal.foreground"] ??
      theme?.appVariables["--terminal-foreground"] ??
      appTheme.foreground,
    cursor:
      colors["terminalCursor.foreground"] ??
      theme?.appVariables["--terminal-cursor"] ??
      appTheme.cursor,
    selectionBackground:
      colors["terminal.selectionBackground"] ??
      colors["editor.selectionBackground"] ??
      theme?.appVariables["--terminal-selection-background"] ??
      appTheme.selectionBackground,
    green: colors["terminal.ansiGreen"] ?? appTheme.green,
    brightGreen: colors["terminal.ansiBrightGreen"] ?? appTheme.brightGreen,
  };
}
```

Expose the resolved theme through a tiny store or hook so
`ThreadTerminalDrawer.tsx` can update existing terminals when the external theme
changes. The existing `MutationObserver` already watches `class` and `style`,
but if app variables move through a store, include direct subscription too.

## Code Block And Diff Syntax Themes

Phase 1 should apply app UI and terminal themes. Syntax parity can be included
if `@pierre/diffs` exposes a way to register custom Shiki themes cleanly.

Investigate package capability before implementation:

- Does `getSharedHighlighter({ themes })` accept a Shiki theme object or only
  built-in theme names?
- Does `WorkerPoolContextProvider` accept custom theme objects?
- Can `@pierre/diffs` workers receive a custom theme definition?

If custom Shiki themes are supported, convert VS Code theme rules:

```ts
function toShikiTheme(theme: ResolvedColorTheme) {
  return {
    name: theme.id,
    type: theme.kind.includes("dark") ? "dark" : "light",
    colors: {
      "editor.background": theme.colors["editor.background"] ?? theme.appVariables["--background"],
      "editor.foreground": theme.colors["editor.foreground"] ?? theme.appVariables["--foreground"],
    },
    tokenColors: Array.isArray(theme.tokenColors) ? theme.tokenColors : [],
    semanticHighlighting: theme.semanticHighlighting,
    semanticTokenColors: theme.semanticTokenColors,
  };
}
```

Then replace:

```ts
themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")];
```

with something like:

```ts
themes: getHighlighterThemesForResolvedAppTheme(resolvedTheme);
```

If the diff package does not support custom themes, keep `pierre-light` /
`pierre-dark` for syntax during phase 1 and document syntax parity as phase 2.
The app chrome should still use VS Code theme colors immediately.

## Desktop Window Appearance

Current desktop window background:

```ts
function getInitialWindowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff";
}
```

Add renderer-driven window colors:

```ts
let windowThemeColors: {
  backgroundColor: string;
  titleBarColor?: string;
  titleBarSymbolColor?: string;
} | null = null;

function getInitialWindowBackgroundColor(): string {
  return (
    windowThemeColors?.backgroundColor ?? (nativeTheme.shouldUseDarkColors ? "#0a0a0a" : "#ffffff")
  );
}

function getWindowTitleBarOptions(): WindowTitleBarOptions {
  // keep macOS hiddenInset behavior
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: windowThemeColors?.titleBarColor ?? TITLEBAR_COLOR,
      height: TITLEBAR_HEIGHT,
      symbolColor:
        windowThemeColors?.titleBarSymbolColor ??
        (nativeTheme.shouldUseDarkColors
          ? TITLEBAR_DARK_SYMBOL_COLOR
          : TITLEBAR_LIGHT_SYMBOL_COLOR),
    },
  };
}
```

IPC handler:

```ts
ipcMain.handle(SET_WINDOW_THEME_COLORS_CHANNEL, async (_event, rawInput: unknown) => {
  const input = decodeWindowThemeColors(rawInput);
  if (!input) return;
  windowThemeColors = input;
  syncAllWindowAppearance();
});
```

## User Overrides

Support overrides in this order:

1. Theme file `colors`
2. Editor user `workbench.colorCustomizations`
3. Theme-scoped editor user overrides, if present and matching the selected theme
4. T3 fallback values

Example override shape:

```jsonc
{
  "workbench.colorCustomizations": {
    "titleBar.activeBackground": "#000000",
    "[GitHub Dark Default]": {
      "activityBar.background": "#111111",
    },
  },
}
```

Merge helper:

```ts
function mergeWorkbenchOverrides(input: {
  themeLabel: string;
  themeColors: Record<string, string>;
  customizations: Record<string, unknown>;
}): Record<string, string> {
  const next = { ...input.themeColors };

  for (const [key, rawValue] of Object.entries(input.customizations)) {
    if (key.startsWith("[") && key.endsWith("]")) continue;
    const color = normalizeCssColor(rawValue);
    if (color) next[key] = color;
  }

  const scoped = input.customizations[`[${input.themeLabel}]`];
  if (isObject(scoped)) {
    for (const [key, rawValue] of Object.entries(scoped)) {
      const color = normalizeCssColor(rawValue);
      if (color) next[key] = color;
    }
  }

  return next;
}
```

Token color customizations can be added later after code/diff syntax theme
support is proven.

## Hosted/Browser Mode

In regular browser mode there is no local filesystem access, so:

- Built-in `system`, `light`, and `dark` must continue to work.
- External theme controls should hide or show an unavailable state when
  `window.desktopBridge` is missing.
- If a cached external theme exists, it can be applied as a best-effort visual
  cache, but it should be clear that refresh/discovery requires desktop mode.

## Edge Cases

- Missing selected theme:
  - Fall back to `system`.
  - Keep the missing id in preference only if UX benefits from showing
    "unavailable"; otherwise clear it.
- Duplicate theme labels:
  - Use source + extension id + label as id.
  - Show source/publisher metadata in UI.
- Malformed extension package:
  - Ignore silently in discovery.
  - Optionally include diagnostics in a dev-only log.
- Malformed theme file:
  - Theme appears only if file parses enough to load.
- `.tmTheme` token colors:
  - Defer unless a popular installed theme needs it.
- Remote `tokenColors` URL:
  - Do not fetch automatically.
- Security:
  - Never expose arbitrary filesystem reads to the renderer.
  - Renderer can request only discovered theme ids.
  - Desktop validates theme ids against fresh discovery before loading.

## Suggested Implementation Phases

### Phase 1: Discovery And Contracts

Files:

- `packages/contracts/src/theme.ts`
- `packages/contracts/src/ipc.ts`
- `packages/contracts/src/index.ts`
- `apps/desktop/src/vscodeThemeDiscovery.ts`
- `apps/desktop/src/vscodeThemeDiscovery.test.ts`
- `apps/desktop/src/preload.ts`
- `apps/desktop/src/main.ts`

Deliverables:

- Desktop can list VS Code/Cursor themes.
- Desktop can load a selected theme by id.
- Tests cover package scanning, path safety, JSONC settings parsing, and bad
  package/theme files.

### Phase 2: Mapper And CSS Variables

Files:

- `packages/shared/src/themeMapping.ts` or `apps/web/src/themeMapping.ts`
- `apps/web/src/index.css`
- mapper tests

Deliverables:

- VS Code colors map to T3 app variables.
- Built-in app tokens remain unchanged.
- Sidebar tokens are explicit.
- Contrast fallback helpers are tested.

### Phase 3: Web Theme State And Settings UI

Files:

- `packages/contracts/src/settings.ts`
- `apps/web/src/hooks/useTheme.ts`
- `apps/web/src/hooks/useSettings.ts`
- `apps/web/src/clientPersistenceStorage.ts`
- `apps/desktop/src/clientPersistence.ts`
- `apps/web/src/components/settings/SettingsPanels.tsx`
- browser tests around settings

Deliverables:

- Theme preference is persisted in client settings.
- Old `t3code:theme` localStorage values migrate.
- Settings UI lists detected themes and built-ins.
- Selected external theme applies CSS variables.

### Phase 4: Terminal And Desktop Chrome

Files:

- `apps/web/src/components/ThreadTerminalDrawer.tsx`
- `apps/desktop/src/main.ts`
- `apps/desktop/src/preload.ts`
- `packages/contracts/src/ipc.ts`

Deliverables:

- Xterm uses VS Code `terminal.*` colors.
- Desktop background/titlebar colors match the selected theme.
- Existing terminal theme tests are updated.

### Phase 5: Code And Diff Syntax Theme Parity

Files:

- `apps/web/src/components/ChatMarkdown.tsx`
- `apps/web/src/lib/diffRendering.ts`
- `apps/web/src/components/DiffWorkerPoolProvider.tsx`
- possibly a new syntax theme adapter module

Deliverables:

- Chat code blocks use theme `tokenColors` if supported.
- Diff worker uses the same syntax theme if supported.
- If unsupported, this phase documents the blocking package limitation and keeps
  UI/terminal parity shipped.

### Phase 6: Polish And Recovery

Deliverables:

- Missing theme recovery.
- Refresh themes action.
- Current VS Code/Cursor theme badges.
- Hosted/browser unavailable state.
- Docs note in README or settings help text if needed.

## Test Plan

Required repo checks after implementation:

```sh
bun fmt
bun lint
bun typecheck
```

Use `bun run test`, never `bun test`.

Targeted tests to add/run:

```sh
bun run test --filter @t3tools/desktop -- vscodeThemeDiscovery
bun run test --filter @t3tools/web -- useTheme
bun run test --filter @t3tools/web -- SettingsPanels
bun run test --filter @t3tools/web -- ThreadTerminalDrawer
```

If root `turbo` filtering does not match these names, use package-local Vitest
commands with explicit files:

```sh
bun --cwd apps/desktop run test src/vscodeThemeDiscovery.test.ts
bun --cwd apps/web run test src/hooks/useTheme.test.ts
bun --cwd apps/web run test src/components/settings/SettingsPanels.browser.tsx
bun --cwd apps/web run test src/components/ThreadTerminalDrawer.browser.tsx
```

Manual verification:

1. Open desktop T3 Code.
2. Go to Settings -> General or Appearance.
3. Verify VS Code and Cursor themes appear.
4. Select `GitHub Dark Default`.
5. Confirm app shell, sidebar, settings cards, popovers, chat, terminal, and
   diff panel all update.
6. Switch to a light theme and confirm `.dark` compatibility class changes.
7. Quit/reopen and verify no first-paint flash beyond the cached fallback.
8. Rename or remove a selected extension directory and verify graceful fallback.

## First Implementation Slice

The smallest useful slice:

1. Add discovery/loading bridge in Electron.
2. Add mapper from VS Code `colors` to T3 variables.
3. Extend settings UI to list detected themes.
4. Apply selected external theme via CSS variables.
5. Leave syntax token parity for phase 2 if `@pierre/diffs` does not trivially
   accept custom Shiki themes.

That slice gives users the main "my T3 Code uses my VS Code theme" experience
without overfitting the first pass to every possible token color edge case.
