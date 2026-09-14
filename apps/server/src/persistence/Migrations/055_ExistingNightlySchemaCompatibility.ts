import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0050 from "./050_ProjectionThreadPullRequests.ts";

/**
 * The released Nightly line used migration ids 50–54 for Codex repairs and
 * message phases. This branch deliberately removed those migrations, so an
 * existing Nightly database can report a newer migration id while still
 * missing the schemas introduced by this branch's migrations 050 and 051.
 * Re-run the idempotent schema work under a fresh id instead of mutating the
 * live database out of band.
 */
export default Effect.gen(function* () {
  yield* Migration0050;

  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_messages)
  `;

  if (!columns.some((column) => column.name === "context_json")) {
    yield* sql`
      ALTER TABLE projection_thread_messages
      ADD COLUMN context_json TEXT
    `;
  }
});
