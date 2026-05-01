import { Context, Effect, Layer } from "effect";
import type { SourceControlProviderError } from "@t3tools/contracts";

import { SourceControlProvider, type SourceControlProviderShape } from "./SourceControlProvider.ts";
import * as GitHubSourceControlProvider from "./GitHubSourceControlProvider.ts";

export interface SourceControlProviderRegistryShape {
  readonly resolve: (input: {
    readonly cwd: string;
  }) => Effect.Effect<SourceControlProviderShape, SourceControlProviderError>;
}

export class SourceControlProviderRegistry extends Context.Service<
  SourceControlProviderRegistry,
  SourceControlProviderRegistryShape
>()("t3/source-control/SourceControlProviderRegistry") {}

export const make = Effect.fn("makeSourceControlProviderRegistry")(function* () {
  const github = yield* SourceControlProvider;

  return SourceControlProviderRegistry.of({
    resolve: () => Effect.succeed(github),
  });
});

export const layer = Layer.effect(SourceControlProviderRegistry, make()).pipe(
  Layer.provide(GitHubSourceControlProvider.layer),
);
