import {
  type SourceControlDiscoveryClient,
  type SourceControlDiscoveryTarget,
  createSourceControlDiscoveryManager,
} from "@t3tools/client-runtime";
import type { EnvironmentId, SourceControlDiscoveryResult } from "@t3tools/contracts";

import { appAtomRegistry } from "./atom-registry";
import { getEnvironmentClient } from "./environment-session-registry";

export const sourceControlDiscoveryManager = createSourceControlDiscoveryManager<EnvironmentId>({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => getEnvironmentClient(environmentId)?.server ?? null,
});

export function sourceControlDiscoveryTargetForEnvironment(
  environmentId: EnvironmentId | null,
): SourceControlDiscoveryTarget<EnvironmentId> {
  return { key: environmentId ?? null };
}

export function refreshSourceControlDiscoveryForEnvironment(
  environmentId: EnvironmentId | null,
  client?: SourceControlDiscoveryClient | null,
): Promise<SourceControlDiscoveryResult | null> {
  return sourceControlDiscoveryManager.refresh(
    sourceControlDiscoveryTargetForEnvironment(environmentId),
    client ?? undefined,
  );
}

export function invalidateSourceControlDiscoveryForEnvironment(
  environmentId: EnvironmentId | null,
): void {
  sourceControlDiscoveryManager.invalidate(
    sourceControlDiscoveryTargetForEnvironment(environmentId),
  );
}

export function resetSourceControlDiscoveryState(): void {
  sourceControlDiscoveryManager.reset();
}

export function resetSourceControlDiscoveryStateForTests(): void {
  resetSourceControlDiscoveryState();
}
