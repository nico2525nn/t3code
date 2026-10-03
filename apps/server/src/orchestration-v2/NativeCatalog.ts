import * as Effect from "effect/Effect";

import type {
  ProviderAdapterV2Error,
  ProviderAdapterV2NativeThreadPageReader,
  ProviderAdapterV2NativeThreadSummary,
} from "./ProviderAdapter.ts";

/**
 * A page size that keeps one catalog read small enough to repeat cheaply.
 * Providers that page by descending update time stop after the first page
 * whenever nothing changed, so this value only bounds a burst.
 */
export const NATIVE_CATALOG_PAGE_SIZE = 100;

/**
 * Defensive bound for a single sync pass.
 *
 * A watermark miss (a rewritten `updatedAt`, a driver that ignores cursors)
 * must degrade into "sync fewer threads this pass", never into an unbounded
 * scan that stalls startup.
 */
export const NATIVE_CATALOG_MAX_PAGES_PER_PASS = 8;

/**
 * Compare native timestamps as instants rather than strings.
 *
 * Providers emit ISO-8601 with differing offsets (`+09:00` vs `Z`), so lexical
 * comparison would order them wrongly and would stop a watermark scan early or
 * late. Returns `undefined` when either side cannot be parsed, because no
 * ordering of an unknown instant can be trusted.
 */
export function compareNativeUpdatedAt(left: string, right: string): number | undefined {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) {
    return undefined;
  }
  return leftMs === rightMs ? 0 : leftMs < rightMs ? -1 : 1;
}

/**
 * True when `candidate` is provably already covered by a scan up to `watermark`.
 *
 * An unparsable timestamp is not proof of staleness, so such a row is treated
 * as new and re-synced. Re-reading one conversation is cheap; silently
 * dropping it would lose the user's history.
 */
export function isCoveredByWatermark(candidate: string, watermark: string): boolean {
  const order = compareNativeUpdatedAt(candidate, watermark);
  return order !== undefined && order <= 0;
}

export interface NativeCatalogScan {
  /** Conversations newer than the watermark. */
  readonly changed: ReadonlyArray<ProviderAdapterV2NativeThreadSummary>;
  /** Newest parsable `updatedAt` observed, to become the next watermark. */
  readonly watermark: string | undefined;
  /** True when the page cap stopped the scan before the catalog was exhausted. */
  readonly truncated: boolean;
}

/**
 * Walk a native catalog from newest to oldest, stopping at `watermark`.
 *
 * Descending pages plus an early exit are what make an idle sync cost one
 * request instead of one per conversation. Anything the watermark already
 * covers is known to T3, so reading past it could only rediscover finished work.
 */
export function scanNativeCatalog(
  readPage: ProviderAdapterV2NativeThreadPageReader,
  input: {
    readonly archived: boolean;
    readonly watermark: string | undefined;
    readonly pageSize: number;
    readonly maxPages: number;
  },
): Effect.Effect<NativeCatalogScan, ProviderAdapterV2Error> {
  return Effect.gen(function* () {
    const changed: ProviderAdapterV2NativeThreadSummary[] = [];
    let cursor: string | undefined;
    // The stop test compares against the watermark the caller passed in.
    // Advancing it while paging would make the next page look stale and would
    // end the scan one page early.
    const stopAt = input.watermark;
    let newest = input.watermark;
    let truncated = false;

    for (let page = 0; page < input.maxPages; page += 1) {
      const result = yield* readPage({
        archived: input.archived,
        cursor,
        limit: input.pageSize,
      });
      for (const thread of result.threads) {
        if (thread.ephemeral) continue;
        if (stopAt !== undefined && isCoveredByWatermark(thread.updatedAt, stopAt)) {
          // Descending order guarantees every later row is older still, so the
          // rest of the catalog cannot contain unseen work.
          return { changed, watermark: newest, truncated };
        }
        changed.push(thread);
        const order = newest === undefined ? 1 : compareNativeUpdatedAt(thread.updatedAt, newest);
        // An unparsable timestamp must not become the watermark: every later
        // comparison against it would be meaningless.
        if (order !== undefined && order > 0) {
          newest = thread.updatedAt;
        }
      }
      if (result.nextCursor === null) {
        return { changed, watermark: newest, truncated };
      }
      cursor = result.nextCursor;
      truncated = true;
    }

    return { changed, watermark: newest, truncated };
  });
}
