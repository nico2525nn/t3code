import { describe, expect, it } from "vite-plus/test";

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
});
