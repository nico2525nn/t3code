import { type ProviderDriverKind } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as NativeTimeline from "./NativeTimeline.ts";
import * as NativeTimelineReadThrough from "./NativeTimelineReadThrough.ts";
import * as ProviderAdapter from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";

import type { NativeTimelineSnapshot as NativeTimelineSnapshotReader } from "./NativeTimelineReadThrough.ts";

export type { NativeTimelineSnapshotReader };

/**
 * Overlay provider-owned history onto a snapshot that does not yet have it.
 *
 * This is the read-through half of adopting a conversation: the catalog stores
 * no transcript, so the first reader asks for one and the result is projected
 * into the same rows a local run would have produced.
 */
export class NativeTimelineReader extends Context.Service<
  NativeTimelineReader,
  {
    readonly readThrough: (
      snapshot: NativeTimelineSnapshotReader,
    ) => Effect.Effect<NativeTimelineSnapshotReader, never>;
  }
>()("t3/orchestration-v2/NativeTimelineReader") {}

export const make = Effect.gen(function* () {
  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;

  const readThrough: NativeTimelineReader["Service"]["readThrough"] = (snapshot) =>
    Effect.gen(function* () {
      const providerThread = NativeTimelineReadThrough.adoptedProviderThread(
        snapshot.projection.providerThreads,
      );
      // A thread T3 created itself, or one T3 has already run on, is not read
      // through: its history is already local, and a second copy would double
      // the transcript.
      if (providerThread === undefined || snapshot.projection.turnItems.length > 0) {
        return snapshot;
      }
      const nativeId = providerThread.nativeThreadRef?.nativeId ?? undefined;
      if (nativeId === undefined) return snapshot;

      const adapter = yield* registry.get(providerThread.providerInstanceId).pipe(Effect.option);
      if (Option.isNone(adapter) || adapter.value.withNativeTimeline === undefined) {
        return snapshot;
      }

      const nativeDriver = providerThread.driver as ProviderDriverKind;
      const page = yield* Effect.result(
        adapter.value.withNativeTimeline((read) =>
          read({ nativeThreadId: nativeId, cursor: undefined }),
        ),
      );

      // A provider that cannot be reached must not make the thread unreadable:
      // the shell and anything T3 already recorded are still returned.
      if (Result.isFailure(page)) {
        yield* Effect.logWarning("native timeline read-through failed", {
          threadId: snapshot.projection.thread.id,
          cause: page.failure,
        });
        return snapshot;
      }

      return NativeTimelineReadThrough.mergeNativeTimeline({
        snapshot,
        providerThread,
        driver: nativeDriver,
        providerInstanceId: providerThread.providerInstanceId,
        turns: page.success.turns,
        readAt: yield* DateTime.now,
      });
    });

  return NativeTimelineReader.of({ readThrough });
});

export const layer = Layer.effect(NativeTimelineReader, make);

/** Re-exported so callers need only one import for the read path. */
export const NATIVE_TIMELINE_ITEM_BYTE_BUDGET = NativeTimeline.NATIVE_TIMELINE_ITEM_BYTE_BUDGET;
