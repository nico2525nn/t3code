import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as NativeTimeline from "./NativeTimeline.ts";
import * as CodexExternalThreads from "./Adapters/CodexExternalThreads.ts";
import { ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";

const CODEX_DRIVER = ProviderDriverKind.make("codex");

/**
 * Overlay provider-owned history onto a snapshot that does not yet have it.
 *
 * The catalog stores no transcript, so the first reader asks the provider for
 * one and the result is projected into the same rows a local run would have
 * produced. Later reads find local rows and skip the provider entirely, so
 * this costs one provider read per adopted thread. A provider that cannot be
 * reached never makes the thread unreadable: the shell and anything local are
 * still returned.
 */
export interface NativeHistoryReaderOptions
  extends CodexExternalThreads.CodexExternalThreadsOptions {
  readonly instanceId: ProviderInstanceId;
}

export class NativeHistoryReader extends Context.Service<
  NativeHistoryReader,
  {
    readonly readThrough: (
      snapshot: NativeTimeline.NativeTimelineSnapshot,
    ) => Effect.Effect<NativeTimeline.NativeTimelineSnapshot, never>;
  }
>()("t3/orchestration-v2/NativeHistoryReader") {}

export const make = (options: NativeHistoryReaderOptions) =>
  Effect.gen(function* () {
    const external: CodexExternalThreads.CodexExternalThreadsOptions = {
      clientFactory: options.clientFactory,
      settings: options.settings,
      environment: options.environment,
    };

    const readThrough: NativeHistoryReader["Service"]["readThrough"] = (snapshot) =>
      Effect.orElseSucceed(
        Effect.gen(function* () {
          if (snapshot.projection.turnItems.length > 0) return snapshot;
          const providerThread = NativeTimeline.adoptedProviderThread(
            snapshot.projection.providerThreads,
          );
          if (providerThread === undefined) return snapshot;
          if (providerThread.providerInstanceId !== options.instanceId) return snapshot;
          if (providerThread.driver !== "codex") return snapshot;
          const nativeId = providerThread.nativeThreadRef?.nativeId ?? undefined;
          if (nativeId === undefined) return snapshot;

          const page = yield* Effect.exit(
            Effect.scoped(
              CodexExternalThreads.readNativeTimeline(external, {
                nativeThreadId: nativeId,
                cursor: undefined,
              }),
            ),
          );
          if (Exit.isFailure(page)) {
            yield* Effect.logWarning("native timeline read-through failed", {
              threadId: snapshot.projection.thread.id,
            });
            return snapshot;
          }
          return NativeTimeline.mergeNativeTimeline({
            snapshot,
            providerThread,
            driver: CODEX_DRIVER,
            providerInstanceId: providerThread.providerInstanceId,
            turns: page.value.turns,
            readAt: yield* DateTime.now,
          });
        }),
        () => snapshot,
      );

    return NativeHistoryReader.of({ readThrough });
  });

export const layer = (options: NativeHistoryReaderOptions) =>
  Layer.effect(NativeHistoryReader, make(options));

export const layerNoop: Layer.Layer<NativeHistoryReader> = Layer.succeed(
  NativeHistoryReader,
  NativeHistoryReader.of({ readThrough: (snapshot) => Effect.succeed(snapshot) }),
);
