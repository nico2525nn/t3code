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
  const client = yield* AcpClient.fromChildProcess(handle, {
    handlers: {
      requestPermission: () =>
        Effect.succeed({
          outcome: {
            outcome: "selected",
            optionId: "allow",
          },
        }),
      sessionUpdate: (notification) => Effect.logInfo("session/update", notification),
    },
  });

  const initialized = yield* client.initialize({
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

  const session = yield* client.createSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  yield* Effect.logInfo("created session", { sessionId: session.sessionId });

  const result = yield* client.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: "text", text: "Summarize this repository." }],
  });

  yield* Effect.logInfo("prompt result", result);
  yield* client.cancel({ sessionId: session.sessionId });
}).pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
