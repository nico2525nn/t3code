import { WS_METHODS, type ServerSettingsPatch } from "@t3tools/contracts";

import type { T3RpcAtomRuntime } from "./rpcAtomRuntime.ts";

export const SERVER_CONFIG_REACTIVITY_KEY = ["server", "config"] as const;
export const SERVER_SETTINGS_REACTIVITY_KEY = ["server", "settings"] as const;

export function serverConfigAtom(runtime: Pick<T3RpcAtomRuntime, "query">) {
  return runtime.query(
    WS_METHODS.serverGetConfig,
    {},
    {
      reactivityKeys: SERVER_CONFIG_REACTIVITY_KEY,
      serializationKey: "server.getConfig",
      timeToLive: Infinity,
    },
  );
}

export function serverSettingsAtom(runtime: Pick<T3RpcAtomRuntime, "query">) {
  return runtime.query(
    WS_METHODS.serverGetSettings,
    {},
    {
      reactivityKeys: SERVER_SETTINGS_REACTIVITY_KEY,
      serializationKey: "server.getSettings",
      timeToLive: Infinity,
    },
  );
}

export function updateServerSettingsMutation(runtime: Pick<T3RpcAtomRuntime, "mutation">) {
  return runtime.mutation(WS_METHODS.serverUpdateSettings);
}

export function updateServerSettingsArg(patch: ServerSettingsPatch) {
  return {
    payload: { patch },
    reactivityKeys: {
      config: SERVER_CONFIG_REACTIVITY_KEY,
      settings: SERVER_SETTINGS_REACTIVITY_KEY,
    },
  } as const;
}
