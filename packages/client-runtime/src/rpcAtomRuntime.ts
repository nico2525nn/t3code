import { WsRpcGroup, type EnvironmentId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { Atom, AtomRegistry, AtomRpc } from "effect/unstable/reactivity";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import type * as RpcClient from "effect/unstable/rpc/RpcClient";
import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";

type WsRpcGroupRpcs =
  typeof WsRpcGroup extends RpcGroup.RpcGroup<infer Rpcs extends Rpc.Any> ? Rpcs : never;

export interface T3RpcAtomService extends AtomRpc.AtomRpcClient<
  T3RpcAtomService,
  string,
  WsRpcGroupRpcs
> {}

export type T3RpcAtomProtocol = Layer.Layer<RpcClient.Protocol, never, never>;

export interface T3RpcAtomRuntime {
  readonly environmentId: EnvironmentId;
  readonly registry: AtomRegistry.AtomRegistry;
  readonly rpc: T3RpcAtomService;
  readonly query: T3RpcAtomService["query"];
  readonly mutation: T3RpcAtomService["mutation"];
  readonly getResult: <A, E>(
    atom: Atom.Atom<import("effect/unstable/reactivity").AsyncResult.AsyncResult<A, E>>,
    options?: {
      readonly suspendOnWaiting?: boolean;
    },
  ) => Effect.Effect<A, E>;
  readonly runMutation: <Arg, A, E>(
    atom: Atom.AtomResultFn<Arg, A, E>,
    arg: Arg,
    options?: {
      readonly suspendOnWaiting?: boolean;
    },
  ) => Effect.Effect<A, E>;
  readonly reset: () => void;
  readonly dispose: () => void;
}

export interface T3RpcAtomRuntimeInput {
  readonly environmentId: EnvironmentId;
  readonly protocol: T3RpcAtomProtocol;
  readonly spanPrefix?: string;
}

export function createT3RpcAtomRuntime(input: T3RpcAtomRuntimeInput): T3RpcAtomRuntime {
  const registry = AtomRegistry.make();
  const runtime = Atom.context({ memoMap: Layer.makeMemoMapUnsafe() });
  const rpc = AtomRpc.Service<T3RpcAtomService>()(
    `t3tools/runtime/environment-rpc/${input.environmentId}`,
    {
      group: WsRpcGroup,
      protocol: input.protocol,
      runtime,
      spanPrefix: input.spanPrefix ?? `EnvironmentRpc:${input.environmentId}`,
    },
  );

  return {
    environmentId: input.environmentId,
    registry,
    rpc,
    query: rpc.query,
    mutation: rpc.mutation,
    getResult: (atom, options) => AtomRegistry.getResult(registry, atom, options),
    runMutation: (atom, arg, options) =>
      Effect.gen(function* () {
        yield* Effect.sync(() => {
          registry.set(atom, arg);
        });

        return yield* AtomRegistry.getResult(registry, atom, options);
      }),
    reset: () => {
      registry.reset();
    },
    dispose: () => {
      registry.dispose();
    },
  };
}
