import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "pinned_at")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN pinned_at TEXT
    `;
  }

  yield* sql`
    UPDATE projection_projects
    SET pinned_at = CASE WHEN pinned != 0 THEN updated_at ELSE NULL END
    WHERE pinned_at IS NULL
  `;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "pinned_at")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN pinned_at TEXT
    `;
  }

  yield* sql`
    UPDATE projection_threads
    SET pinned_at = CASE WHEN pinned != 0 THEN updated_at ELSE NULL END
    WHERE pinned_at IS NULL
  `;
});
