/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import { Effect, Equal, FileSystem, Layer, Path, PubSub, Ref, Stream } from "effect";

import { ClaudeProviderLive } from "./ClaudeProvider";
import { CodexProviderLive } from "./CodexProvider";
import { CursorProviderLive } from "./CursorProvider";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider";
import { ClaudeProvider } from "../Services/ClaudeProvider";
import type { CodexProviderShape } from "../Services/CodexProvider";
import { CodexProvider } from "../Services/CodexProvider";
import type { CursorProviderShape } from "../Services/CursorProvider";
import { CursorProvider } from "../Services/CursorProvider";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry";

const loadProviders = (
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
  cursorProvider: CursorProviderShape,
): Effect.Effect<readonly [ServerProvider, ServerProvider, ServerProvider]> =>
  Effect.all([codexProvider.getSnapshot, claudeProvider.getSnapshot, cursorProvider.getSnapshot], {
    concurrency: "unbounded",
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.reasoningEffortLevels.length ?? 0) > 0 ||
  model.capabilities?.supportsFastMode === true ||
  model.capabilities?.supportsThinkingToggle === true ||
  (model.capabilities?.contextWindowOptions.length ?? 0) > 0 ||
  (model.capabilities?.promptInjectedEffortLevels.length ?? 0) > 0;

const mergeProviderModels = (
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  if (nextModels.length === 0 && previousModels.length > 0) {
    return previousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return [...mergedModels, ...previousModels.filter((model) => !nextSlugs.has(model.slug))];
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider =>
  !previousProvider
    ? nextProvider
    : {
        ...nextProvider,
        models: mergeProviderModels(previousProvider.models, nextProvider.models),
      };

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const ProviderRegistryLiveBase = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const cursorProvider = yield* CursorProvider;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      yield* loadProviders(codexProvider, claudeProvider, cursorProvider),
    );

    const syncProviders = (options?: { readonly publish?: boolean }) =>
      Effect.gen(function* () {
        const previousProviders = yield* Ref.get(providersRef);
        const providers = yield* loadProviders(codexProvider, claudeProvider, cursorProvider);
        yield* Ref.set(providersRef, providers);

    const persistProvider = (provider: ServerProvider) =>
      writeProviderStatusCache({
        filePath: cachePathByProvider.get(provider.provider)!,
        provider,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tapError(Effect.logError),
        Effect.ignore,
      );

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const [previousProviders, providers] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [provider.provider, provider] as const),
          );

          for (const provider of nextProviders) {
            mergedProviders.set(
              provider.provider,
              mergeProviderSnapshot(mergedProviders.get(provider.provider), provider),
            );
          }

          const providers = orderProviderSnapshots([...mergedProviders.values()]);
          return [[previousProviders, providers] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        yield* Effect.forEach(nextProviders, persistProvider, {
          concurrency: "unbounded",
          discard: true,
        });
        if (options?.publish !== false) {
          yield* PubSub.publish(changesPubSub, providers);
        }
      }

      return providers;
    });

    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      return yield* upsertProviders([provider], options);
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      if (provider) {
        const providerSource = providerSources.find((candidate) => candidate.provider === provider);
        if (!providerSource) {
          return yield* Ref.get(providersRef);
        }
        return yield* providerSource.refresh.pipe(
          Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
        );
      }

      return yield* Effect.forEach(
        providerSources,
        (providerSource) => providerSource.refresh.pipe(Effect.flatMap(syncProvider)),
        {
          concurrency: "unbounded",
          discard: true,
        },
      ).pipe(Effect.andThen(Ref.get(providersRef)));
    });

    yield* Effect.forEach(
      providerSources,
      (providerSource) =>
        Stream.runForEach(providerSource.streamChanges, (provider) => syncProvider(provider)).pipe(
          Effect.forkScoped,
        ),
      {
        concurrency: "unbounded",
        discard: true,
      },
    );
    yield* loadProviders(providerSources).pipe(
      Effect.flatMap((providers) => upsertProviders(providers, { publish: false })),
    );
    yield* Stream.runForEach(cursorProvider.streamChanges, () => syncProviders()).pipe(
      Effect.forkScoped,
    );

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderKind) =>
        Effect.gen(function* () {
          switch (provider) {
            case "codex":
              yield* codexProvider.refresh;
              break;
            case "claudeAgent":
              yield* claudeProvider.refresh;
              break;
            case "cursor":
              yield* cursorProvider.refresh;
              break;
            default:
              yield* Effect.all(
                [codexProvider.refresh, claudeProvider.refresh, cursorProvider.refresh],
                { concurrency: "unbounded" },
              );
              break;
          }
          return yield* syncProviders();
        }).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProvider>),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(CursorProviderLive),
);
