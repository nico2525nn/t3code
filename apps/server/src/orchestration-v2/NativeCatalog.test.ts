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
    // Re-reading one conversation is cheap; dropping it would lose history.
    expect(isCoveredByWatermark("not-a-date", "2026-10-01T00:00:00Z")).toBe(false);
    expect(isCoveredByWatermark("2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")).toBe(true);
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
          watermark: "2026-10-02T00:00:00Z",
          pageSize: NATIVE_CATALOG_PAGE_SIZE,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    // An idle sync must cost exactly one request, not one per conversation.
    expect(requests).toHaveLength(1);
    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a"]);
    expect(scan.truncated).toBe(false);
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
          pageSize: 2,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a", "b"]);
    expect(scan.watermark).toBe("2026-10-05T00:00:00Z");
  });

  it("reads the whole catalog when no watermark exists yet", async () => {
    const requests: Array<ProviderAdapterV2ListNativeThreadsInput> = [];
    const scan = await Effect.runPromise(
      scanNativeCatalog(
        catalog(
          [
            thread({ nativeId: "a", updatedAt: "2026-10-05T00:00:00Z" }),
            thread({ nativeId: "b", updatedAt: "2026-10-04T00:00:00Z" }),
            thread({ nativeId: "c", updatedAt: "2026-10-03T00:00:00Z" }),
          ],
          requests,
        ),
        {
          archived: false,
          watermark: undefined,
          pageSize: 2,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    expect(requests).toHaveLength(2);
    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a", "b", "c"]);
    expect(scan.watermark).toBe("2026-10-05T00:00:00Z");
  });

  it("keeps paging past the newest row instead of stopping after one page", async () => {
    // Regression guard: the stop test must use the caller's watermark, not the
    // newest row seen so far, or every scan would end one page early.
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
          pageSize: 1,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a", "b", "c"]);
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
          pageSize: NATIVE_CATALOG_PAGE_SIZE,
          maxPages: NATIVE_CATALOG_MAX_PAGES_PER_PASS,
        },
      ),
    );

    expect(scan.changed.map((entry) => entry.nativeId)).toEqual(["a"]);
  });

  it("bounds a pass that the watermark cannot stop", async () => {
    const scan = await Effect.runPromise(
      scanNativeCatalog(
        catalog([
          thread({ nativeId: "a", updatedAt: "2026-10-05T00:00:00Z" }),
          thread({ nativeId: "b", updatedAt: "2026-10-04T00:00:00Z" }),
          thread({ nativeId: "c", updatedAt: "2026-10-03T00:00:00Z" }),
          thread({ nativeId: "d", updatedAt: "2026-10-02T00:00:00Z" }),
        ]),
        { archived: false, watermark: "2020-01-01T00:00:00Z", pageSize: 1, maxPages: 2 },
      ),
    );

    assert.isTrue(scan.truncated);
    expect(scan.changed).toHaveLength(2);
  });
});
