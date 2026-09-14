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
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  codexStoredDiffRange,
  isCodexAppServerThread,
  readCodexStoredHistory,
} from "../provider/Layers/CodexAppServerThreadSnapshot.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import {
  CheckpointDiffResultInvalidError,
  CheckpointRefUnavailableError,
  CheckpointThreadNotFoundError,
  CheckpointTurnRangeUnavailableError,
  CheckpointWorkspacePathMissingError,
} from "./Errors.ts";
import type { CheckpointServiceError } from "./Errors.ts";
import { normalizeProviderDiff } from "./ProviderDiffNormalization.ts";
import { checkpointRefForThreadTurn, isProviderDiffCheckpointRef } from "./Utils.ts";
import * as CheckpointStore from "./CheckpointStore.ts";

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

type LegacyProviderDiffRow = Readonly<{
  readonly fromTurnCount: number;
  readonly toTurnCount: number;
  readonly diff: string;
}>;

/**
 * Read the old provider-owned diff format without bringing back its writer.
 *
 * These rows are retained only for databases created by the earlier bridge.
 * New Codex App Server threads use native history, while normal Git threads
 * continue through CheckpointStore.
 */
export function legacyProviderDiffFromRows(
  rows: ReadonlyArray<LegacyProviderDiffRow>,
  fromTurnCount: number,
  toTurnCount: number,
  checkpoints: ReadonlyArray<Pick<OrchestrationCheckpointSummary, "checkpointTurnCount" | "files">>,
): Option.Option<string> {
  const selected = rows
    .filter((row) => row.fromTurnCount >= fromTurnCount && row.toTurnCount <= toTurnCount)
    .toSorted((left, right) => left.toTurnCount - right.toTurnCount);
  const rowsByToTurnCount = new Map(selected.map((row) => [row.toTurnCount, row]));
  const checkpointsByTurnCount = new Map(
    checkpoints.map((checkpoint) => [checkpoint.checkpointTurnCount, checkpoint]),
  );
  const diffs: Array<string> = [];

  for (let to = fromTurnCount + 1; to <= toTurnCount; to += 1) {
    const row = rowsByToTurnCount.get(to);
    if (row !== undefined) {
      if (row.fromTurnCount !== to - 1) return Option.none();
      diffs.push(row.diff);
      continue;
    }

    // A provider turn without file changes had no native patch row. Only
    // treat it as empty when its checkpoint also has no file metadata.
    const checkpoint = checkpointsByTurnCount.get(to);
    if (checkpoint === undefined || checkpoint.files.length > 0) return Option.none();
    diffs.push("");
  }

  return Option.some(normalizeProviderDiff(diffs.join("\n")));
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const checkpointStore = yield* CheckpointStore.CheckpointStore;
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);

  const readLegacyProviderDiffRange = (
    threadId: ThreadId,
    fromTurnCount: number,
    toTurnCount: number,
    checkpoints: ReadonlyArray<
      Pick<OrchestrationCheckpointSummary, "checkpointTurnCount" | "files">
    >,
  ): Effect.Effect<Option.Option<string>, never> =>
    Option.match(sql, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (client) =>
        client<LegacyProviderDiffRow>`
          SELECT
            from_turn_count AS "fromTurnCount",
            to_turn_count AS "toTurnCount",
            diff
          FROM checkpoint_diff_blobs
          WHERE thread_id = ${threadId}
            AND from_turn_count >= ${fromTurnCount}
            AND to_turn_count <= ${toTurnCount}
          ORDER BY to_turn_count ASC
        `.pipe(
          Effect.map((rows) =>
            legacyProviderDiffFromRows(rows, fromTurnCount, toTurnCount, checkpoints),
          ),
          // The table is present in normal migrated databases. If a caller is
          // using a deliberately minimal test/legacy database, this optional
          // compatibility path must not hide the native or Git path.
          Effect.catchCause(() => Effect.succeed(Option.none<string>())),
        ),
    });
  const providerInstances = yield* Effect.serviceOption(ProviderInstanceRegistry);

  const readCodexNativeDiffRange = (
    threadId: ThreadId,
    fromTurnCount: number,
    toTurnCount: number,
  ): Effect.Effect<Option.Option<string>, never> =>
    Option.match(providerInstances, {
      onNone: () => Effect.succeed(Option.none<string>()),
      onSome: (instances) =>
        projectionSnapshotQuery.getThreadShellById(threadId).pipe(
          Effect.flatMap((thread) =>
            Option.match(thread, {
              onNone: () => Effect.succeed(Option.none<string>()),
              onSome: (shell) =>
                readCodexStoredHistory(shell, instances).pipe(
                  Effect.map((history) =>
                    history === undefined
                      ? Option.none<string>()
                      : (() => {
                          const diff = codexStoredDiffRange(history, fromTurnCount, toTurnCount);
                          return diff === undefined ? Option.none<string>() : Option.some(diff);
                        })(),
                  ),
                  // Native history is an optimization/read-through path. A
                  // daemon restart must leave the existing checkpoint path
                  // usable, so a failed native read falls back below.
                  Effect.catchCause(() => Effect.succeed(Option.none<string>())),
                ),
            }),
          ),
          Effect.catchCause(() => Effect.succeed(Option.none<string>())),
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

      const nativeDiff = yield* readCodexNativeDiffRange(
        input.threadId,
        input.fromTurnCount,
        input.toTurnCount,
      );
      if (Option.isSome(nativeDiff)) {
        return buildTurnDiffResult(input, nativeDiff.value);
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

      if (isProviderDiffCheckpointRef(toCheckpointRef) || toCheckpoint?.status !== "ready") {
        const legacyDiff = yield* readLegacyProviderDiffRange(
          input.threadId,
          input.fromTurnCount,
          input.toTurnCount,
          threadContext.value.checkpoints,
        );
        if (Option.isSome(legacyDiff)) {
          return buildTurnDiffResult(input, legacyDiff.value);
        }
      }

      if (
        isProviderDiffCheckpointRef(fromCheckpointRef) ||
        isProviderDiffCheckpointRef(toCheckpointRef)
      ) {
        const providerCheckpointIsTo = isProviderDiffCheckpointRef(toCheckpointRef);
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: providerCheckpointIsTo ? input.toTurnCount : input.fromTurnCount,
          checkpoint: providerCheckpointIsTo ? "to" : "from",
        });
      }

      if (isCodexAppServerThread(String(input.threadId))) {
        return yield* new CheckpointRefUnavailableError({
          operation,
          threadId: input.threadId,
          turnCount: input.toTurnCount,
          checkpoint: "to",
        });
      }

      const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
      if (!workspaceCwd) {
        return yield* new CheckpointWorkspacePathMissingError({
          operation,
          threadId: input.threadId,
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

    const nativeDiff = yield* readCodexNativeDiffRange(input.threadId, 0, input.toTurnCount);
    if (Option.isSome(nativeDiff)) {
      return buildTurnDiffResult(
        {
          threadId: input.threadId,
          fromTurnCount: 0,
          toTurnCount: input.toTurnCount,
        },
        nativeDiff.value,
      ) satisfies OrchestrationGetFullThreadDiffResult;
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

    if (!threadContext.value.toCheckpointRef) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    if (isProviderDiffCheckpointRef(threadContext.value.toCheckpointRef)) {
      const checkpoints = yield* projectionSnapshotQuery
        .getThreadCheckpointContext(input.threadId)
        .pipe(Effect.withSpan("checkpoint.fullThread.lookupCheckpoints"));
      const legacyDiff = yield* readLegacyProviderDiffRange(
        input.threadId,
        0,
        input.toTurnCount,
        Option.isSome(checkpoints) ? checkpoints.value.checkpoints : [],
      );
      if (Option.isSome(legacyDiff)) {
        return buildTurnDiffResult(
          {
            threadId: input.threadId,
            fromTurnCount: 0,
            toTurnCount: input.toTurnCount,
          },
          legacyDiff.value,
        ) satisfies OrchestrationGetFullThreadDiffResult;
      }

      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    if (isCodexAppServerThread(String(input.threadId))) {
      return yield* new CheckpointRefUnavailableError({
        operation,
        threadId: input.threadId,
        turnCount: input.toTurnCount,
        checkpoint: "to",
      });
    }

    const workspaceCwd = threadContext.value.worktreePath ?? threadContext.value.workspaceRoot;
    if (!workspaceCwd) {
      return yield* new CheckpointWorkspacePathMissingError({
        operation,
        threadId: input.threadId,
      });
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
