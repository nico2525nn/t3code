import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An independent migration number is required: upstream already owns 059.
 * The mcp_app_model_context DDL also repairs databases that ran the old fork
 * migration numbered 059 and consequently skipped upstream's 059 on upgrade.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS mcp_app_model_context (
      thread_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      server TEXT NOT NULL,
      tool TEXT NOT NULL,
      text TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, item_id)
    )
  `;
  const table = "orchestration_v2_projection_provider_threads";
  const columns = yield* sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`;
  const existing = new Set(columns.map((row) => row.name));
  for (const column of ["driver", "provider_instance_id", "native_thread_id"] as const) {
    if (!existing.has(column)) {
      // Names are compile-time controlled; parameter binding isn't valid for identifiers.
      yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
    }
  }
  yield* sql`
    UPDATE orchestration_v2_projection_provider_threads
    SET driver = COALESCE(driver, json_extract(payload_json, '$.driver')),
        provider_instance_id = COALESCE(provider_instance_id, json_extract(payload_json, '$.providerInstanceId')),
        native_thread_id = COALESCE(native_thread_id, json_extract(payload_json, '$.nativeThreadRef.nativeId'))
    WHERE json_valid(payload_json)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_projection_provider_threads_native_identity
    ON orchestration_v2_projection_provider_threads(driver, provider_instance_id, native_thread_id)
  `;
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
