import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** Preserve Codex's commentary/final-answer boundary in the durable message projection. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE projection_thread_messages ADD COLUMN phase TEXT`;
});
