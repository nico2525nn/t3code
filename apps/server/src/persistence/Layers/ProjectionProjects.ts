import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { Effect, Layer, Option, Schema } from "effect";

import { ModelSelection, ProjectScript } from "@t3tools/contracts";
import {
  PersistenceDecodeError,
  toPersistenceDecodeError,
  toPersistenceSqlError,
} from "../Errors.ts";
import {
  DeleteProjectionProjectInput,
  GetProjectionProjectInput,
  ProjectionProject,
  ProjectionProjectRepository,
  type ProjectionProjectRepositoryShape,
} from "../Services/ProjectionProjects.ts";

const ProjectionProjectDbRow = Schema.Struct({
  projectId: ProjectionProject.fields.projectId,
  title: ProjectionProject.fields.title,
  workspaceRoot: ProjectionProject.fields.workspaceRoot,
  defaultProvider: Schema.NullOr(Schema.Literals(["codex", "claudeAgent"])),
  defaultModel: Schema.NullOr(Schema.String),
  defaultModelOptions: Schema.NullOr(Schema.fromJsonString(Schema.Unknown)),
  scripts: Schema.fromJsonString(Schema.Array(ProjectScript)),
  createdAt: ProjectionProject.fields.createdAt,
  updatedAt: ProjectionProject.fields.updatedAt,
  deletedAt: ProjectionProject.fields.deletedAt,
});
type ProjectionProjectDbRow = typeof ProjectionProjectDbRow.Type;

const decodeModelSelectionSync = Schema.decodeUnknownSync(ModelSelection);

function decodeDefaultModelSelection(
  row: ProjectionProjectDbRow,
): Effect.Effect<ProjectionProject["defaultModelSelection"], PersistenceDecodeError> {
  if (row.defaultProvider === null || row.defaultModel === null) {
    return Effect.succeed(null);
  }
  return Effect.try({
    try: () =>
      decodeModelSelectionSync({
        provider: row.defaultProvider,
        model: row.defaultModel,
        ...(row.defaultModelOptions !== null ? { options: row.defaultModelOptions } : {}),
      }),
    catch: (error) =>
      toPersistenceDecodeError("ProjectionProjectRepository.decodeDefaultModelSelection")(
        error as Schema.SchemaError,
      ),
  });
}

const makeProjectionProjectRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionProjectRow = SqlSchema.void({
    Request: ProjectionProject,
    execute: (row) =>
      sql`
        INSERT INTO projection_projects (
          project_id,
          title,
          workspace_root,
          default_provider,
          default_model,
          default_model_options_json,
          scripts_json,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.projectId},
          ${row.title},
          ${row.workspaceRoot},
          ${row.defaultModelSelection?.provider ?? null},
          ${row.defaultModelSelection?.model ?? null},
          ${JSON.stringify(row.defaultModelSelection?.options ?? null)},
          ${JSON.stringify(row.scripts)},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (project_id)
        DO UPDATE SET
          title = excluded.title,
          workspace_root = excluded.workspace_root,
          default_provider = excluded.default_provider,
          default_model = excluded.default_model,
          default_model_options_json = excluded.default_model_options_json,
          scripts_json = excluded.scripts_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const getProjectionProjectRow = SqlSchema.findOneOption({
    Request: GetProjectionProjectInput,
    Result: ProjectionProjectDbRow,
    execute: ({ projectId }) =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_provider AS "defaultProvider",
          default_model AS "defaultModel",
          default_model_options_json AS "defaultModelOptions",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const listProjectionProjectRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ProjectionProjectDbRow,
    execute: () =>
      sql`
        SELECT
          project_id AS "projectId",
          title,
          workspace_root AS "workspaceRoot",
          default_provider AS "defaultProvider",
          default_model AS "defaultModel",
          default_model_options_json AS "defaultModelOptions",
          scripts_json AS "scripts",
          created_at AS "createdAt",
          updated_at AS "updatedAt",
          deleted_at AS "deletedAt"
        FROM projection_projects
        ORDER BY created_at ASC, project_id ASC
      `,
  });

  const deleteProjectionProjectRow = SqlSchema.void({
    Request: DeleteProjectionProjectInput,
    execute: ({ projectId }) =>
      sql`
        DELETE FROM projection_projects
        WHERE project_id = ${projectId}
      `,
  });

  const upsert: ProjectionProjectRepositoryShape["upsert"] = (row) =>
    upsertProjectionProjectRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.upsert:query")),
    );

  const getById: ProjectionProjectRepositoryShape["getById"] = (input) =>
    getProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.getById:query")),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none()),
          onSome: (row) =>
            decodeDefaultModelSelection(row).pipe(
              Effect.map((defaultModelSelection) =>
                Option.some({
                  projectId: row.projectId,
                  title: row.title,
                  workspaceRoot: row.workspaceRoot,
                  defaultModelSelection,
                  scripts: row.scripts,
                  createdAt: row.createdAt,
                  updatedAt: row.updatedAt,
                  deletedAt: row.deletedAt,
                }),
              ),
            ),
        }),
      ),
    );

  const listAll: ProjectionProjectRepositoryShape["listAll"] = () =>
    listProjectionProjectRows().pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.listAll:query")),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeDefaultModelSelection(row).pipe(
            Effect.map((defaultModelSelection) => ({
              projectId: row.projectId,
              title: row.title,
              workspaceRoot: row.workspaceRoot,
              defaultModelSelection,
              scripts: row.scripts,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              deletedAt: row.deletedAt,
            })),
          ),
        ),
      ),
    );

  const deleteById: ProjectionProjectRepositoryShape["deleteById"] = (input) =>
    deleteProjectionProjectRow(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionProjectRepository.deleteById:query")),
    );

  return {
    upsert,
    getById,
    listAll,
    deleteById,
  } satisfies ProjectionProjectRepositoryShape;
});

export const ProjectionProjectRepositoryLive = Layer.effect(
  ProjectionProjectRepository,
  makeProjectionProjectRepository,
);
