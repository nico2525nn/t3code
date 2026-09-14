import { describe, expect, it } from "vite-plus/test";
import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";

import { normalizeProviderDiff } from "./ProviderDiffNormalization.ts";

describe("normalizeProviderDiff", () => {
  it("combines repeated textual file sections into one file with multiple hunks", () => {
    const patch = [
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -1 +1 @@",
      "-{",
      "+{",
      "diff --git a/package.json b/package.json",
      "--- a/package.json",
      "+++ b/package.json",
      "@@ -8 +8 @@",
      '-  "old": true',
      '+  "new": true',
      "",
    ].join("\n");

    expect(normalizeProviderDiff(patch)).toBe(
      [
        "diff --git a/package.json b/package.json",
        "--- a/package.json",
        "+++ b/package.json",
        "@@ -1 +1 @@",
        "-{",
        "+{",
        "@@ -8 +8 @@",
        '-  "old": true',
        '+  "new": true',
        "",
      ].join("\n"),
    );
  });

  it("does not combine different files and is idempotent", () => {
    const patch = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1 +1 @@",
      "-a",
      "+b",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1 +1 @@",
      "-c",
      "+d",
    ].join("\n");

    const normalized = normalizeProviderDiff(patch);
    expect(normalized).toBe(patch);
    expect(normalizeProviderDiff(normalized)).toBe(normalized);
  });

  it("collapses a malformed metadata-only prefix into the later textual section", () => {
    const patch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "raw provider body without a hunk header",
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+raw provider body without a hunk header",
    ].join("\n");

    const normalized = normalizeProviderDiff(patch);
    expect(normalized).toBe(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1 @@",
        "+raw provider body without a hunk header",
      ].join("\n"),
    );
    expect(normalizeProviderDiff(normalized)).toBe(normalized);
  });

  it("collapses metadata-only duplicates to one latest section", () => {
    const patch = [
      "diff --git a/image.bin b/image.bin",
      "GIT binary patch",
      "literal 1",
      "a",
      "diff --git a/image.bin b/image.bin",
      "GIT binary patch",
      "literal 1",
      "b",
    ].join("\n");

    expect(normalizeProviderDiff(patch)).toBe(
      ["diff --git a/image.bin b/image.bin", "GIT binary patch", "literal 1", "b"].join("\n"),
    );
  });

  it("joins equivalent path spellings that would otherwise produce duplicate CodeView ids", () => {
    const patch = [
      "diff --git a//home/nico/.bun/install/global/package.json b//home/nico/.bun/install/global/package.json",
      "--- a//home/nico/.bun/install/global/package.json",
      "+++ b//home/nico/.bun/install/global/package.json",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/home/nico/.bun/install/global/./package.json b/home/nico/.bun/install/global/package.json",
      "--- a/home/nico/.bun/install/global/package.json",
      "+++ b/home/nico/.bun/install/global/package.json",
      "@@ -2 +2 @@",
      "-old-two",
      "+new-two",
    ].join("\n");

    const normalized = normalizeProviderDiff(patch);
    expect(normalized.match(/^diff --git /gmu)).toHaveLength(1);
    expect(normalized).toContain("@@ -1 +1 @@");
    expect(normalized).toContain("@@ -2 +2 @@");
    expect(normalized).toContain("diff --git a//home/nico/.bun/install/global/package.json");
    expect(normalizeProviderDiff(normalized)).toBe(normalized);
  });

  it("keeps one file header when a file is created and then updated", () => {
    const patch = [
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1 @@",
      "+first",
      "diff --git a/src/new.ts b/src/new.ts",
      "--- a/src/new.ts",
      "+++ b/src/new.ts",
      "@@ -1 +1 @@",
      "-first",
      "+second",
    ].join("\n");

    const normalized = normalizeProviderDiff(patch);
    expect(normalized.match(/^diff --git /gmu)).toHaveLength(1);
    expect(normalized.match(/^--- /gmu)).toHaveLength(1);
    expect(normalized.match(/^\+\+\+ /gmu)).toHaveLength(1);
    expect(parsePatchFiles(normalized).flatMap((entry) => entry.files)).toHaveLength(1);
  });
});
