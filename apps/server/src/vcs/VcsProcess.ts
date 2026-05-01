import { Duration, Context, Effect, Layer, Option, PlatformError, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  VcsOutputDecodeError,
  type VcsError,
  VcsProcessExitError,
  VcsProcessSpawnError,
  VcsProcessTimeoutError,
} from "@t3tools/contracts";

export interface VcsProcessInput {
  readonly operation: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly truncateOutputAtMaxBytes?: boolean;
}

export interface VcsProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
}

export interface VcsProcessShape {
  readonly run: (input: VcsProcessInput) => Effect.Effect<VcsProcessOutput, VcsError>;
}

export class VcsProcess extends Context.Service<VcsProcess, VcsProcessShape>()(
  "t3/vcs/VcsProcess",
) {}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const OUTPUT_TRUNCATED_MARKER = "\n\n[truncated]";

function commandLabel(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

const collectOutput = Effect.fn("VcsProcess.collectOutput")(function* (
  input: VcsProcessInput,
  stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  maxOutputBytes: number,
  truncateOutputAtMaxBytes: boolean,
) {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let truncated = false;

  yield* Stream.runForEach(stream, (chunk) =>
    Effect.sync(() => {
      if (truncated) return;

      const remainingBytes = maxOutputBytes - bytes;
      if (remainingBytes <= 0) {
        truncated = true;
        if (truncateOutputAtMaxBytes) {
          text += OUTPUT_TRUNCATED_MARKER;
        }
        return;
      }

      const nextChunk = chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk;
      text += decoder.decode(nextChunk, { stream: true });
      bytes += nextChunk.byteLength;

      if (chunk.byteLength > remainingBytes) {
        truncated = true;
        if (truncateOutputAtMaxBytes) {
          text += OUTPUT_TRUNCATED_MARKER;
        }
      }
    }),
  ).pipe(
    Effect.mapError(
      (cause) =>
        new VcsOutputDecodeError({
          operation: input.operation,
          command: commandLabel(input.command, input.args),
          cwd: input.cwd,
          detail: "failed to collect process output",
          cause,
        }),
    ),
  );

  if (!truncated) {
    text += decoder.decode();
  }

  return { text, truncated };
});

export const make = Effect.fn("makeVcsProcess")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const run = Effect.fn("VcsProcess.run")(function* (input: VcsProcessInput) {
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const label = commandLabel(input.command, input.args);

    const runProcess = Effect.gen(function* () {
      const child = yield* spawner
        .spawn(
          ChildProcess.make(input.command, [...input.args], {
            cwd: input.cwd,
            env: {
              ...process.env,
              ...input.env,
            },
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new VcsProcessSpawnError({
                operation: input.operation,
                command: label,
                cwd: input.cwd,
                cause,
              }),
          ),
        );

      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          collectOutput(
            input,
            child.stdout,
            maxOutputBytes,
            input.truncateOutputAtMaxBytes ?? false,
          ),
          collectOutput(
            input,
            child.stderr,
            maxOutputBytes,
            input.truncateOutputAtMaxBytes ?? false,
          ),
          child.exitCode.pipe(
            Effect.map((value) => Number(value)),
            Effect.mapError(
              (cause) =>
                new VcsOutputDecodeError({
                  operation: input.operation,
                  command: label,
                  cwd: input.cwd,
                  detail: "failed to read process exit code",
                  cause,
                }),
            ),
          ),
          input.stdin === undefined
            ? Effect.void
            : Stream.run(Stream.encodeText(Stream.make(input.stdin)), child.stdin).pipe(
                Effect.mapError(
                  (cause) =>
                    new VcsOutputDecodeError({
                      operation: input.operation,
                      command: label,
                      cwd: input.cwd,
                      detail: "failed to write process stdin",
                      cause,
                    }),
                ),
              ),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.map(([stdout, stderr, exitCode]) => [stdout, stderr, exitCode] as const));

      if (!input.allowNonZeroExit && exitCode !== 0) {
        return yield* new VcsProcessExitError({
          operation: input.operation,
          command: label,
          cwd: input.cwd,
          exitCode,
          detail: stderr.text.trim() || `${label} exited with code ${exitCode}.`,
        });
      }

      return {
        exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      } satisfies VcsProcessOutput;
    });

    return yield* runProcess.pipe(
      Effect.scoped,
      Effect.timeoutOption(Duration.millis(timeoutMs)),
      Effect.flatMap((result) =>
        Option.match(result, {
          onSome: Effect.succeed,
          onNone: () =>
            Effect.fail(
              new VcsProcessTimeoutError({
                operation: input.operation,
                command: label,
                cwd: input.cwd,
                timeoutMs,
              }),
            ),
        }),
      ),
    );
  });

  return VcsProcess.of({ run });
});

export const layer = Layer.effect(VcsProcess, make());
