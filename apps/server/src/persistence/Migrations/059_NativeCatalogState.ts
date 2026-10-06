import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The native catalog sync matches provider conversations by native identity.
  // The columns live in payload_json today; promoting them keeps the lookup
  // indexed instead of a scan over every provider thread.
  yield* sql`
    ALTER TABLE orchestration_v2_projection_provider_threads
    ADD COLUMN driver TEXT
  `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<never>));
  yield* sql`
    ALTER TABLE orchestration_v2_projection_provider_threads
    ADD COLUMN provider_instance_id TEXT
  `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<never>));
  yield* sql`
    ALTER TABLE orchestration_v2_projection_provider_threads
    ADD COLUMN native_thread_id TEXT
  `.pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<never>));

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_provider_threads_native_identity
    ON orchestration_v2_projection_provider_threads(driver, provider_instance_id, native_thread_id)
  `;

  // Watermarks per catalog partition: one row per driver/instance/archive side.
  yield* sql`
    CREATE TABLE IF NOT EXISTS orchestration_v2_native_catalog_state (
      driver TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      archived INTEGER NOT NULL,
      watermark TEXT,
      resume_cursor TEXT,
      updated_at TEXT NOT NULL,
      last_error TEXT,
      PRIMARY KEY (driver, provider_instance_id, archived)
    )
  `;
});
