// @effect-diagnostics nodeBuiltinImport:off
/**
 * WebSocket transport for a Codex app-server Unix control socket.
 *
 * `codex app-server --listen unix://…` uses an HTTP-upgraded WebSocket on the
 * Unix socket. The protocol package deliberately remains transport agnostic
 * and consumes a JSONL-shaped `Stdio`, so this adapter turns one WebSocket
 * message into one JSONL input line and sends each complete JSONL output line
 * as one WebSocket message.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import * as NodeNet from "node:net";

import * as CodexErrors from "effect-codex-app-server/errors";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function rawDataToString(data: NodeSocket.NodeWS.RawData): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
}

const transportError = (socketPath: string, cause: unknown) =>
  new CodexErrors.CodexAppServerTransportError({
    operation: "read-input-stream",
    cause: new Error(`Codex app-server WebSocket transport failed for ${socketPath}`, {
      cause,
    }),
  });

export interface CodexAppServerUnixWebSocketStdioOptions {
  /** Called when the peer closes the socket or reports a transport error. */
  readonly onClosed?: () => void;
}

/**
 * Open a scoped WebSocket connection to a Codex Unix control socket and
 * expose it as the JSONL stdio expected by `effect-codex-app-server`.
 */
export const makeCodexAppServerUnixWebSocketStdio = Effect.fn(
  "CodexAppServerTransport.makeUnixWebSocketStdio",
)(function* (
  socketPath: string,
  options: CodexAppServerUnixWebSocketStdioOptions = {},
): Effect.fn.Return<Stdio.Stdio, CodexErrors.CodexAppServerError, Scope.Scope> {
  const input = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
  const endInput = () => {
    void Effect.runFork(Queue.end(input));
  };
  let closedSignalled = false;
  const signalClosed = () => {
    if (closedSignalled) {
      return;
    }
    closedSignalled = true;
    options.onClosed?.();
  };
  const socket = yield* Effect.acquireRelease(
    Effect.callback<NodeSocket.NodeWS.WebSocket, Error>((resume, signal) => {
      const socket = new NodeSocket.NodeWS.WebSocket("ws://localhost/rpc", {
        // `ws` accepts a custom dialer, which lets the HTTP upgrade travel
        // over the Unix domain socket rather than trying localhost:80.
        createConnection: () => NodeNet.createConnection({ path: socketPath }),
        perMessageDeflate: false,
      });
      let settled = false;
      let opened = false;

      const disposeSocket = () => {
        if (socket.readyState === NodeSocket.NodeWS.WebSocket.OPEN) {
          socket.close();
        } else if (socket.readyState !== NodeSocket.NodeWS.WebSocket.CLOSED) {
          socket.terminate();
        }
      };
      const cleanupHandshakeListeners = () => {
        socket.off("open", onOpen);
        socket.off("error", onError);
        socket.off("close", onClose);
      };
      const failBeforeOpen = (cause: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupHandshakeListeners();
        disposeSocket();
        resume(Effect.fail(cause));
      };
      const onOpen = () => {
        if (settled) {
          return;
        }
        settled = true;
        opened = true;
        // Keep the error/close listeners installed: a successful acquisition
        // must still terminate the input stream when the peer disappears.
        resume(Effect.succeed(socket));
      };
      const onError = (cause: Error) => {
        if (!opened) {
          failBeforeOpen(cause);
          return;
        }
        endInput();
        signalClosed();
      };
      const onClose = () => {
        if (!opened) {
          failBeforeOpen(
            new Error(`Codex app-server WebSocket closed before opening ${socketPath}`),
          );
          return;
        }
        endInput();
        signalClosed();
      };
      const onAbort = () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanupHandshakeListeners();
        disposeSocket();
      };
      socket.on("open", onOpen);
      socket.on("error", onError);
      socket.on("close", onClose);
      signal.addEventListener("abort", onAbort, { once: true });
    }),
    (socket) =>
      Effect.sync(() => {
        if (socket.readyState === NodeSocket.NodeWS.WebSocket.OPEN) {
          socket.close();
        } else if (socket.readyState !== NodeSocket.NodeWS.WebSocket.CLOSED) {
          socket.terminate();
        }
      }),
  ).pipe(Effect.mapError((cause) => transportError(socketPath, cause)));

  socket.on("message", (data) => {
    void Effect.runFork(Queue.offer(input, encoder.encode(`${rawDataToString(data)}\n`)));
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      endInput();
      socket.removeAllListeners();
      if (socket.readyState === NodeSocket.NodeWS.WebSocket.OPEN) {
        socket.close();
      } else if (socket.readyState !== NodeSocket.NodeWS.WebSocket.CLOSED) {
        socket.terminate();
      }
    }),
  );

  let outputRemainder = "";
  const stdout = () =>
    Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        outputRemainder +=
          typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
        for (;;) {
          const newline = outputRemainder.indexOf("\n");
          if (newline < 0) {
            break;
          }
          const line = outputRemainder.slice(0, newline).replace(/\r$/, "");
          outputRemainder = outputRemainder.slice(newline + 1);
          if (line.trim().length > 0 && socket.readyState === NodeSocket.NodeWS.WebSocket.OPEN) {
            socket.send(line);
          }
        }
      }),
    );

  return Stdio.make({
    args: Effect.succeed([]),
    stdin: Stream.fromQueue(input),
    stdout,
    stderr: () => Sink.drain,
  });
});
