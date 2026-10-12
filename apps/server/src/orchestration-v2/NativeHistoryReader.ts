import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as NativeTimeline from "./NativeTimeline.ts";
import * as CodexExternalThreads from "./Adapters/CodexExternalThreads.ts";
import { ProviderDriverKind, CodexSettings } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as ServerSettings from "../serverSettings.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import { HostProcessEnvironment } from "@t3tools/shared/hostProcess";
import { CodexAppServerClientFactory } from "./Adapters/CodexAdapterV2.ts";

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
  extends Omit<CodexExternalThreads.CodexExternalThreadsOptions, "instanceId" | "settings"> {
  readonly serverSettings: ServerSettings.ServerSettingsService["Service"];
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
    // Only recently viewed native histories are cached; no eager transcript copies.
    // Expiration lets an external CLI's new turns become visible on reopen.
    const cache = new Map<string, { at: number; turns: ReadonlyArray<NativeTimeline.NativeTimelineTurn>; truncated: boolean }>();
    const readThrough: NativeHistoryReader["Service"]["readThrough"] = (snapshot) =>
      Effect.orElseSucceed(
        Effect.gen(function* () {
          if (snapshot.projection.turnItems.length > 0) return snapshot;
          const providerThread = NativeTimeline.adoptedProviderThread(
            snapshot.projection.providerThreads,
          );
          if (providerThread === undefined) return snapshot;
          if (providerThread.driver !== "codex") return snapshot;
          const nativeId = providerThread.nativeThreadRef?.nativeId ?? undefined;
          if (nativeId === undefined) return snapshot;

          const configured = yield* options.serverSettings.getSettings;
          const config = deriveProviderInstanceConfigMap(configured)[providerThread.providerInstanceId];
          const settings = Schema.decodeUnknownSync(CodexSettings)(config?.config ?? {});
          const environment = { ...options.environment };
          for (const entry of config?.environment ?? []) {
            if (entry.value) environment[entry.name] = entry.value;
          }
          const key = `${providerThread.providerInstanceId}:${nativeId}:${settings.homePath ?? ""}:${settings.binaryPath ?? ""}`;
          const nowMs = Date.now();
          const cached = cache.get(key);
          const canUseCache = cached !== undefined && nowMs - cached.at < 45_000;
          let turns: ReadonlyArray<NativeTimeline.NativeTimelineTurn>;
          if (canUseCache && cached !== undefined) {
            turns = cached.turns;
            // Preserve LRU order.
            cache.delete(key);
            cache.set(key, cached);
          } else {
            const page = yield* Effect.exit(
              Effect.scoped(
                CodexExternalThreads.readNativeTimeline(
                  { clientFactory: options.clientFactory, settings, environment, instanceId: providerThread.providerInstanceId },
                  { nativeThreadId: nativeId, cursor: undefined },
                ),
              ),
            );
            if (Exit.isFailure(page)) {
              yield* Effect.logWarning("native timeline read-through failed", {
                threadId: snapshot.projection.thread.id,
              });
              return snapshot;
            }
            turns = page.value.turns;
            const truncated = page.value.nextCursor !== null;
            if (truncated) {
              yield* Effect.logWarning("native timeline exceeds 200-turn window", {
                threadId: snapshot.projection.thread.id,
              });
            }
            if (JSON.stringify(turns).length < 2_000_000) {
              cache.delete(key);
              cache.set(key, { at: nowMs, turns, truncated });
              while (cache.size > 8) cache.delete(cache.keys().next().value!);
            }
          }
          return NativeTimeline.mergeNativeTimeline({
            snapshot,
            providerThread,
            driver: CODEX_DRIVER,
            providerInstanceId: providerThread.providerInstanceId,
            turns,
            readAt: yield* DateTime.now,
          });
        }),
        () => snapshot,
      );

    return NativeHistoryReader.of({ readThrough });
  });

export const layer = Layer.effect(
  NativeHistoryReader,
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const environment = yield* HostProcessEnvironment;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    return yield* make({ clientFactory, environment, serverSettings });
  }),
);

export const layerNoop: Layer.Layer<NativeHistoryReader> = Layer.succeed(
  NativeHistoryReader,
  NativeHistoryReader.of({ readThrough: (snapshot) => Effect.succeed(snapshot) }),
);
