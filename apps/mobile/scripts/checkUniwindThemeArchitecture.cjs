const fs = require("node:fs");
const path = require("node:path");

const SOURCE_ROOT = path.resolve(__dirname, "../src");
const INTEROP_ALLOWLIST = new Set([
  "features/archive/ArchivedThreadsScreen.tsx",
  "features/connection/ConnectionsNewRouteScreen.tsx",
  "features/files/FileMarkdownPreview.tsx",
  "features/files/ThreadFilesRouteScreen.tsx",
  "features/files/thread-file-navigator-pane.tsx",
  "features/home/HomeHeader.tsx",
  "features/review/ReviewSheet.tsx",
  "features/settings/SettingsEnvironmentsRouteScreen.tsx",
  "features/settings/appearance/components/AppearancePreviews.tsx",
  "features/settings/appearance/components/FontSizeSliderRow.tsx",
  "features/threads/NewTaskContextPickerScreens.tsx",
  "features/threads/NewTaskDraftScreen.tsx",
  "features/threads/ThreadComposer.tsx",
  "features/threads/ThreadFeed.tsx",
  "features/threads/ThreadNavigationSidebar.tsx",
  "features/threads/ThreadSettingsSheet.tsx",
  "features/threads/git/GitOverviewSheet.tsx",
  "features/threads/thread-list-items.tsx",
  "features/threads/thread-list-v2-items.tsx",
  "lib/useUniwindTheme.ts",
  "native/T3ComposerEditor.ios.tsx",
  "native/T3ComposerEditor.native.tsx",
]);

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.[cm]?[jt]sx?$/.test(entry.name) ? [target] : [];
  });
}

const violations = [];
for (const filename of sourceFiles(SOURCE_ROOT)) {
  const relative = path.relative(SOURCE_ROOT, filename);
  const source = fs.readFileSync(filename, "utf8");

  if (/\buseCSSVariable\s*\(/.test(source)) {
    violations.push(`${relative}: useCSSVariable bypasses the Pro ShadowTree path`);
  }
  if (/\buseThemeColor\s*\(/.test(source)) {
    violations.push(`${relative}: useThemeColor was replaced by Uniwind classes`);
  }
  if (source.includes("useUniwindTheme") && !INTEROP_ALLOWLIST.has(relative)) {
    violations.push(
      `${relative}: add theme styling through className or document this interop boundary`,
    );
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exitCode = 1;
}
