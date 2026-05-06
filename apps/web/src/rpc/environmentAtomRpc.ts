import { WsRpcGroup, type EnvironmentId } from "@t3tools/contracts";
import { Layer } from "effect";
import { Atom, AtomRegistry, AtomRpc } from "effect/unstable/reactivity";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import {
  createWsRpcProtocolLayer,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol";
import { createServerAtomRpc, type ServerAtomRpc } from "./serverAtomRpc";

type WsRpcGroupRpcs =
  typeof WsRpcGroup extends RpcGroup.RpcGroup<infer Rpcs extends Rpc.Any> ? Rpcs : never;

export interface WsAtomRpcService extends AtomRpc.AtomRpcClient<
  WsAtomRpcService,
  string,
  WsRpcGroupRpcs
> {}

export interface EnvironmentAtomRpcClient {
  readonly environmentId: EnvironmentId;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly service: WsAtomRpcService;
  readonly server: ServerAtomRpc;
  readonly reset: () => void;
  readonly dispose: () => void;
}

export interface EnvironmentAtomRpcClientInput {
  readonly environmentId: EnvironmentId;
  readonly url: WsRpcProtocolSocketUrlProvider;
  readonly lifecycleHandlers?: WsProtocolLifecycleHandlers;
}

export function createEnvironmentAtomRpcClient(
  input: EnvironmentAtomRpcClientInput,
): EnvironmentAtomRpcClient {
  const registry = AtomRegistry.make();
  const runtime = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() });
  const service = AtomRpc.Service<WsAtomRpcService>()(
    `t3tools/web/environment-rpc/${input.environmentId}`,
    {
      group: WsRpcGroup,
      protocol: createWsRpcProtocolLayer(input.url, input.lifecycleHandlers),
      runtime,
      spanPrefix: `EnvironmentRpc:${input.environmentId}`,
    },
  );

  return {
    environmentId: input.environmentId,
    registry,
    service,
    server: createServerAtomRpc({ registry, service }),
    reset: () => {
      registry.reset();
    },
    dispose: () => {
      registry.dispose();
    },
  };
}
