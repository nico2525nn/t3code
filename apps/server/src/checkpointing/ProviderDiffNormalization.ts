/**
 * Normalize provider-owned unified diffs for the unmodified T3 clients.
 *
 * Codex App Server can report several file-change items for one path in a
 * single turn. Concatenating those items produces several `diff --git`
 * sections for the same file. The T3 client renderer treats one file section
 * as one CodeView item, so duplicate sections make older clients throw before
 * they can display the patch.
 *
 * A repeated section is safe to represent as one file header. Textual hunks
 * are concatenated, while malformed metadata-only prefixes are discarded
 * after their file metadata has been retained. This is a compatibility
 * boundary: the T3 client can only render one CodeView item per file identity.
 */

interface DiffSection {
  readonly header: string;
  readonly lines: Array<string>;
}

function isFileHeader(line: string): boolean {
  return line.startsWith("diff --git ");
}

function firstHunkIndex(lines: ReadonlyArray<string>): number {
  return lines.findIndex((line) => line.startsWith("@@ ") || line.startsWith("@@@ "));
}

const DIFF_METADATA_PREFIXES = [
  "copy from ",
  "copy to ",
  "deleted file mode ",
  "dissimilarity index ",
  "index ",
  "new file mode ",
  "new mode ",
  "old mode ",
  "rename from ",
  "rename to ",
  "similarity index ",
  "--- ",
  "+++ ",
] as const;

function isDiffMetadataLine(line: string): boolean {
  return DIFF_METADATA_PREFIXES.some((prefix) => line.startsWith(prefix));
}

function metadataLines(section: DiffSection, hunkIndex: number): Array<string> {
  const candidates = hunkIndex >= 0 ? section.lines.slice(0, hunkIndex) : section.lines;
  const metadata: string[] = [];

  for (const line of candidates) {
    if (line.length === 0) continue;
    if (!isDiffMetadataLine(line)) {
      // A provider occasionally emits the complete new-file body without a
      // hunk header. Do not mistake that body for diff metadata.
      if (hunkIndex < 0) break;
      continue;
    }
    if (!metadata.includes(line)) metadata.push(line);
  }

  return metadata;
}

function withoutTrailingEmptyLines(lines: ReadonlyArray<string>): Array<string> {
  const result = [...lines];
  while (result.at(-1) === "") result.pop();
  return result;
}

function splitSections(patch: string): {
  readonly prefix: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<DiffSection>;
} {
  const normalized = patch.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.split("\n");
  const prefix: string[] = [];
  const sections: DiffSection[] = [];
  let current: DiffSection | undefined;

  for (const line of lines) {
    if (isFileHeader(line)) {
      current = { header: line, lines: [] };
      sections.push(current);
      continue;
    }
    if (current === undefined) {
      prefix.push(line);
    } else {
      current.lines.push(line);
    }
  }

  return { prefix, sections };
}

/**
 * Merge repeated file sections while retaining their complete textual hunk
 * bodies. The function is intentionally idempotent and leaves ordinary Git
 * patches byte-for-byte equivalent apart from line-ending normalization.
 */
export function normalizeProviderDiff(patch: string): string {
  if (patch.length === 0 || !patch.includes("diff --git ")) {
    return patch;
  }

  const { prefix, sections } = splitSections(patch);
  if (sections.length < 2) {
    return patch;
  }

  const groups = new Map<string, Array<DiffSection>>();
  for (const section of sections) {
    const group = groups.get(section.header);
    if (group === undefined) {
      groups.set(section.header, [section]);
    } else {
      group.push(section);
    }
  }

  let merged = false;
  const normalizedSections: DiffSection[] = [];

  for (const group of groups.values()) {
    const first = group[0];
    if (first === undefined) continue;
    if (group.length === 1) {
      normalizedSections.push(first);
      continue;
    }

    merged = true;
    const hunkSections = group
      .map((section) => ({ section, hunkIndex: firstHunkIndex(section.lines) }))
      .filter((entry) => entry.hunkIndex >= 0);

    if (hunkSections.length === 0) {
      // There is no lossless way to combine multiple binary patches. Keeping
      // the last complete section still gives the client one stable file item
      // and matches the provider's latest-file-wins stream ordering.
      const latest = group[group.length - 1];
      if (latest !== undefined) normalizedSections.push(latest);
      continue;
    }

    const mergedLines: string[] = [];
    const metadata = new Set<string>();
    for (const { section, hunkIndex } of group.map((section) => ({
      section,
      hunkIndex: firstHunkIndex(section.lines),
    }))) {
      for (const line of metadataLines(section, hunkIndex)) {
        if (!metadata.has(line)) {
          metadata.add(line);
          mergedLines.push(line);
        }
      }
    }

    for (const { section, hunkIndex } of hunkSections) {
      mergedLines.push(...withoutTrailingEmptyLines(section.lines.slice(hunkIndex)));
    }

    normalizedSections.push({
      header: first.header,
      lines: mergedLines,
    });
  }

  if (!merged) {
    return patch;
  }

  const lines = [
    ...prefix,
    ...normalizedSections.flatMap((section) => [section.header, ...section.lines]),
  ];
  if (patch.replaceAll("\r\n", "\n").replaceAll("\r", "\n").endsWith("\n")) {
    lines.push("");
  }
  return lines.join("\n");
}
