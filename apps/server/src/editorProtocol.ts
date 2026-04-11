import { pathToFileURL } from "node:url";

import type { EditorId } from "@t3tools/contracts";

export const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

export const WINDOWS_EDITOR_URI_SCHEMES: Partial<Record<EditorId, string>> = {
  vscode: "vscode",
  "vscode-insiders": "vscode-insiders",
  vscodium: "vscodium",
};

export function splitLineColumnSuffix(target: string): {
  readonly filePath: string;
  readonly suffix: string;
} {
  const match = target.match(LINE_COLUMN_SUFFIX_PATTERN);
  if (!match) {
    return { filePath: target, suffix: "" };
  }

  return {
    filePath: target.slice(0, -match[0].length),
    suffix: match[0],
  };
}

export function makeWindowsEditorProtocolTarget(
  editor: EditorId,
  target: string,
): string | undefined {
  const scheme = WINDOWS_EDITOR_URI_SCHEMES[editor];
  if (!scheme) return undefined;

  const { filePath, suffix } = splitLineColumnSuffix(target);
  const fileUrl = pathToFileURL(filePath).href;
  const fileTarget = fileUrl.startsWith("file:///")
    ? fileUrl.slice("file:///".length)
    : fileUrl.replace(/^file:\/\//, "");

  return `${scheme}://file/${fileTarget}${suffix}`;
}
