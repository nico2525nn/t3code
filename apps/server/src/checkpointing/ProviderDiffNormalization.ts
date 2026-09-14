/**
 * Keep provider-owned unified diffs renderable by the unchanged T3 clients.
 *
 * Codex may return more than one file-change item for the same path in a turn.
 * CodeView treats each `diff --git` section as one file, so the server merges
 * those sections once at the checkpoint boundary. Git-owned diffs pass
 * through unchanged.
 */

interface DiffSection {
  readonly header: string;
  readonly lines: ReadonlyArray<string>;
}

function readGitHeaderPaths(header: string): readonly [string, string] | undefined {
  const input = header.slice("diff --git ".length);
  const paths: string[] = [];
  let offset = 0;
  while (offset < input.length && paths.length < 2) {
    while (/\s/u.test(input[offset] ?? "")) offset += 1;
    if (offset >= input.length) break;
    if (input[offset] === '"') {
      offset += 1;
      let path = "";
      while (offset < input.length) {
        const character = input[offset++];
        if (character === '"') break;
        path += character === "\\" && offset < input.length ? input[offset++] : character;
      }
      paths.push(path);
      continue;
    }
    const start = offset;
    while (offset < input.length && !/\s/u.test(input[offset] ?? "")) offset += 1;
    paths.push(input.slice(start, offset));
  }
  return paths.length === 2 ? (paths as [string, string]) : undefined;
}

function normalizePath(path: string, side: "a" | "b"): string {
  const value = path.startsWith(`${side}/`) ? path.slice(2) : path;
  const result: string[] = [];
  for (const segment of value.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === ".." && result.at(-1) !== undefined) result.pop();
    else if (segment !== "..") result.push(segment);
  }
  return result.join("/");
}

function sectionIdentity(section: DiffSection): string {
  const paths = readGitHeaderPaths(section.header);
  if (paths !== undefined) return normalizePath(paths[1], "b");
  const newPath = section.lines.find((line) => line.startsWith("+++ "));
  return newPath === undefined || newPath === "+++ /dev/null"
    ? section.header
    : normalizePath(newPath.slice(4).split("\t", 1)[0] ?? "", "b");
}

const isHeader = (line: string): boolean => line.startsWith("diff --git ");
const isHunk = (line: string): boolean => line.startsWith("@@ ") || line.startsWith("@@@ ");
const isFileHeader = (line: string): boolean => line.startsWith("--- ") || line.startsWith("+++ ");
const isMetadata = (line: string): boolean =>
  /^(?:copy (?:from|to) |(?:deleted|new|old) file mode |(?:dis)?similarity index |index |rename (?:from|to) |--- |\+\+\+ )/u.test(
    line,
  );

function splitSections(patch: string): {
  readonly prefix: ReadonlyArray<string>;
  readonly sections: ReadonlyArray<DiffSection>;
  readonly trailingNewline: boolean;
} {
  const normalized = patch.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const trailingNewline = normalized.endsWith("\n");
  const lines = normalized.split("\n");
  if (trailingNewline) lines.pop();

  const prefix: string[] = [];
  const sections: Array<{ header: string; lines: string[] }> = [];
  let current: { header: string; lines: string[] } | undefined;
  for (const line of lines) {
    if (isHeader(line)) {
      current = { header: line, lines: [] };
      sections.push(current);
    } else if (current === undefined) {
      prefix.push(line);
    } else {
      current.lines.push(line);
    }
  }
  return { prefix, sections, trailingNewline };
}

function withoutTrailingEmptyLines(lines: ReadonlyArray<string>): ReadonlyArray<string> {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end -= 1;
  return lines.slice(0, end);
}

function mergeSections(group: ReadonlyArray<DiffSection>): DiffSection {
  const textual = group.flatMap((section) => {
    const hunkIndex = section.lines.findIndex(isHunk);
    return hunkIndex < 0 ? [] : [{ section, hunkIndex }];
  });
  const latest = group.at(-1);
  if (textual.length === 0) return latest ?? group[0]!;

  const metadata = new Set<string>();
  for (const section of group) {
    const hunkIndex = section.lines.findIndex(isHunk);
    const beforeHunks = hunkIndex < 0 ? section.lines : section.lines.slice(0, hunkIndex);
    for (const line of beforeHunks) {
      // A combined section has one file, so it must have one `---`/`+++`
      // pair. Keeping every pair makes Pierre parse the same path twice when
      // a file was created in one turn and updated in another.
      if (isMetadata(line) && !isFileHeader(line)) metadata.add(line);
    }
  }
  const markerSource = textual.at(-1)!.section;
  const markerHunkIndex = markerSource.lines.findIndex(isHunk);
  const markerLines = (
    markerHunkIndex < 0 ? markerSource.lines : markerSource.lines.slice(0, markerHunkIndex)
  ).filter(isFileHeader);
  return {
    header: group[0]!.header,
    lines: [
      ...metadata,
      ...markerLines,
      ...textual.flatMap(({ section, hunkIndex }) =>
        withoutTrailingEmptyLines(section.lines.slice(hunkIndex)),
      ),
    ],
  };
}

/** Merge repeated file sections; calling this twice produces the same patch. */
export function normalizeProviderDiff(patch: string): string {
  if (patch.length === 0 || !patch.includes("diff --git ")) return patch;
  const { prefix, sections, trailingNewline } = splitSections(patch);
  if (sections.length < 2) return patch;

  const groups = new Map<string, DiffSection[]>();
  for (const section of sections) {
    const key = sectionIdentity(section);
    groups.set(key, [...(groups.get(key) ?? []), section]);
  }
  if ([...groups.values()].every((group) => group.length === 1)) return patch;

  const lines = [
    ...prefix,
    ...[...groups.values()].flatMap((group) => {
      const section = group.length === 1 ? group[0]! : mergeSections(group);
      return [section.header, ...section.lines];
    }),
  ];
  return `${lines.join("\n")}${trailingNewline ? "\n" : ""}`;
}
