import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_provider TEXT
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_provider = CASE
      WHEN default_model IS NULL THEN NULL
      ELSE 'codex'
    END
    WHERE default_provider IS NULL
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN provider TEXT
  `;

  yield* sql`
    UPDATE projection_threads
    SET provider = COALESCE(
      (
        SELECT provider_name
        FROM projection_thread_sessions
        WHERE projection_thread_sessions.thread_id = projection_threads.thread_id
      ),
      'codex'
    )
    WHERE provider IS NULL
  `;
});
