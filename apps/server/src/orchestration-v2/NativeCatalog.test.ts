import { assert, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type {
  ProviderAdapterV2ListNativeThreadsInput,
  ProviderAdapterV2NativeThreadPage,
  ProviderAdapterV2NativeThreadSummary,
} from "./ProviderAdapter.ts";
import {
  NATIVE_CATALOG_MAX_PAGES_PER_PASS,
  NATIVE_CATALOG_PAGE_SIZE,
  compareNativeUpdatedAt,
  isCoveredByWatermark,
  scanNativeCatalog,
} from "./NativeCatalog.ts";

const thread = (input: {
  readonly nativeId: string;
  readonly updatedAt: string;
  readonly ephemeral?: boolean;
}): ProviderAdapterV2NativeThreadSummary => ({
  nativeId: input.nativeId,
  title: undefined,
  cwd: "/workspace",
  updatedAt: input.updatedAt,
  createdAt: undefined,
  archived: false,
  ephemeral: input.ephemeral ?? false,
  active: false,
});

/** A catalog split into fixed-size pages, newest first, as App Server returns it. */
const catalog =
  (
    threads: ReadonlyArray<ProviderAdapterV2NativeThreadSummary>,
    requests: Array<ProviderAdapterV2ListNativeThreadsInput> = [],
  ) =>
  (
    input: ProviderAdapterV2ListNativeThreadsInput,
  ): Effect.Effect<ProviderAdapterV2NativeThreadPage, never> => {
    requests.push(input);
    const offset = input.cursor === undefined ? 0 : Number(input.cursor);
    const slice = threads.slice(offset, offset + input.limit);
    const nextOffset = offset + slice.length;
    return Effect.succeed({
      threads: slice,
      nextCursor: nextOffset >= threads.length ? null : String(nextOffset),
    });
  };

describe("compareNativeUpdatedAt", () => {
  it("orders equal instants written with different UTC offsets", () => {
    expect(compareNativeUpdatedAt("2026-10-01T00:00:00Z", "2026-10-01T09:00:00+09:00")).toBe(0);
    expect(
      compareNativeUpdatedAt("2026-10-01T10:00:00+09:00", "2026-10-01T00:00:00Z"),
    ).toBeGreaterThan(0);
  });

  it("refuses to order an unparsable timestamp", () => {
    expect(compareNativeUpdatedAt("not-a-date", "2026-10-01T00:00:00Z")).toBeUndefined();
  });
});

describe("isCoveredByWatermark", () => {
  it("treats an unparsable row as uncovered rather than stale", () => {
    expect(isCoveredByWatermark("not-a-date", "2026-10-01T00:00:00Z")).toBe(false);
  });

  it("re-reads a row that sits exactly on the watermark", () => {
    // `updated_at` is not unique. A conversation created later at the very
    // instant the watermark holds would otherwise never be discovered.
    expect(isCoveredByWatermark("2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")).toBe(false);
    expect(isCoveredByWatermark("2026-09-30T00:00:00Z", "2026-10-01T00:00:00Z")).toBe(true);
  });
});

describe("scanNativeCatalog", () => {
  it("stops after one page when nothing is newer than the watermark", async () => {
    const requests: Array<ProviderAdapterV2ListNativeThreadsInput> = [];
    const scan = await Effect.runPromise(
      scanNativeCatalog(
        catalog(
          [
            thread({ nativeId: "a", updatedAt: "2026-10-03T00:00:00Z" }),
            thread({ nativeId: "b", updatedAt: "2026-10-02T00:00:00Z" }),
          ],
          requests,
        ),
        {
          archived: false,
          watermark: "2026-10-01T00:00:00Z",
          resumeCursor: undefined,
          pageSize: NATIVE_CATALOG_PAGE_SIZE,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    // An idle sync must cost exactly one request, not one per conversation.
    expect(requests).toHaveLength(1);
    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a", "b"]);
    expect(scan.complete).toBe(true);
    expect(scan.resumeCursor).toBeNull();
  });

  it("returns everything newer than the watermark and raises it", async () => {
    const scan = await Effect.runPromise(
      scanNativeCatalog(
        catalog([
          thread({ nativeId: "a", updatedAt: "2026-10-05T00:00:00Z" }),
          thread({ nativeId: "b", updatedAt: "2026-10-04T00:00:00Z" }),
          thread({ nativeId: "c", updatedAt: "2026-10-03T00:00:00Z" }),
          thread({ nativeId: "old", updatedAt: "2026-09-01T00:00:00Z" }),
        ]),
        {
          archived: false,
          watermark: "2026-10-03T00:00:00Z",
          resumeCursor: undefined,
          pageSize: 2,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a", "b", "c"]);
    expect(scan.watermark).toBe("2026-10-05T00:00:00Z");
    expect(scan.complete).toBe(true);
  });

  it("keeps paging past the newest row instead of stopping after one page", async () => {
    const scan = await Effect.runPromise(
      scanNativeCatalog(
        catalog([
          thread({ nativeId: "a", updatedAt: "2026-10-05T00:00:00Z" }),
          thread({ nativeId: "b", updatedAt: "2026-10-04T00:00:00Z" }),
          thread({ nativeId: "c", updatedAt: "2026-10-03T00:00:00Z" }),
        ]),
        {
          archived: false,
          watermark: "2026-10-01T00:00:00Z",
          resumeCursor: undefined,
          pageSize: 1,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a", "b", "c"]);
    expect(scan.complete).toBe(true);
  });

  it("skips ephemeral conversations, which are never durable", async () => {
    const scan = await Effect.runPromise(
      scanNativeCatalog(
        catalog([
          thread({ nativeId: "a", updatedAt: "2026-10-05T00:00:00Z" }),
          thread({ nativeId: "temp", updatedAt: "2026-10-06T00:00:00Z", ephemeral: true }),
        ]),
        {
          archived: false,
          watermark: undefined,
          resumeCursor: undefined,
          pageSize: NATIVE_CATALOG_PAGE_SIZE,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a"]);
  });

  it("does not claim completion when the page budget stops it", async () => {
    // 1500 rows with no watermark and a 1-row page: the pass cannot reach the
    // end, so committing its newest timestamp would hide everything behind the
    // boundary forever. It must report an unfinished pass and a resume point.
    const rows = Array.from({ length: 1_500 }, (_, index) =>
      thread({ nativeId: `n${index}`, updatedAt: "2026-10-05T00:00:00Z" }),
    );
    const scan = await Effect.runPromise(
      scanNativeCatalog(catalog(rows), {
        archived: false,
        watermark: undefined,
        resumeCursor: undefined,
        pageSize: 100,
        maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
      }),
    );

    assert.isFalse(scan.complete);
    expect(scan.resumeCursor).not.toBeNull();
    expect(scan.changed).toHaveLength(800);
  });

  it("finishes a large catalog by resuming from the recorded cursor", async () => {
    const rows = Array.from({ length: 1_500 }, (_, index) =>
      thread({ nativeId: `n${index}`, updatedAt: "2026-10-05T00:00:00Z" }),
    );
    const seen: string[] = [];
    let cursor: string | undefined;
    let passes = 0;

    while (passes < 20) {
      passes += 1;
      const scan: Awaited<ReturnType<typeof scanPass>> = await scanPass(cursor);
      seen.push(...scan.changed.map((entry) => entry.nativeId));
      if (scan.complete) break;
      cursor = scan.resumeCursor ?? undefined;
    }

    expect(seen).toHaveLength(1_500);
    expect(new Set(seen).size).toBe(1_500);

    async function scanPass(from: string | undefined) {
      return Effect.runPromise(
        scanNativeCatalog(catalog(rows), {
          archived: false,
          watermark: undefined,
          resumeCursor: from,
          pageSize: 100,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        }),
      );
    }
  });
});
