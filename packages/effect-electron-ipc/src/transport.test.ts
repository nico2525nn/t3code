import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as RpcServer from "effect/unstable/rpc/RpcServer";
import { describe, expect, it } from "vitest";

import type {
  EffectElectronIpcMainFrame,
  EffectElectronIpcMainSource,
  EffectElectronIpcRendererFrame,
} from "./ipc.ts";
import {
  makeEffectElectronIpcRendererPort,
  makeEffectElectronIpcRendererProtocol,
} from "./client.ts";
import { makeEffectElectronIpcMainProtocol } from "./main.ts";

const TEST_METHODS = {
  echo: "effect-electron-ipc.test.echo",
} as const;

const EchoInput = Schema.Struct({
  text: Schema.String,
});

const EchoResult = Schema.Struct({
  text: Schema.String,
});

const EchoRpc = Rpc.make(TEST_METHODS.echo, {
  payload: EchoInput,
  success: EchoResult,
});

const TestRpcGroup = RpcGroup.make(EchoRpc);
const makeTestClient = RpcClient.make(TestRpcGroup);

const TestHandlersLive = TestRpcGroup.toLayer(
  TestRpcGroup.of({
    [TEST_METHODS.echo]: (input) =>
      Effect.succeed({
        text: input.text,
      }),
  }),
);

describe("Effect Electron RPC transport", () => {
  it("round-trips an Effect RPC through renderer and main ports", async () => {
    const transport = new InMemoryEffectElectronIpc();

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const mainProtocol = yield* makeEffectElectronIpcMainProtocol(transport.mainPort);

          yield* RpcServer.make(TestRpcGroup).pipe(
            Effect.provideService(RpcServer.Protocol, mainProtocol),
            Effect.provide(TestHandlersLive),
            Effect.forkScoped,
          );

          const rendererProtocol = yield* makeEffectElectronIpcRendererProtocol(
            makeEffectElectronIpcRendererPort(transport.rendererPort),
          );
          const client = yield* makeTestClient.pipe(
            Effect.provideService(RpcClient.Protocol, rendererProtocol),
          );

          return yield* client[TEST_METHODS.echo]({
            text: "hello from renderer",
          });
        }),
      ),
    );

    expect(result).toEqual({
      text: "hello from renderer",
    });
  });
});

class InMemoryEffectElectronIpc {
  private readonly mainListeners = new Set<
    (source: EffectElectronIpcMainSource, frame: EffectElectronIpcRendererFrame) => void
  >();
  private readonly rendererListeners = new Set<(frame: EffectElectronIpcMainFrame) => void>();

  readonly source: EffectElectronIpcMainSource = {
    id: 1,
    send: (frame) => {
      queueMicrotask(() => {
        for (const listener of this.rendererListeners) {
          listener(frame);
        }
      });
    },
  };

  readonly mainPort = {
    subscribe: (
      listener: (
        source: EffectElectronIpcMainSource,
        frame: EffectElectronIpcRendererFrame,
      ) => void,
    ) => {
      this.mainListeners.add(listener);
      return () => {
        this.mainListeners.delete(listener);
      };
    },
  };

  readonly rendererPort = {
    send: (frame: EffectElectronIpcRendererFrame) => {
      queueMicrotask(() => {
        for (const listener of this.mainListeners) {
          listener(this.source, frame);
        }
      });
    },
    subscribe: (listener: (frame: EffectElectronIpcMainFrame) => void) => {
      this.rendererListeners.add(listener);
      return () => {
        this.rendererListeners.delete(listener);
      };
    },
  };
}
