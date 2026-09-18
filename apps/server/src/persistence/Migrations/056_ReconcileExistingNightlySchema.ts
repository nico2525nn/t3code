import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0050 from "./050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./051_ProjectionThreadMessageContext.ts";
import Migration0053 from "./053_PullRequestFilesViewed.ts";

/**
 * Released Nightly builds used migration ids 50–55 for a different set of
 * Codex/runtime repairs. A database can therefore report those ids while
 * still missing schemas introduced by the current migration files.
 *
 * Keep this repair idempotent and inspect the schema instead of trusting the
 * migration names: the same database may have been upgraded by either line.
 */
export default Effect.gen(function* () {
  yield* Migration0050;
  yield* Migration0051;

  const sql = yield* SqlClient.SqlClient;
  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!threadColumns.some((column) => column.name === "title_state_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN title_state_json TEXT
    `;
  }

  yield* Migration0053;
});
