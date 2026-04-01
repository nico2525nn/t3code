import { WsRpcGroup } from "@t3tools/contracts";
import { Layer } from "effect";
import { AtomRpc } from "effect/unstable/reactivity";

import { createWsRpcProtocolLayer } from "./protocol";

import { Atom } from "effect/unstable/reactivity";
import { Duration } from "effect";

export const REACTIVITY_KEYS = {
  git: (cwd: string) => `git:${cwd}` as const,
  project: (cwd: string) => `project:${cwd}` as const,
} as const;

export const refreshIntervalSignalAtom = Atom.family((interval: Duration.Duration) =>
  Atom.readable((get) => {
    let count = 0;
    const intervalId = window.setInterval(() => {
      get.setSelf(++count);
    }, Duration.toMillis(interval));
    get.addFinalizer(() => {
      window.clearInterval(intervalId);
    });
    return count;
  }),
);

export class WsRpcAtomClient extends AtomRpc.Service<WsRpcAtomClient>()("WsRpcAtomClient", {
  group: WsRpcGroup,
  protocol: Layer.suspend(() => createWsRpcProtocolLayer()),
}) {}
