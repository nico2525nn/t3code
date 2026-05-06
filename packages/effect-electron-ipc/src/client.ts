import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";

import {
  EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY,
  type EffectElectronIpcMainFrame,
  type EffectElectronIpcRendererBridge,
  type EffectElectronIpcRendererPort,
} from "./ipc.ts";

export interface EffectElectronIpcBrowserGlobal {
  readonly [EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY]?: EffectElectronIpcRendererBridge;
}

export function getEffectElectronIpcRendererBridge(
  globalObject: EffectElectronIpcBrowserGlobal = globalThis as EffectElectronIpcBrowserGlobal,
): EffectElectronIpcRendererBridge {
  const bridge = globalObject[EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY];
  if (!bridge) {
    throw new Error(`Missing preload bridge: window.${EFFECT_ELECTRON_IPC_RENDERER_BRIDGE_KEY}`);
  }
  return bridge;
}

export const makeEffectElectronIpcRendererPort = (
  bridge: EffectElectronIpcRendererBridge,
): EffectElectronIpcRendererPort => bridge;

export const makeEffectElectronIpcRendererProtocol = (
  port: EffectElectronIpcRendererPort,
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.Protocol.make((writeResponse) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const responses = yield* Queue.make<EffectElectronIpcMainFrame>();
      const unsubscribe = port.subscribe((frame) => {
        Queue.offerUnsafe(responses, frame);
      });

      yield* Queue.take(responses).pipe(
        Effect.flatMap((frame) => writeResponse(frame.rendererClientId, frame.message)),
        Effect.forever,
        Effect.forkScoped,
      );

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(unsubscribe).pipe(Effect.andThen(Queue.shutdown(responses))),
      );

      return {
        send: (rendererClientId, message) =>
          Effect.sync(() => {
            port.send({
              version: 1,
              rendererClientId,
              message,
            });
          }),
        supportsAck: true,
        supportsTransferables: false,
      };
    }),
  );

export const layerEffectElectronIpcRendererProtocol = (port: EffectElectronIpcRendererPort) =>
  Layer.effect(RpcClient.Protocol, makeEffectElectronIpcRendererProtocol(port));
