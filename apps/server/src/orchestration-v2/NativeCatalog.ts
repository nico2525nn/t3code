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
 * Defensive bound on one paging turn.
 *
 * A pass that stops here is not lost work: the caller keeps its cursor and
 * resumes from it, so a very large backfill still completes across passes. It
 * only bounds how long a single turn can run.
 */
export const NATIVE_CATALOG_MAX_PAGES_PER_PASS = 8;

/**
 * Whether a timestamp names an instant this scan can order.
 *
 * An unparsable value is not a usable watermark: every comparison against it
 * would be meaningless, so it must never become one.
 */
export function isParsableInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * Compare native timestamps as instants rather than strings.
 *
 * Providers emit ISO-8601 with differing offsets (`+09:00` vs `Z`), so lexical
 * comparison would order them wrongly. Returns `undefined` when either side
 * cannot be parsed, because no ordering of an unknown instant can be trusted.
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
 * Whether a row may be treated as already covered by a scan up to `watermark`.
 *
 * `updated_at` is not a unique cursor, so equality is deliberately *not*
 * covered: a conversation that appears later at exactly the watermark instant
 * would otherwise be invisible forever. Re-reading the boundary rows is cheap
 * because imports are keyed by native identity, and losing a conversation is
 * not.
 *
 * An unparsable timestamp is not proof of staleness either, so it is treated as
 * new and re-synced.
 */
export function isCoveredByWatermark(candidate: string, watermark: string): boolean {
  const order = compareNativeUpdatedAt(candidate, watermark);
  return order !== undefined && order < 0;
}

export interface NativeCatalogScan {
  /** Conversations this pass found that the committed watermark does not cover. */
  readonly changed: ReadonlyArray<ProviderAdapterV2NativeThreadSummary>;
  /** Newest parsable `updatedAt` seen, which is the candidate commit point. */
  readonly watermark: string | undefined;
  /**
   * Where to resume if this pass did not finish. `null` once the scan reached
   * the committed watermark or the end of the catalog.
   */
  readonly resumeCursor: string | null;
  /** True when the scan reached its commit point and the watermark may advance. */
  readonly complete: boolean;
}

/**
 * Walk a native catalog from newest to oldest toward the committed watermark.
 *
 * Descending pages plus the early exit are what make an idle sync cost one
 * request instead of one per conversation.
 *
 * The committed watermark is a commit point, not a progress counter. It may
 * only advance when this pass actually reached it or ran out of catalog; a pass
 * that stopped at its page budget returns the cursor to resume from instead, so
 * the rows behind the boundary are read on a later pass rather than skipped
 * forever.
 */
export function scanNativeCatalog(
  readPage: ProviderAdapterV2NativeThreadPageReader,
  input: {
    readonly archived: boolean;
    /** Committed watermark; rows strictly older than it are already imported. */
    readonly watermark: string | undefined;
    /** Where an unfinished previous pass stopped. */
    readonly resumeCursor: string | undefined;
    readonly pageSize: number;
    readonly maxPages: number;
  },
): Effect.Effect<NativeCatalogScan, ProviderAdapterV2Error> {
  return Effect.gen(function* () {
    const changed: ProviderAdapterV2NativeThreadSummary[] = [];
    let cursor = input.resumeCursor;
    let newest = input.watermark;

    for (let page = 0; page < input.maxPages; page += 1) {
      const result = yield* readPage({
        archived: input.archived,
        cursor,
        limit: input.pageSize,
      });
      for (const thread of result.threads) {
        if (thread.ephemeral) continue;
        if (
          input.watermark !== undefined &&
          isCoveredByWatermark(thread.updatedAt, input.watermark)
        ) {
          // Descending order guarantees every later row is older still, so the
          // rest of the catalog cannot contain unseen work.
          return { changed, watermark: newest, resumeCursor: null, complete: true };
        }
        changed.push(thread);
        // Skip rows the running watermark already covers; only a strictly newer
        // instant may replace the candidate commit point.
        if (newest !== undefined && isCoveredByWatermark(thread.updatedAt, newest)) {
          continue;
        }
        if (isParsableInstant(thread.updatedAt)) {
          newest = thread.updatedAt;
        }
      }
      if (result.nextCursor === null) {
        return { changed, watermark: newest, resumeCursor: null, complete: true };
      }
      cursor = result.nextCursor;
    }

    return { changed, watermark: newest, resumeCursor: cursor ?? null, complete: false };
  });
}
