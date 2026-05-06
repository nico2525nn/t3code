import {
  WS_METHODS,
  type ServerConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { AtomRegistry } from "effect/unstable/reactivity";

import type { WsAtomRpcService } from "./environmentAtomRpc";

const SERVER_CONFIG_REACTIVITY_KEY = ["server", "config"] as const;
const SERVER_SETTINGS_REACTIVITY_KEY = ["server", "settings"] as const;

export interface ServerAtomRpcInput {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly service: WsAtomRpcService;
}

export interface ServerAtomRpc {
  readonly atoms: {
    readonly config: ReturnType<WsAtomRpcService["query"]>;
    readonly settings: ReturnType<WsAtomRpcService["query"]>;
  };
  readonly mutations: {
    readonly updateSettings: ReturnType<WsAtomRpcService["mutation"]>;
  };
  readonly getConfig: Effect.Effect<ServerConfig, ServerAtomRpcError>;
  readonly getSettings: Effect.Effect<ServerSettings, ServerAtomRpcError>;
  readonly updateSettings: (
    patch: ServerSettingsPatch,
  ) => Effect.Effect<ServerSettings, ServerAtomRpcError>;
}

export type ServerAtomRpcError =
  | AtomFailure<typeof WS_METHODS.serverGetConfig>
  | AtomFailure<typeof WS_METHODS.serverGetSettings>
  | MutationFailure<typeof WS_METHODS.serverUpdateSettings>;

type QueryAtom<_Tag extends Parameters<WsAtomRpcService["query"]>[0]> = ReturnType<
  WsAtomRpcService["query"]
>;

type MutationAtom<_Tag extends Parameters<WsAtomRpcService["mutation"]>[0]> = ReturnType<
  WsAtomRpcService["mutation"]
>;

type AtomFailure<Tag extends Parameters<WsAtomRpcService["query"]>[0]> =
  QueryAtom<Tag> extends import("effect/unstable/reactivity").Atom.Atom<
    import("effect/unstable/reactivity").AsyncResult.AsyncResult<unknown, infer E>
  >
    ? E
    : never;

type MutationFailure<Tag extends Parameters<WsAtomRpcService["mutation"]>[0]> =
  MutationAtom<Tag> extends import("effect/unstable/reactivity").Atom.AtomResultFn<
    unknown,
    unknown,
    infer E
  >
    ? E
    : never;

export function createServerAtomRpc(input: ServerAtomRpcInput): ServerAtomRpc {
  const config = input.service.query(
    WS_METHODS.serverGetConfig,
    {},
    {
      reactivityKeys: SERVER_CONFIG_REACTIVITY_KEY,
      serializationKey: "server.getConfig",
      timeToLive: Infinity,
    },
  );
  const settings = input.service.query(
    WS_METHODS.serverGetSettings,
    {},
    {
      reactivityKeys: SERVER_SETTINGS_REACTIVITY_KEY,
      serializationKey: "server.getSettings",
      timeToLive: Infinity,
    },
  );
  const updateSettings = input.service.mutation(WS_METHODS.serverUpdateSettings);

  return {
    atoms: {
      config,
      settings,
    },
    mutations: {
      updateSettings,
    },
    getConfig: AtomRegistry.getResult(input.registry, config, { suspendOnWaiting: true }),
    getSettings: AtomRegistry.getResult(input.registry, settings, { suspendOnWaiting: true }),
    updateSettings: (patch) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          input.registry.set(updateSettings, {
            payload: { patch },
            reactivityKeys: {
              config: SERVER_CONFIG_REACTIVITY_KEY,
              settings: SERVER_SETTINGS_REACTIVITY_KEY,
            },
          });
        });

        return yield* AtomRegistry.getResult(input.registry, updateSettings, {
          suspendOnWaiting: true,
        });
      }),
  };
}
