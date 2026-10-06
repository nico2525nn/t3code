import { assert, it } from "@effect/vitest";

import {
  compareNativeUpdatedAt,
  isCoveredByWatermark,
  isParsableInstant,
  NATIVE_CATALOG_MAX_PAGES_PER_PASS,
  NATIVE_CATALOG_PAGE_SIZE,
  scanNativeCatalog,
  type NativeThreadPage,
} from "./NativeCatalog.ts";
import { Effect } from "effect";

it("stops at the watermark on the first page when idle", async () => {
  let calls = 0;
  const result = await Effect.runPromise(
    scanNativeCatalog(
      () => {
        calls += 1;
        return Effect.succeed({
          threads: [
            {
              nativeId: "a",
              title: "A",
              cwd: "/tmp",
              updatedAt: "2026-01-01T00:00:00.000Z",
              createdAt: undefined,
              model: "gpt-5",
              archived: false,
              ephemeral: false,
            },
          ],
          nextCursor: "more",
        } satisfies NativeThreadPage);
      },
      {
        archived: false,
        watermark: "2026-06-01T00:00:00.000Z",
        resumeCursor: undefined,
        pageSize: NATIVE_CATALOG_PAGE_SIZE,
        maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
      },
    ),
  );
  assert.strictEqual(result.changed.length, 0);
  assert.strictEqual(result.complete, true);
  assert.strictEqual(calls, 1);
});

it("collects newer rows and advances the watermark", async () => {
  const result = await Effect.runPromise(
    scanNativeCatalog(
      () =>
        Effect.succeed({
          threads: [
            {
              nativeId: "new",
              title: undefined,
              cwd: "/tmp",
              updatedAt: "2026-06-02T00:00:00.000Z",
              createdAt: undefined,
              model: undefined,
              archived: false,
              ephemeral: false,
            },
            {
              nativeId: "old",
              title: undefined,
              cwd: "/tmp",
              updatedAt: "2026-01-01T00:00:00.000Z",
              createdAt: undefined,
              model: undefined,
              archived: false,
              ephemeral: false,
            },
          ],
          nextCursor: null,
        } satisfies NativeThreadPage),
      {
        archived: false,
        watermark: "2026-06-01T00:00:00.000Z",
        resumeCursor: undefined,
        pageSize: NATIVE_CATALOG_PAGE_SIZE,
        maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
      },
    ),
  );
  assert.deepStrictEqual(
    result.changed.map((thread) => thread.nativeId),
    ["new"],
  );
  assert.strictEqual(result.watermark, "2026-06-02T00:00:00.000Z");
  assert.strictEqual(result.complete, true);
});

it("treats the watermark instant itself as uncovered", () => {
  assert.strictEqual(
    isCoveredByWatermark("2026-06-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"),
    false,
  );
  assert.strictEqual(
    isCoveredByWatermark("2026-05-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"),
    true,
  );
  assert.strictEqual(isCoveredByWatermark("not-a-date", "2026-06-01T00:00:00.000Z"), false);
});

it("orders across offsets, not lexically", () => {
  assert.strictEqual(
    compareNativeUpdatedAt("2026-06-01T09:00:00+09:00", "2026-06-01T00:00:00Z"),
    0,
  );
  assert.strictEqual(isParsableInstant("2026-06-01T00:00:00Z"), true);
  assert.strictEqual(isParsableInstant("garbage"), false);
});

it("skips ephemeral threads and keeps the cursor when truncated", async () => {
  const result = await Effect.runPromise(
    scanNativeCatalog(
      () =>
        Effect.succeed({
          threads: [
            {
              nativeId: "e",
              title: undefined,
              cwd: "/tmp",
              updatedAt: "2026-07-01T00:00:00.000Z",
              createdAt: undefined,
              model: undefined,
              archived: false,
              ephemeral: true,
            },
          ],
          nextCursor: "cursor-1",
        } satisfies NativeThreadPage),
      {
        archived: false,
        watermark: undefined,
        resumeCursor: undefined,
        pageSize: 10,
        maxPages: 1,
      },
    ),
  );
  assert.strictEqual(result.changed.length, 0);
  assert.strictEqual(result.complete, false);
  assert.strictEqual(result.resumeCursor, "cursor-1");
});
