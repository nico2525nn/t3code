// @effect-diagnostics nodeBuiltinImport:off - Connects the Codex daemon's Unix WebSocket to the App Server JSONL client.
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as NodeNet from "node:net";

export class CodexAppServerDaemonConnectionError extends Schema.TaggedError<CodexAppServerDaemonConnectionError>()(
  "CodexAppServerDaemonConnectionError",
  {
    socketPath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export const makeCodexAppServerDaemonStdio = Effect.fn("CodexAppServerDaemonTransport.makeStdio")(
  function* (socketPath: string) {
    const incoming = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    const endInput = () => runFork(Queue.end(incoming));
    const socket = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) =>
          new Promise<NodeWS.WebSocket>((resolve, reject) => {
            let opened = false;
            const client = new NodeWS.WebSocket("ws://localhost/", {
              createConnection: () => NodeNet.createConnection({ path: socketPath }),
              handshakeTimeout: 10_000,
              perMessageDeflate: false,
            });
            const cleanup = () => {
              client.off("open", onOpen);
              client.off("error", onError);
              client.off("close", onClose);
              signal.removeEventListener("abort", onAbort);
            };
            const onMessage = (data: NodeWS.RawData) => {
              const bytes =
                typeof data === "string"
                  ? Buffer.from(data)
                  : Buffer.isBuffer(data)
                    ? data
                    : Array.isArray(data)
                      ? Buffer.concat(data)
                      : Buffer.from(data as ArrayBuffer);
              const message =
                bytes.at(-1) === 10 ? bytes : Buffer.concat([bytes, Buffer.from("\n")]);
              runFork(Queue.offer(incoming, message));
            };
            const onOpen = () => {
              opened = true;
              client.off("open", onOpen);
              signal.removeEventListener("abort", onAbort);
              resolve(client);
            };
            const onError = (error: Error) => {
              endInput();
              if (!opened) {
                cleanup();
                client.terminate();
                reject(error);
              } else {
                client.terminate();
              }
            };
            const onClose = () => {
              endInput();
              if (!opened) reject(new Error("Codex daemon closed before completing its handshake"));
              cleanup();
              client.off("message", onMessage);
            };
            const onAbort = () => {
              cleanup();
              client.terminate();
              reject(signal.reason ?? new Error("Codex daemon connection aborted"));
            };
            client.once("open", onOpen);
            client.once("error", onError);
            client.once("close", onClose);
            client.on("message", onMessage);
            signal.addEventListener("abort", onAbort, { once: true });
          }),
        catch: (cause) => new CodexAppServerDaemonConnectionError({ socketPath, cause }),
      }),
      (client) =>
        Effect.sync(() => {
          if (client.readyState === NodeWS.WebSocket.OPEN) client.close();
          else client.terminate();
        }),
    );

    const send = (chunk: string | Uint8Array) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            if (socket.readyState !== NodeWS.WebSocket.OPEN) {
              endInput();
              socket.terminate();
              resolve();
              return;
            }
            socket.send(
              typeof chunk === "string" ? chunk : Buffer.from(chunk),
              { binary: false },
              (error) => {
                if (error) {
                  endInput();
                  socket.terminate();
                }
                resolve();
              },
            );
          }),
      );

    return Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.fromQueue(incoming),
      stdout: () => Sink.forEach(send),
      stderr: () => Sink.drain,
    });
  },
);
