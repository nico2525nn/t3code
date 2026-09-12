/**
 * CheckpointDiffQuery - Query interface for computed checkpoint diffs.
 *
 * Provides read-only diff operations across checkpoint snapshots used by
 * orchestration APIs.
 *
 * @module CheckpointDiffQuery
 */
import {
  type CheckpointRef,
  OrchestrationGetTurnDiffResult,
  type OrchestrationGetFullThreadDiffInput,
  type OrchestrationGetFullThreadDiffResult,
  type OrchestrationGetTurnDiffInput,
  type OrchestrationGetTurnDiffResult as OrchestrationGetTurnDiffResultType,
  type OrchestrationCheckpointSummary,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as CheckpointDiffBlobRepository from "../persistence/Services/CheckpointDiffBlobs.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
} from "./Errors.ts";
import type { CheckpointServiceError } from "./Errors.ts";
import { checkpointRefForThreadTurn } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { normalizeProviderDiff } from "./ProviderDiffNormalization.ts";

/** Service tag for checkpoint diff queries. */
export class CheckpointDiffQuery extends Context.Service<
  CheckpointDiffQuery,
  {
    /**
     * Read the patch diff for a single turn checkpoint transition.
     *
     * Verifies checkpoint availability in both projection state and filesystem.
     */
    readonly getTurnDiff: (
      input: OrchestrationGetTurnDiffInput,
    ) => Effect.Effect<OrchestrationGetTurnDiffResultType, CheckpointServiceError>;

    /**
     * Read the full patch diff across a thread range of checkpoints.
     *
     * Uses turn-diff semantics with `fromTurnCount = 0`.
     */
    readonly getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Effect.Effect<OrchestrationGetFullThreadDiffResult, CheckpointServiceError>;
  }
>()("t3/checkpointing/CheckpointDiffQuery") {}

const isTurnDiffResult = Schema.is(OrchestrationGetTurnDiffResult);

const isProviderDiffRef = (ref: CheckpointRef): boolean => String(ref).startsWith("provider-diff:");

function buildTurnDiffResult(
  input: {
    readonly threadId: ThreadId;
    readonly fromTurnCount: number;
    readonly toTurnCount: number;
  },
  diff: string,
): OrchestrationGetTurnDiffResultType {
  return {
    threadId: input.threadId,
    fromTurnCount: input.fromTurnCount,
    toTurnCount: input.toTurnCount,
    diff,
  };
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const providerDiffBlobRepository = yield* Effect.serviceOption(
    CheckpointDiffBlobRepository.CheckpointDiffBlobRepository,
  );

  const readProviderDiffRange = (
    threadId: ThreadId,
    fromTurnCount: number,
    toTurnCount: number,
    checkpoints: ReadonlyArray<
      Pick<OrchestrationCheckpointSummary, "checkpointTurnCount" | "files">
    > = [],
  ): Effect.Effect<Option.Option<string>, CheckpointServiceError> =>
    Option.match(providerDiffBlobRepository, {
      onNone: () => Effect.succeed(Option.none()),
      onSome: (repository) =>
        repository.listByThreadId({ threadId }).pipe(
          Effect.map((blobs) => {
            const selected = blobs
              .filter(
                (blob) => blob.fromTurnCount >= fromTurnCount && blob.toTurnCount <= toTurnCount,
              )
              .toSorted((left, right) => left.toTurnCount - right.toTurnCount);
            const blobsByToTurnCount = new Map(selected.map((blob) => [blob.toTurnCount, blob]));
            const checkpointsByTurnCount = new Map(
              checkpoints.map((checkpoint) => [checkpoint.checkpointTurnCount, checkpoint]),
            );
            const diffs: Array<string> = [];
            for (let to = fromTurnCount + 1; to <= toTurnCount; to += 1) {
              const blob = blobsByToTurnCount.get(to);
              if (blob !== undefined) {
                if (blob.fromTurnCount !== to - 1) {
                  return Option.none<string>();
                }
                diffs.push(blob.diff);
                continue;
              }

              // Codex does not emit a file-change item for a turn that left
              // the workspace unchanged. Treat that missing blob as an empty
              // patch so a later provider-native turn remains viewable across
              // an unchanged turn. A checkpoint with file metadata but no
              // blob is still incomplete and must not be silently erased.
              const checkpoint = checkpointsByTurnCount.get(to);
              if (checkpoint === undefined || checkpoint.files.length > 0) {
                return Option.none<string>();
              }
              diffs.push("");
            }
            return Option.some(normalizeProviderDiff(diffs.join("\n")));
          }),
        ),
    });

  const getTurnDiff: CheckpointDiffQuery["Service"]["getTurnDiff"] = Effect.fn("getTurnDiff")(
    function* (input) {
      const operation = "CheckpointDiffQuery.getTurnDiff";
      const ignoreWhitespace = input.ignoreWhitespace ?? true;
      yield* Effect.annotateCurrentSpan({
        "checkpoint.thread_id": input.threadId,
        "checkpoint.from_turn_count": input.fromTurnCount,
        "checkpoint.to_turn_count": input.toTurnCount,
        "checkpoint.ignore_whitespace": ignoreWhitespace,
      });

      if (input.fromTurnCount === input.toTurnCount) {
        const emptyDiff: OrchestrationGetTurnDiffResultType = {
          threadId: input.threadId,
          fromTurnCount: input.fromTurnCount,
          toTurnCount: input.toTurnCount,
          diff: "",
        };
        if (!isTurnDiffResult(emptyDiff)) {
          return yield* new CheckpointDiffResultInvalidError({
            operation,
            threadId: input.threadId,
          });
        }
        return emptyDiff;
      }

      const threadContext = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(input.threadId)
        .pipe(Effect.withSpan("checkpoint.turnDiff.lookupContext"));
      if (Option.isNone(threadContext)) {
        return yield* new CheckpointThreadNotFoundError({
          operation,
          threadId: input.threadId,
        });
      }

      const maxTurnCount = threadContext.value.checkpoints.reduce(
        (max, checkpoint) => Math.max(max, checkpoint.checkpointTurnCount),
        0,
      );
      if (input.toTurnCount > maxTurnCount) {
        return yield* new CheckpointTurnRangeUnavailableError({
          operation,
          threadId: input.threadId,
          requestedTurnCount: input.toTurnCount,
          availableTurnCount: maxTurnCount,
        });
      }

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
        });
      }

      const fromCheckpointRef =
        input.fromTurnCount === 0
          ? checkpointRefForThreadTurn(input.threadId, 0)
          : threadContext.value.checkpoints.find(
              (checkpoint) => checkpoint.checkpointTurnCount === input.fromTurnCount,
            )?.checkpointRef;
      if (!fromCheckpointRef) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.fromTurnCount,
          checkpoint: "from",
        });
      }

      const toCheckpoint = threadContext.value.checkpoints.find(
        (checkpoint) => checkpoint.checkpointTurnCount === input.toTurnCount,
      );
      const toCheckpointRef = toCheckpoint?.checkpointRef;
      if (!toCheckpointRef) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      if (isProviderDiffRef(toCheckpointRef) || toCheckpoint?.status !== "ready") {
        const providerDiff = yield* readProviderDiffRange(
          input.threadId,
          input.fromTurnCount,
          input.toTurnCount,
          threadContext.value.checkpoints,
        );
        if (Option.isSome(providerDiff)) {
          return buildTurnDiffResult(input, providerDiff.value);
        }
      }

      // A provider-diff ref is intentionally not a Git ref. Do not pass a
      // mixed or incomplete provider range to Git, where the failure would be
      // opaque and could be mistaken for a missing repository checkpoint.
      if (isProviderDiffRef(fromCheckpointRef) || isProviderDiffRef(toCheckpointRef)) {
        const providerCheckpointIsTo = isProviderDiffRef(toCheckpointRef);
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: providerCheckpointIsTo ? input.toTurnCount : input.fromTurnCount,
          checkpoint: providerCheckpointIsTo ? "to" : "from",
        });
      }

      const diff = yield* checkpointStore
        .diffCheckpoints({
          cwd: workspaceCwd,
          fromCheckpointRef,
          toCheckpointRef,
          fallbackFromToHead: false,
          ignoreWhitespace,
        })
        .pipe(Effect.withSpan("checkpoint.turnDiff.diffCheckpoints"));

      const turnDiff = buildTurnDiffResult(input, diff);
      if (!isTurnDiffResult(turnDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }

      return turnDiff;
    },
  );

  const getFullThreadDiff: CheckpointDiffQuery["Service"]["getFullThreadDiff"] = Effect.fn(
    "CheckpointDiffQuery.getFullThreadDiff",
  )(function* (input) {
    const operation = "CheckpointDiffQuery.getFullThreadDiff";
    const ignoreWhitespace = input.ignoreWhitespace ?? true;
    yield* Effect.annotateCurrentSpan({
      "checkpoint.thread_id": input.threadId,
      "checkpoint.from_turn_count": 0,
      "checkpoint.to_turn_count": input.toTurnCount,
      "checkpoint.ignore_whitespace": ignoreWhitespace,
      "checkpoint.diff_kind": "full-thread",
    });

    if (input.toTurnCount === 0) {
      const emptyDiff = buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: 0,
        },
        "",
      );
      if (!isTurnDiffResult(emptyDiff)) {
        return yield* new CheckpointDiffResultInvalidError({
          operation,
          threadId: input.threadId,
        });
      }
      return emptyDiff satisfies OrchestrationGetFullThreadDiffResult;
    }

    const threadContext = yield* projectionSnapshotQuery
      .getFullThreadDiffContext(input.threadId, input.toTurnCount)
      .pipe(Effect.withSpan("checkpoint.fullThread.lookupContext"));

    if (Option.isNone(threadContext)) {
      return yield* new CheckpointThreadNotFoundError({
        operation,
        threadId: input.threadId,
      });
    }

    if (input.toTurnCount > threadContext.value.latestCheckpointTurnCount) {
      return yield* new CheckpointTurnRangeUnavailableError({
        operation,
        threadId: input.threadId,
        requestedTurnCount: input.toTurnCount,
        availableTurnCount: threadContext.value.latestCheckpointTurnCount,
      });
    }

    const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointWorkspacePathMissingError({
        operation,
        threadId: input.threadId,
      });
    }

    if (!threadContext.value.toCheckpointRef) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    const toCheckpointIsProviderDiff = isProviderDiffRef(threadContext.value.toCheckpointRef);
    const toCheckpointNeedsProviderFallback =
      threadContext.value.toCheckpointStatus !== undefined &&
      threadContext.value.toCheckpointStatus !== null &&
      threadContext.value.toCheckpointStatus !== "ready";
    if (toCheckpointIsProviderDiff || toCheckpointNeedsProviderFallback) {
      const checkpoints = Option.isSome(providerDiffBlobRepository)
        ? yield* projectionSnapshotQuery
            .getThreadCheckpointContext(input.threadId)
            .pipe(Effect.withSpan("checkpoint.fullThread.lookupCheckpoints"))
        : Option.none();
      const providerDiff = yield* readProviderDiffRange(
        input.threadId,
        0,
        input.toTurnCount,
        Option.isSome(checkpoints) ? checkpoints.value.checkpoints : [],
      );
      if (Option.isSome(providerDiff)) {
        return buildTurnDiffResult(
          {
            threadId: input.threadId,
            fromTurnCount: 0,
            toTurnCount: input.toTurnCount,
          },
          providerDiff.value,
        ) satisfies OrchestrationGetFullThreadDiffResult;
      }

      if (toCheckpointIsProviderDiff) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      // A native blob is a recovery path for a non-ready Git checkpoint. If
      // it is unavailable, preserve the legacy Git behavior instead of
      // turning an otherwise usable ref into a hard failure.
    }

    const diff = yield* checkpointStore
      .diffCheckpoints({
        cwd: workspaceCwd,
        fromCheckpointRef: checkpointRefForThreadTurn(input.threadId, 0),
        toCheckpointRef: threadContext.value.toCheckpointRef as CheckpointRef,
        fallbackFromToHead: false,
        ignoreWhitespace,
      })
      .pipe(Effect.withSpan("checkpoint.fullThread.diffCheckpoints"));

    const turnDiff = buildTurnDiffResult(
      {
        threadId: input.threadId,
        fromTurnCount: 0,
        toTurnCount: input.toTurnCount,
      },
      diff,
    );
    if (!isTurnDiffResult(turnDiff)) {
      return yield* new CheckpointDiffResultInvalidError({
        operation,
        threadId: input.threadId,
      });
    }

    return turnDiff satisfies OrchestrationGetFullThreadDiffResult;
  });

  return CheckpointDiffQuery.of({
    getTurnDiff,
    getFullThreadDiff,
  });
});

export const layer = Layer.effect(CheckpointDiffQuery, make);
