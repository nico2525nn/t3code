import * as Effect from "effect/Effect";

/** One conversation the provider owns natively, whether or not T3 created it. */
export interface NativeThreadSummary {
  readonly nativeId: string;
  readonly title: string | undefined;
  readonly cwd: string;
  /** ISO-8601 instant the provider last modified the conversation. */
  readonly updatedAt: string;
  readonly createdAt: string | undefined;
  readonly model: string | undefined;
  readonly archived: boolean;
  /** Ephemeral conversations are never materialized on disk; skip them. */
  readonly ephemeral: boolean;
}

export interface NativeThreadPage {
  readonly threads: ReadonlyArray<NativeThreadSummary>;
  readonly nextCursor: string | null;
}

export interface ListNativeThreadsInput {
  readonly archived: boolean;
  readonly cursor: string | undefined;
  readonly limit: number;
}

/** One catalog page; providers page newest-first so idle syncs stop after one page. */
export const NATIVE_CATALOG_PAGE_SIZE = 100;

/** Defensive bound on one pass; unfinished work resumes from the stored cursor. */
export const NATIVE_CATALOG_MAX_PAGES_PER_PASS = 8;

export function isParsableInstant(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

export function compareNativeUpdatedAt(left: string, right: string): number | undefined {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isNaN(leftMs) || Number.isNaN(rightMs)) return undefined;
  return leftMs === rightMs ? 0 : leftMs < rightMs ? -1 : 1;
}

/**
 * Whether a row is already covered by a scan up to `watermark`.
 * Equality is deliberately *not* covered: two conversations can share an
 * instant, and the later one would otherwise stay invisible forever.
 */
export function isCoveredByWatermark(candidate: string, watermark: string): boolean {
  const order = compareNativeUpdatedAt(candidate, watermark);
  return order !== undefined && order < 0;
}

export interface NativeCatalogScan {
  readonly changed: ReadonlyArray<NativeThreadSummary>;
  readonly watermark: string | undefined;
  readonly resumeCursor: string | null;
  readonly complete: boolean;
}

/**
 * Walk a native catalog newest-first toward the committed watermark.
 * The watermark is a commit point: it advances only when the pass reached it
 * or the catalog end. Anything else keeps the cursor for the next pass.
 */
export function scanNativeCatalog<E, R>(
  readPage: (input: ListNativeThreadsInput) => Effect.Effect<NativeThreadPage, E, R>,
  input: {
    readonly archived: boolean;
    readonly watermark: string | undefined;
    readonly resumeCursor: string | undefined;
    readonly pageSize: number;
    readonly maxPages: number;
  },
): Effect.Effect<NativeCatalogScan, E, R> {
  return Effect.gen(function* () {
    const changed: NativeThreadSummary[] = [];
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
          return { changed, watermark: newest, resumeCursor: null, complete: true };
        }
        changed.push(thread);
        if (newest !== undefined && isCoveredByWatermark(thread.updatedAt, newest)) continue;
        if (isParsableInstant(thread.updatedAt)) newest = thread.updatedAt;
      }
      if (result.nextCursor === null) {
        return { changed, watermark: newest, resumeCursor: null, complete: true };
      }
      cursor = result.nextCursor;
    }

    return { changed, watermark: newest, resumeCursor: cursor ?? null, complete: false };
  });
}
