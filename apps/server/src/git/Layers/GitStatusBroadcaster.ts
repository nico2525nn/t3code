import { realpathSync } from "node:fs";

import { Duration, Effect, Exit, Layer, PubSub, Ref, Scope, Stream } from "effect";
import type { GitStatusInput, GitStatusResult } from "@t3tools/contracts";

import {
  GitStatusBroadcaster,
  type GitStatusBroadcasterShape,
} from "../Services/GitStatusBroadcaster.ts";
import { GitManager } from "../Services/GitManager.ts";

const GIT_STATUS_REFRESH_INTERVAL = Duration.seconds(30);

interface GitStatusChange {
  readonly cwd: string;
  readonly status: GitStatusResult;
}

interface CachedGitStatus {
  readonly fingerprint: string;
  readonly status: GitStatusResult;
}

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

function fingerprintStatus(status: GitStatusResult): string {
  return JSON.stringify(status);
}

export const GitStatusBroadcasterLive = Layer.effect(
  GitStatusBroadcaster,
  Effect.gen(function* () {
    const gitManager = yield* GitManager;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<GitStatusChange>(),
      (pubsub) => PubSub.shutdown(pubsub),
    );
    const broadcasterScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const cacheRef = yield* Ref.make(new Map<string, CachedGitStatus>());
    const pollersRef = yield* Ref.make(new Set<string>());

    const refreshStatus: GitStatusBroadcasterShape["refreshStatus"] = Effect.fn("refreshStatus")(
      function* (cwd) {
        const normalizedCwd = normalizeCwd(cwd);
        yield* gitManager.invalidateStatus(normalizedCwd);
        const nextStatus = yield* gitManager.status({ cwd: normalizedCwd });
        const nextFingerprint = fingerprintStatus(nextStatus);
        const shouldPublish = yield* Ref.modify(cacheRef, (cache) => {
          const previous = cache.get(normalizedCwd);
          const nextCache = new Map(cache);
          nextCache.set(normalizedCwd, {
            fingerprint: nextFingerprint,
            status: nextStatus,
          });
          return [previous?.fingerprint !== nextFingerprint, nextCache] as const;
        });

        if (shouldPublish) {
          yield* PubSub.publish(changesPubSub, {
            cwd: normalizedCwd,
            status: nextStatus,
          });
        }

        return nextStatus;
      },
    );

    const getStatus: GitStatusBroadcasterShape["getStatus"] = Effect.fn("getStatus")(function* (
      input: GitStatusInput,
    ) {
      const normalizedCwd = normalizeCwd(input.cwd);
      const cached = yield* Ref.get(cacheRef).pipe(
        Effect.map((cache) => cache.get(normalizedCwd)?.status ?? null),
      );
      if (cached) {
        return cached;
      }

      return yield* refreshStatus(normalizedCwd);
    });

    const ensurePoller = Effect.fn("ensurePoller")(function* (cwd: string) {
      const normalizedCwd = normalizeCwd(cwd);
      const shouldStart = yield* Ref.modify(pollersRef, (activePollers) => {
        if (activePollers.has(normalizedCwd)) {
          return [false, activePollers] as const;
        }

        const nextPollers = new Set(activePollers);
        nextPollers.add(normalizedCwd);
        return [true, nextPollers] as const;
      });

      if (!shouldStart) {
        return;
      }

      const refreshLoop = Effect.forever(
        Effect.sleep(GIT_STATUS_REFRESH_INTERVAL).pipe(
          Effect.andThen(
            refreshStatus(normalizedCwd).pipe(
              Effect.catch((error) =>
                Effect.logWarning("git status refresh failed", {
                  cwd: normalizedCwd,
                  detail: error.message,
                }),
              ),
            ),
          ),
        ),
      );

      yield* Effect.forkIn(refreshLoop, broadcasterScope);
    });

    const streamStatus: GitStatusBroadcasterShape["streamStatus"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const normalizedCwd = normalizeCwd(input.cwd);
          yield* ensurePoller(normalizedCwd);
          const initialStatus = yield* getStatus({ cwd: normalizedCwd });

          return Stream.concat(
            Stream.make(initialStatus),
            Stream.fromPubSub(changesPubSub).pipe(
              Stream.filter((event) => event.cwd === normalizedCwd),
              Stream.map((event) => event.status),
            ),
          );
        }),
      );

    return {
      getStatus,
      refreshStatus,
      streamStatus,
    } satisfies GitStatusBroadcasterShape;
  }),
);
