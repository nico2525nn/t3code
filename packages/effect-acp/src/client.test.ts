import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";

import * as AcpClient from "./client";

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/acp-mock-peer.ts"),
);

it.layer(NodeServices.layer)("effect-acp client", (it) => {
  it.effect("initializes, prompts, receives updates, and handles permission requests", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<unknown>>([]);
      const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;

      const command = ChildProcess.make("bun", ["run", yield* mockPeerPath], {
        cwd: path.join(import.meta.dirname, ".."),
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
          elicitation: () =>
            Effect.succeed({
              action: {
                action: "accept",
                content: {
                  approved: true,
                },
              },
            }),
          sessionUpdate: (notification) =>
            Ref.update(updates, (current) => [...current, notification]),
          elicitationComplete: (notification) =>
            Ref.update(elicitationCompletions, (current) => [...current, notification]),
        },
      });

      const init = yield* client.initialize({
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: {
          name: "effect-acp-test",
          version: "0.0.0",
        },
      });
      assert.equal(init.protocolVersion, 1);

      yield* client.authenticate({ methodId: "cursor_login" });

      const session = yield* client.createSession({
        cwd: process.cwd(),
        mcpServers: [],
      });
      assert.equal(session.sessionId, "mock-session-1");

      const prompt = yield* client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });
      assert.equal(prompt.stopReason, "end_turn");

      const streamed = yield* Stream.runCollect(Stream.take(client.updates, 2));
      assert.equal(streamed.length, 2);
      assert.equal(streamed[0]?._tag, "SessionUpdate");
      assert.equal(streamed[1]?._tag, "ElicitationComplete");
      assert.equal((yield* Ref.get(updates)).length, 1);
      assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);

      const ext = yield* client.extRequest("x/echo", {
        hello: "world",
      });
      assert.deepEqual(ext, {
        echoedMethod: "x/echo",
        echoedParams: {
          hello: "world",
        },
      });
    }),
  );
});
