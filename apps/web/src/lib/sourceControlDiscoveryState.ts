import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM,
  EMPTY_SOURCE_CONTROL_DISCOVERY_STATE,
  type SourceControlDiscoveryState,
  createSourceControlDiscoveryManager,
  getSourceControlDiscoveryTargetKey,
  sourceControlDiscoveryStateAtom,
} from "@t3tools/client-runtime";
import type { SourceControlDiscoveryResult } from "@t3tools/contracts";
import { useEffect } from "react";

import { readLocalApi } from "../localApi";
import { appAtomRegistry } from "../rpc/atomRegistry";

const SOURCE_CONTROL_DISCOVERY_TARGET = { key: "primary" } as const;

export const sourceControlDiscoveryManager = createSourceControlDiscoveryManager({
  getRegistry: () => appAtomRegistry,
  getClient: () => readLocalApi()?.server ?? null,
});

export function refreshSourceControlDiscovery(): Promise<SourceControlDiscoveryResult | null> {
  return sourceControlDiscoveryManager.refresh(SOURCE_CONTROL_DISCOVERY_TARGET);
}

export function resetSourceControlDiscoveryStateForTests(): void {
  sourceControlDiscoveryManager.reset();
}

export function useSourceControlDiscovery(): SourceControlDiscoveryState {
  const targetKey = getSourceControlDiscoveryTargetKey(SOURCE_CONTROL_DISCOVERY_TARGET);

  useEffect(() => {
    void sourceControlDiscoveryManager.refresh(SOURCE_CONTROL_DISCOVERY_TARGET);
  }, []);

  const state = useAtomValue(
    targetKey !== null
      ? sourceControlDiscoveryStateAtom(targetKey)
      : EMPTY_SOURCE_CONTROL_DISCOVERY_ATOM,
  );
  return targetKey === null ? EMPTY_SOURCE_CONTROL_DISCOVERY_STATE : state;
}
