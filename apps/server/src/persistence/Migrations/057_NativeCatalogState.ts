import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Tracks how far the native conversation catalog has been imported for each
 * driver instance and archived split.
 *
 * The watermark is the provider's own `updatedAt` clock, never T3's, so an
 * unchanged catalog costs one page per pass instead of a full walk. Splitting
 * by `archived` is required because the provider lists the two sets with
 * separate queries and each has its own high-water mark.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_native_catalog_state (
      driver TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      archived INTEGER NOT NULL,
      watermark TEXT,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      PRIMARY KEY (driver, provider_instance_id, archived)
    )
  `;
});
