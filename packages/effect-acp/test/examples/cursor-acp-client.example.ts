import * as Effect from "effect/Effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as AcpClient from "../../src/client";

Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const command = ChildProcess.make("cursor-agent", ["acp"], {
    cwd: process.cwd(),
    shell: process.platform === "win32",
  });
  const handle = yield* spawner.spawn(command);
  const acpLayer = AcpClient.layerFromChildProcessHandle(handle, {
    logIncoming: true,
    logOutgoing: true,
  });

  yield* Effect.gen(function* () {
    const acp = yield* AcpClient.AcpConnection;

    yield* acp.handleRequestPermission(() =>
      Effect.succeed({
        outcome: {
          outcome: "selected",
          optionId: "allow",
        },
      }),
    );
    yield* acp.handleSessionUpdate((notification) =>
      Effect.logInfo("session/update", notification),
    );

    const initialized = yield* acp.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: {
        name: "effect-acp-example",
        version: "0.0.0",
      },
    });
    yield* Effect.logInfo("initialized", initialized);

    const session = yield* acp.createSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    yield* acp.setSessionConfigOption({
      sessionId: session.sessionId,
      configId: "model",
      value: "gpt-5.4[reasoning=medium,context=272k,fast=false]",
    });

    const result = yield* acp.prompt({
      sessionId: session.sessionId,
      prompt: [
        {
          type: "text",
          text: "Illustrate your ability to create todo lists and then execute all of them. Do not write the list to disk, illustrate your built in ability!",
        },
      ],
    });

    yield* Effect.logInfo("prompt result", result);
    yield* acp.cancel({ sessionId: session.sessionId });
  }).pipe(Effect.provide(acpLayer));
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
