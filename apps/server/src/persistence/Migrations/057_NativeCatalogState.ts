import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Tracks how far the native conversation catalog has been imported for each
 * driver instance and archived split.
 *
 * `watermark` is a commit point, not a progress counter: every row at or newer
 * than it has been imported. It may only advance after a pass that reached it
 * or ran out of catalog, so a pass that stops at its page budget leaves it
 * alone and records `resume_cursor` instead. Re-reading after a crash is
 * harmless because imports are keyed by native identity; skipping rows is not.
 *
 * The split by `archived` is required because the provider lists the two sets
 * with separate queries and each has its own high-water mark.
 *
 * The second half promotes the native ref out of `payload_json` so a catalog
 * row can be matched to the app thread that already owns it. Without this, a
 * conversation T3 created itself would reappear from the native catalog as a
 * second app thread.
 */
const NativeCatalogState = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

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

  yield* sql`ALTER TABLE orchestration_v2_projection_provider_threads ADD COLUMN native_thread_id TEXT`;
  yield* sql`
    UPDATE orchestration_v2_projection_provider_threads
    SET native_thread_id = json_extract(payload_json, '$.nativeThreadRef.nativeId')
    WHERE native_thread_id IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_provider_threads_native_idx
    ON orchestration_v2_projection_provider_threads(driver, provider_instance_id, native_thread_id)
  `;
});

export default NativeCatalogState;
