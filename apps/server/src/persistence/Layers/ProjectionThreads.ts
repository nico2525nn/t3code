import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { ModelSelection } from "@t3tools/contracts";
import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadInput,
  GetProjectionThreadInput,
  ListProjectionThreadsByProjectInput,
  ProjectionThread,
  ProjectionThreadRepository,
  type ProjectionThreadRepositoryShape,
} from "../Services/ProjectionThreads.ts";

const ProjectionThreadDbRow = Schema.Struct({
  threadId: ProjectionThread.fields.threadId,
  projectId: ProjectionThread.fields.projectId,
  title: ProjectionThread.fields.title,
  provider: Schema.Literals(["codex", "claudeAgent"]),
  model: Schema.String,
  modelOptions: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  runtimeMode: ProjectionThread.fields.runtimeMode,
  interactionMode: ProjectionThread.fields.interactionMode,
  branch: ProjectionThread.fields.branch,
  worktreePath: ProjectionThread.fields.worktreePath,
  latestTurnId: ProjectionThread.fields.latestTurnId,
  createdAt: ProjectionThread.fields.createdAt,
  updatedAt: ProjectionThread.fields.updatedAt,
  deletedAt: ProjectionThread.fields.deletedAt,
});
type ProjectionThreadDbRow = typeof ProjectionThreadDbRow.Type;

const decodeModelSelectionSync = Schema.decodeUnknownSync(ModelSelection);

function decodeProjectionThread(row: ProjectionThreadDbRow) {
  return Effect.try({
    try: () => ({
      threadId: row.threadId,
      projectId: row.projectId,
      title: row.title,
      modelSelection: decodeModelSelectionSync({
        provider: row.provider,
        model: row.model,
        ...(row.modelOptions !== null ? { options: row.modelOptions } : {}),
      }),
      runtimeMode: row.runtimeMode,
      interactionMode: row.interactionMode,
      branch: row.branch,
      worktreePath: row.worktreePath,
      latestTurnId: row.latestTurnId,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      deletedAt: row.deletedAt,
    }),
    catch: (error) =>
      toPersistenceDecodeError("ProjectionThreadRepository.decodeProjectionThread")(
        error as Schema.SchemaError,
      ),
  });
}

const makeProjectionThreadRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadRow = SqlSchema.void({
    Request: ProjectionThread,
    execute: (row) =>
      sql`
        INSERT INTO projection_threads (
          thread_id,
          project_id,
          title,
          provider,
          model,
          model_options_json,
          runtime_mode,
          interaction_mode,
          branch,
          worktree_path,
          latest_turn_id,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.threadId},
          ${row.projectId},
          ${row.title},
          ${row.modelSelection.provider},
          ${row.modelSelection.model},
          ${JSON.stringify(row.modelSelection.options ?? null)},
          ${row.runtimeMode},
          ${row.interactionMode},
          ${row.branch},
          ${row.worktreePath},
          ${row.latestTurnId},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          project_id = excluded.project_id,
          title = excluded.title,
          provider = excluded.provider,
          model = excluded.model,
          model_options_json = excluded.model_options_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          branch = excluded.branch,
          worktree_path = excluded.worktree_path,
          latest_turn_id = excluded.latest_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionThreadRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadInput,
    Result: ProjectionThreadDbRow,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          provider,
          model,
          model_options_json AS "modelOptions",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionThreadRows = SqlSchema.findAll({
    Request: ListProjectionThreadsByProjectInput,
    Result: ProjectionThreadDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          project_id AS "projectId",
          title,
          provider,
          model,
          model_options_json AS "modelOptions",
          runtime_mode AS "runtimeMode",
          interaction_mode AS "interactionMode",
          branch,
          worktree_path AS "worktreePath",
          latest_turn_id AS "latestTurnId",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_threads
        WHERE project_id = ${projectId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const deleteProjectionThreadRow = SqlSchema.void({
    Request: DeleteProjectionThreadInput,
    execute: ({ threadId }) =>
      sql`
        DELETE FROM projection_threads
        WHERE thread_id = ${threadId}
      `,
  });

  const upsert: ProjectionThreadRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.upsert:query")),
    );

  const getById: ProjectionThreadRepositoryShape["getById"] = (input) =>
    getProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.getById:query")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) => decodeProjectionThread(row).pipe(Effect.map(Option.some)),
        }),
      ),
    );

  const listByProjectId: ProjectionThreadRepositoryShape["listByProjectId"] = (input) =>
    listProjectionThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.listByProjectId:query")),
      Effect.flatMap((rows) => Effect.forEach(rows, decodeProjectionThread)),
    );

  const deleteById: ProjectionThreadRepositoryShape["deleteById"] = (input) =>
    deleteProjectionThreadRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listByProjectId,
    deleteById,
  } satisfies ProjectionThreadRepositoryShape;
});

export const ProjectionThreadRepositoryLive = Layer.effect(
  ProjectionThreadRepository,
  makeProjectionThreadRepository,
);
