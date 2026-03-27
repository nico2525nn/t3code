import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import type { ChildProcessSpawner } from "effect/unstable/process";

const textEncoder = new TextEncoder();

export function makeStdioFromChildProcess(
  handle: ChildProcessSpawner.ChildProcessHandle,
): Stdio.Stdio {
  return Stdio.make({
    stdin: handle.stdout,
    stdout: Sink.mapInput(handle.stdin, (chunk) =>
      typeof chunk === "string" ? textEncoder.encode(chunk) : chunk,
    ),
    stderr: Sink.drain,
  });
}

export const layerStdioFromChildProcess = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  Layer.succeed(Stdio.Stdio, makeStdioFromChildProcess(handle));
