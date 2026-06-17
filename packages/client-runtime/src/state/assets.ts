import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

const ASSET_URL_REFRESH_INTERVAL_MS = 30 * 60_000;
const ASSET_URL_STALE_TIME_MS = 5 * 60_000;
const ASSET_URL_IDLE_TTL_MS = 60 * 60_000;

export function resolveAssetUrl(httpBaseUrl: string, relativeUrl: string): string | null {
  try {
    return new URL(relativeUrl, httpBaseUrl).toString();
  } catch {
    return null;
  }
}

export function createAssetEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    createUrl: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:assets:create-url",
      tag: WS_METHODS.assetsCreateUrl,
      staleTimeMs: ASSET_URL_STALE_TIME_MS,
      idleTtlMs: ASSET_URL_IDLE_TTL_MS,
      refreshIntervalMs: ASSET_URL_REFRESH_INTERVAL_MS,
    }),
  };
}
