import { ProviderDriverKind } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type { ProviderAdapterV2Error } from "./ProviderAdapter.ts";

/**
 * A native turn as the provider reports it, before T3 identity is applied.
 *
 * Kept provider-neutral on purpose: the caller assigns app ids, ordinals and
 * timestamps from its own model, so an adapter only has to describe what the
 * provider said.
 */
export interface NativeTimelineTurn {
  readonly nativeTurnId: string;
  readonly status: "completed" | "interrupted" | "failed" | "inProgress";
  readonly startedAt: string | undefined;
  readonly completedAt: string | undefined;
  readonly items: ReadonlyArray<NativeTimelineItem>;
}

/**
 * The conversation-bearing subset of a provider's item vocabulary.
 *
 * Deliberately narrow. Control-flow items (compaction markers, image views,
 * idle sleepers) carry no user-visible conversation, and copying them would
 * grow the read-through without adding anything a reader can see.
 */
export type NativeTimelineItem =
  | { readonly kind: "user_message"; readonly nativeItemId: string; readonly text: string }
  | {
      readonly kind: "assistant_message";
      readonly nativeItemId: string;
      readonly text: string;
      readonly completed: boolean;
    }
  | {
      readonly kind: "reasoning";
      readonly nativeItemId: string;
      readonly text: string;
      readonly completed: boolean;
    }
  | { readonly kind: "plan"; readonly nativeItemId: string; readonly text: string }
  | {
      readonly kind: "tool";
      readonly nativeItemId: string;
      /** `null` when the provider recorded no label; readers render the tool name. */
      readonly title: string | null;
      readonly toolName: string;
      readonly completed: boolean;
    };

export interface NativeTimelinePage {
  readonly turns: ReadonlyArray<NativeTimelineTurn>;
  /** Continuation for the older page, or `null` when the thread is exhausted. */
  readonly nextCursor: string | null;
}

export interface NativeTimelineReadInput {
  readonly nativeThreadId: string;
  /**
   * Opaque continuation from a previous page, or absent for the newest turns.
   * The provider owns this cursor; T3 never interprets it.
   */
  readonly cursor: string | undefined;
}

/**
 * Rows read per provider request.
 *
 * Providers page by turn for metadata and by item for bodies. Asking for a
 * small item page keeps a single long turn from turning one read into the whole
 * transcript, which is what made an unopened Codex thread cost its full native
 * size.
 */
export const NATIVE_TIMELINE_TURN_PAGE_SIZE = 10;

export const NATIVE_TIMELINE_ITEM_PAGE_SIZE = 200;

/**
 * Bytes of item payload one page may carry.
 *
 * The turn budget alone is not a size bound: a single agentic turn can hold
 * tens of thousands of items. This is the same order of magnitude as the
 * client-side history budget, so a read-through cannot outgrow the page it is
 * filling.
 */
export const NATIVE_TIMELINE_ITEM_BYTE_BUDGET = 1_048_576;

export class NativeTimelineError extends Schema.TaggedError<NativeTimelineError>()(
  "NativeTimelineError",
  {
    driver: ProviderDriverKind,
    operation: Schema.Literals(["list-turns", "list-items"]),
    nativeThreadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Native timeline ${this.operation} failed for ${this.nativeThreadId}: ${this.detail}`;
  }
}

/**
 * Turns arrive newest-first but a timeline reads oldest-first, and item ordinals
 * must be contiguous across the whole page for the client paging cursor to make
 * sense.
 */
export function chronological(
  turns: ReadonlyArray<NativeTimelineTurn>,
): ReadonlyArray<NativeTimelineTurn> {
  return [...turns].reverse();
}
