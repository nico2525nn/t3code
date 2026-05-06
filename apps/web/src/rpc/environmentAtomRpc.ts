import { createT3RpcAtomRuntime, type T3RpcAtomRuntime } from "@t3tools/client-runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  createWsRpcProtocolLayer,
  type WsProtocolLifecycleHandlers,
  type WsRpcProtocolSocketUrlProvider,
} from "./protocol";

export type EnvironmentAtomRpcClient = T3RpcAtomRuntime;

export interface EnvironmentAtomRpcClientInput {
  readonly environmentId: EnvironmentId;
  readonly url: WsRpcProtocolSocketUrlProvider;
  readonly lifecycleHandlers?: WsProtocolLifecycleHandlers;
}

export function createEnvironmentAtomRpcClient(
  input: EnvironmentAtomRpcClientInput,
): EnvironmentAtomRpcClient {
  return createT3RpcAtomRuntime({
    environmentId: input.environmentId,
    protocol: createWsRpcProtocolLayer(input.url, input.lifecycleHandlers),
    spanPrefix: `EnvironmentRpc:${input.environmentId}`,
  });
}
