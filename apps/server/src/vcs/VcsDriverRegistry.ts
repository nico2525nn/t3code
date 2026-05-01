import { Context, Effect, Layer } from "effect";

import type { VcsDriverKind, VcsError, VcsRepositoryIdentity } from "@t3tools/contracts";
import { VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as GitVcsDriver from "./GitVcsDriver.ts";
import type { VcsDriverShape } from "./VcsDriver.ts";

export interface VcsDriverResolveInput {
  readonly cwd: string;
  readonly requestedKind?: VcsDriverKind | "auto";
}

export interface VcsDriverHandle {
  readonly kind: VcsDriverKind;
  readonly repository: VcsRepositoryIdentity;
  readonly driver: VcsDriverShape;
}

export interface VcsDriverRegistryShape {
  readonly detect: (
    input: VcsDriverResolveInput,
  ) => Effect.Effect<VcsDriverHandle | null, VcsError>;
  readonly resolve: (input: VcsDriverResolveInput) => Effect.Effect<VcsDriverHandle, VcsError>;
}

export class VcsDriverRegistry extends Context.Service<VcsDriverRegistry, VcsDriverRegistryShape>()(
  "t3/vcs/VcsDriverRegistry",
) {}

const unsupported = (operation: string, kind: VcsDriverKind, detail: string) =>
  new VcsUnsupportedOperationError({
    operation,
    kind,
    detail,
  });

export const make = Effect.fn("makeVcsDriverRegistry")(function* () {
  const git = yield* GitVcsDriver.makeVcsDriverShape();
  const drivers: Partial<Record<VcsDriverKind, VcsDriverShape>> = {
    git,
  };

  const detectWithDriver = Effect.fn("VcsDriverRegistry.detectWithDriver")(function* (
    kind: VcsDriverKind,
    driver: VcsDriverShape,
    cwd: string,
  ) {
    const repository = yield* driver.detectRepository(cwd);
    if (!repository) {
      return null;
    }
    return {
      kind,
      repository,
      driver,
    } satisfies VcsDriverHandle;
  });

  const detect: VcsDriverRegistryShape["detect"] = Effect.fn("VcsDriverRegistry.detect")(
    function* (input) {
      const requestedKind = input.requestedKind ?? "auto";

      if (requestedKind !== "auto" && requestedKind !== "unknown") {
        const driver = drivers[requestedKind];
        if (!driver) {
          return yield* unsupported(
            "VcsDriverRegistry.detect",
            requestedKind,
            `No ${requestedKind} VCS driver is registered.`,
          );
        }
        return yield* detectWithDriver(requestedKind, driver, input.cwd);
      }

      return yield* detectWithDriver("git", git, input.cwd);
    },
  );

  const resolve: VcsDriverRegistryShape["resolve"] = Effect.fn("VcsDriverRegistry.resolve")(
    function* (input) {
      const detected = yield* detect(input);
      if (detected) {
        return detected;
      }

      const requestedKind = input.requestedKind ?? "auto";
      return yield* unsupported(
        "VcsDriverRegistry.resolve",
        requestedKind === "auto" ? "unknown" : requestedKind,
        requestedKind === "auto"
          ? `No supported VCS repository was detected at ${input.cwd}.`
          : `No ${requestedKind} repository was detected at ${input.cwd}.`,
      );
    },
  );

  return VcsDriverRegistry.of({
    detect,
    resolve,
  });
});

export const layer = Layer.effect(VcsDriverRegistry, make());
