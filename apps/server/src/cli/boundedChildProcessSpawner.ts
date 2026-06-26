import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export type ChildProcessShutdownSignal = "SIGTERM" | "SIGKILL";

export interface BoundedChildProcessSpawnerOptions {
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_TERM_GRACE_MS = 2_000;
const DEFAULT_KILL_GRACE_MS = 1_000;
const DEFAULT_POLL_INTERVAL_MS = 25;

const normalizedDelay = (value: number | undefined, fallback: number) =>
  value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, value);

const isStillRunning = (handle: ChildProcessSpawner.ChildProcessHandle) =>
  handle.isRunning.pipe(Effect.orElseSucceed(() => true));

const waitUntilStopped = Effect.fn("BoundedChildProcessSpawner.waitUntilStopped")(function* (
  handle: ChildProcessSpawner.ChildProcessHandle,
  timeoutMs: number,
  pollIntervalMs: number,
) {
  let remainingMs = timeoutMs;

  while (yield* isStillRunning(handle)) {
    if (remainingMs <= 0) return false;
    const delayMs = Math.min(pollIntervalMs, remainingMs);
    yield* Effect.sleep(delayMs);
    remainingMs -= delayMs;
  }

  return true;
});

const closeScopeDetached = Effect.fn("BoundedChildProcessSpawner.closeScopeDetached")(function* (
  scope: Scope.Closeable,
) {
  yield* Scope.close(scope, Exit.void).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkDetach({ startImmediately: true }),
  );
});

export const make = (
  delegate: ChildProcessSpawner.ChildProcessSpawner["Service"],
  options: BoundedChildProcessSpawnerOptions = {},
) => {
  const termGraceMs = normalizedDelay(options.termGraceMs, DEFAULT_TERM_GRACE_MS);
  const killGraceMs = normalizedDelay(options.killGraceMs, DEFAULT_KILL_GRACE_MS);
  const pollIntervalMs = Math.max(
    1,
    normalizedDelay(options.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS),
  );
  const sendSignal = Effect.fn("BoundedChildProcessSpawner.sendSignal")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
    signal: ChildProcessShutdownSignal,
  ) {
    yield* handle
      .kill({ killSignal: signal })
      .pipe(Effect.ignore, Effect.forkDetach({ startImmediately: true }));
  });

  const shutdown = Effect.fn("BoundedChildProcessSpawner.shutdown")(function* (
    handle: ChildProcessSpawner.ChildProcessHandle,
    childScope: Scope.Closeable,
    isReferenced: () => boolean,
  ) {
    if (isReferenced() && (yield* isStillRunning(handle))) {
      yield* sendSignal(handle, "SIGTERM");
      const stoppedAfterTerm = yield* waitUntilStopped(handle, termGraceMs, pollIntervalMs);

      if (!stoppedAfterTerm) {
        yield* sendSignal(handle, "SIGKILL");
        const stoppedAfterKill = yield* waitUntilStopped(handle, killGraceMs, pollIntervalMs);
        if (!stoppedAfterKill) {
          yield* Effect.logWarning("Child process did not stop after SIGKILL grace period", {
            pid: Number(handle.pid),
            killGraceMs,
          });
        }
      }
    }

    // The platform spawner's own finalizer can wait forever for an exit event.
    // Run it detached so it can finish normally without blocking the caller's
    // scope when the operating system does not report an exit in time.
    yield* closeScopeDetached(childScope);
  });

  const spawn = Effect.fn("BoundedChildProcessSpawner.spawn")(function* (
    command: ChildProcess.Command,
  ) {
    const childScope = yield* Scope.make("sequential");
    const spawned = yield* delegate
      .spawn(command)
      .pipe(Effect.provideService(Scope.Scope, childScope), Effect.exit);

    if (Exit.isFailure(spawned)) {
      yield* closeScopeDetached(childScope);
      return yield* Effect.failCause(spawned.cause);
    }

    const delegateHandle = spawned.value;
    let referenced = true;
    const handle = ChildProcessSpawner.makeHandle({
      pid: delegateHandle.pid,
      exitCode: delegateHandle.exitCode,
      isRunning: delegateHandle.isRunning,
      kill: delegateHandle.kill,
      stdin: delegateHandle.stdin,
      stdout: delegateHandle.stdout,
      stderr: delegateHandle.stderr,
      all: delegateHandle.all,
      getInputFd: delegateHandle.getInputFd,
      getOutputFd: delegateHandle.getOutputFd,
      unref: delegateHandle.unref.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            referenced = false;
          }),
        ),
        Effect.map((reref) =>
          reref.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                referenced = true;
              }),
            ),
          ),
        ),
      ),
    });
    yield* Effect.addFinalizer(() => shutdown(handle, childScope, () => referenced));
    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.andThen(Scope.close(childScope, Exit.void)),
      Effect.ignoreCause({ log: true }),
      Effect.forkDetach({ startImmediately: true }),
    );

    return handle;
  }, Effect.uninterruptible);

  return ChildProcessSpawner.make(spawn);
};

export const layer = (options?: BoundedChildProcessSpawnerOptions) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(ChildProcessSpawner.ChildProcessSpawner, (delegate) => make(delegate, options)),
  );
