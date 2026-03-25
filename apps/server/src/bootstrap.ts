import * as NFS from "node:fs";
import * as readline from "node:readline";

import { Data, Effect, Option, Result, Schema } from "effect";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";

class BootstrapError extends Data.TaggedError("BootstrapError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export const readBootstrapEnvelope = Effect.fn("readBootstrapEnvelope")(function* <
  S extends Schema.Codec<unknown, unknown, never, never>,
>(
  schema: S,
  fd: number,
  options?: {
    timeoutMs?: number;
  },
): Effect.fn.Return<Option.Option<Schema.Schema.Type<S>>, BootstrapError> {
  const fdReady = yield* Effect.try({
    try: () => NFS.fstatSync(fd),
    catch: (error) =>
      new BootstrapError({
        message: "Failed to stat bootstrap fd.",
        cause: error,
      }),
  }).pipe(
    Effect.as(true),
    Effect.catchIf(
      (error) => isUnavailableBootstrapFdError(error.cause),
      () => Effect.succeed(false),
    ),
  );
  if (!fdReady) return Option.none();

  const streamFd = yield* Effect.try({
    try: () => {
      const fdPath = resolveFdPath(fd);
      if (fdPath === undefined) return fd;
      return NFS.openSync(fdPath, "r");
    },
    catch: (error) =>
      new BootstrapError({
        message: "Failed to duplicate bootstrap fd.",
        cause: error,
      }),
  });

  const stream = NFS.createReadStream("", {
    fd: streamFd,
    encoding: "utf8",
    autoClose: true,
  });

  const timeoutMs = options?.timeoutMs ?? 1000;

  return yield* Effect.callback<Option.Option<Schema.Schema.Type<S>>, BootstrapError>((resume) => {
    const input = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    const cleanup = () => {
      stream.removeListener("error", handleError);
      input.removeListener("line", handleLine);
      input.removeListener("close", handleClose);
      input.close();
    };

    const handleError = (error: Error) => {
      if (isUnavailableBootstrapFdError(error)) {
        resume(Effect.succeed(Option.none<Schema.Schema.Type<S>>()));
        return;
      }
      resume(
        Effect.fail(
          new BootstrapError({
            message: "Failed to read bootstrap envelope.",
            cause: error,
          }),
        ),
      );
    };

    const handleLine = (line: string) => {
      const parsed = decodeJsonResult(schema)(line);
      if (Result.isSuccess(parsed)) {
        resume(Effect.succeed(Option.some(parsed.success as Schema.Schema.Type<S>)));
        return;
      }
      resume(
        Effect.fail(
          new BootstrapError({
            message: "Failed to decode bootstrap envelope.",
            cause: parsed.failure,
          }),
        ),
      );
    };

    const handleClose = () => {
      resume(Effect.succeed(Option.none<Schema.Schema.Type<S>>()));
    };

    stream.once("error", handleError);
    input.once("line", handleLine);
    input.once("close", handleClose);

    return Effect.sync(cleanup);
  }).pipe(Effect.timeoutOption(timeoutMs), Effect.map(Option.flatten));
});

function isUnavailableBootstrapFdError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "EBADF" || error.code === "ENOENT")
  );
}

function resolveFdPath(fd: number): string | undefined {
  if (process.platform === "linux") {
    return `/proc/self/fd/${fd}`;
  }
  if (process.platform === "win32") {
    return undefined;
  }
  return `/dev/fd/${fd}`;
}
