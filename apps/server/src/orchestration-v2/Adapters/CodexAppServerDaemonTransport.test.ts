// @effect-diagnostics nodeBuiltinImport:off - Exercises a real Unix-domain WebSocket handshake.
import { expect, it } from "@effect/vitest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { makeCodexAppServerDaemonStdio } from "./CodexAppServerDaemonTransport.ts";

it.live("bridges Codex daemon WebSocket messages to and from App Server JSONL", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-codex-daemon-"))),
        (path) =>
          Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })).pipe(
            Effect.asVoid,
          ),
      );
      const socketPath = NodePath.join(directory, "daemon.sock");
      let resolveReceived!: (message: string) => void;
      const receivedFromClient = new Promise<string>((resolve) => {
        resolveReceived = resolve;
      });

      const httpServer = NodeHttp.createServer();
      const wsServer = new NodeWS.WebSocketServer({ server: httpServer });
      wsServer.on("connection", (client) => {
        client.once("message", (data) => resolveReceived?.(data.toString()));
        client.send(JSON.stringify({ method: "thread/started", params: { threadId: "thread-1" } }));
      });
      yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              httpServer.once("error", reject);
              httpServer.listen(socketPath, resolve);
            }),
        ),
        () =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const client of wsServer.clients) client.terminate();
                wsServer.close(() => httpServer.close(() => resolve()));
              }),
          ),
      );

      const stdio = yield* makeCodexAppServerDaemonStdio(socketPath);
      const receivedByClient = yield* Stream.runHead(stdio.stdin).pipe(Effect.timeout("2 seconds"));
      expect(Option.isSome(receivedByClient)).toBe(true);
      if (Option.isNone(receivedByClient)) throw new Error("Daemon notification was not delivered");
      expect(new TextDecoder().decode(receivedByClient.value)).toBe(
        '{"method":"thread/started","params":{"threadId":"thread-1"}}\n',
      );

      yield* Stream.run(Stream.make('{"id":1,"method":"initialize"}\n'), stdio.stdout());
      const received = yield* Effect.promise(() => receivedFromClient).pipe(
        Effect.timeout("2 seconds"),
      );
      expect(JSON.parse(received)).toEqual({ id: 1, method: "initialize" });
    }),
  ),
);
