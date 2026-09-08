import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  CheckpointDiffBlob,
  CheckpointDiffBlobRepository,
  DeleteCheckpointDiffBlobsAfterTurnInput,
  GetCheckpointDiffBlobInput,
  ListCheckpointDiffBlobsInput,
  type CheckpointDiffBlobRepositoryShape,
} from "../Services/CheckpointDiffBlobs.ts";

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

const makeCheckpointDiffBlobRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertBlob = SqlSchema.void({
    Request: CheckpointDiffBlob,
    execute: (row) =>
      sql`
        INSERT INTO checkpoint_diff_blobs (
          thread_id,
          from_turn_count,
          to_turn_count,
          diff,
          created_at,
          status
        )
        VALUES (
          ${row.threadId},
          ${row.fromTurnCount},
          ${row.toTurnCount},
          ${row.diff},
          ${row.createdAt},
          ${row.status}
        )
        ON CONFLICT (thread_id, from_turn_count, to_turn_count)
        DO UPDATE SET
          diff = CASE
            WHEN excluded.status = 'final' OR checkpoint_diff_blobs.status = 'preview'
              THEN excluded.diff
            ELSE checkpoint_diff_blobs.diff
          END,
          created_at = CASE
            WHEN excluded.status = 'final' OR checkpoint_diff_blobs.status = 'preview'
              THEN excluded.created_at
            ELSE checkpoint_diff_blobs.created_at
          END,
          status = CASE
            WHEN excluded.status = 'final' THEN 'final'
            ELSE checkpoint_diff_blobs.status
          END
      `,
  });

  const getBlob = SqlSchema.findOneOption({
    Request: GetCheckpointDiffBlobInput,
    Result: CheckpointDiffBlob,
    execute: ({ threadId, fromTurnCount, toTurnCount }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          from_turn_count AS "fromTurnCount",
          to_turn_count AS "toTurnCount",
          diff,
          created_at AS "createdAt",
          status
        FROM checkpoint_diff_blobs
        WHERE thread_id = ${threadId}
          AND from_turn_count = ${fromTurnCount}
          AND to_turn_count = ${toTurnCount}
      `,
  });

  const listBlobs = SqlSchema.findAll({
    Request: ListCheckpointDiffBlobsInput,
    Result: CheckpointDiffBlob,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          from_turn_count AS "fromTurnCount",
          to_turn_count AS "toTurnCount",
          diff,
          created_at AS "createdAt",
          status
        FROM checkpoint_diff_blobs
        WHERE thread_id = ${threadId}
        ORDER BY to_turn_count ASC
      `,
  });

  const deleteBlobsAfterTurn = SqlSchema.void({
    Request: DeleteCheckpointDiffBlobsAfterTurnInput,
    execute: ({ threadId, turnCount }) =>
      sql`
        DELETE FROM checkpoint_diff_blobs
        WHERE thread_id = ${threadId}
          AND to_turn_count > ${turnCount}
      `,
  });

  const upsert: CheckpointDiffBlobRepositoryShape["upsert"] = (row) =>
    upsertBlob(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "CheckpointDiffBlobRepository.upsert:query",
          "CheckpointDiffBlobRepository.upsert:encodeRequest",
        ),
      ),
    );

  const get: CheckpointDiffBlobRepositoryShape["get"] = (input) =>
    getBlob(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "CheckpointDiffBlobRepository.get:query",
          "CheckpointDiffBlobRepository.get:decodeRow",
        ),
      ),
      Effect.flatMap((row) =>
        Option.match(row, {
          onNone: () => Effect.succeed(Option.none()),
          onSome: (value) => Effect.succeed(Option.some(value)),
        }),
      ),
    );

  const listByThreadId: CheckpointDiffBlobRepositoryShape["listByThreadId"] = (input) =>
    listBlobs(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "CheckpointDiffBlobRepository.listByThreadId:query",
          "CheckpointDiffBlobRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const deleteAfterTurnCount: CheckpointDiffBlobRepositoryShape["deleteAfterTurnCount"] = (input) =>
    deleteBlobsAfterTurn(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "CheckpointDiffBlobRepository.deleteAfterTurnCount:query",
          "CheckpointDiffBlobRepository.deleteAfterTurnCount:encodeRequest",
        ),
      ),
    );

  return {
    upsert,
    get,
    listByThreadId,
    deleteAfterTurnCount,
  } satisfies CheckpointDiffBlobRepositoryShape;
});

export const CheckpointDiffBlobRepositoryLive = Layer.effect(
  CheckpointDiffBlobRepository,
  makeCheckpointDiffBlobRepository,
);
