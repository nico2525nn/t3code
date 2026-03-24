import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN default_model_options_json TEXT
  `;

  yield* sql`
    UPDATE projection_projects
    SET default_model_options_json = NULL
    WHERE default_model_options_json IS NULL
  `;

  yield* sql`
    ALTER TABLE projection_threads
    ADD COLUMN model_options_json TEXT
  `;

  yield* sql`
    UPDATE projection_threads
    SET model_options_json = NULL
    WHERE model_options_json IS NULL
  `;
});
