/**
 * CheckpointDiffBlobRepository - Durable provider-native diffs.
 *
 * A provider can own a conversation history without creating Git refs in the
 * T3 workspace. These blobs let the checkpoint API expose that history through
 * the same turn-count contract used by normal filesystem checkpoints.
 */
import { IsoDateTime, NonNegativeInt, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const CheckpointDiffBlob = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
  diff: Schema.String,
  createdAt: IsoDateTime,
  status: Schema.Literals(["preview", "final"]),
});
export type CheckpointDiffBlob = typeof CheckpointDiffBlob.Type;

export const GetCheckpointDiffBlobInput = Schema.Struct({
  threadId: ThreadId,
  fromTurnCount: NonNegativeInt,
  toTurnCount: NonNegativeInt,
});
export type GetCheckpointDiffBlobInput = typeof GetCheckpointDiffBlobInput.Type;

export const ListCheckpointDiffBlobsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListCheckpointDiffBlobsInput = typeof ListCheckpointDiffBlobsInput.Type;

export const DeleteCheckpointDiffBlobsAfterTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnCount: NonNegativeInt,
});
export type DeleteCheckpointDiffBlobsAfterTurnInput =
  typeof DeleteCheckpointDiffBlobsAfterTurnInput.Type;

export interface CheckpointDiffBlobRepositoryShape {
  readonly upsert: (row: CheckpointDiffBlob) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly get: (
    input: GetCheckpointDiffBlobInput,
  ) => Effect.Effect<Option.Option<CheckpointDiffBlob>, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListCheckpointDiffBlobsInput,
  ) => Effect.Effect<ReadonlyArray<CheckpointDiffBlob>, ProjectionRepositoryError>;
  readonly deleteAfterTurnCount: (
    input: DeleteCheckpointDiffBlobsAfterTurnInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class CheckpointDiffBlobRepository extends Context.Service<
  CheckpointDiffBlobRepository,
  CheckpointDiffBlobRepositoryShape
>()("t3/persistence/Services/CheckpointDiffBlobs/CheckpointDiffBlobRepository") {}
