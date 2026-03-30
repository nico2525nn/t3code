import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SERVER_SETTINGS_SCHEMA_RELATIVE_PATH,
  writeServerSettingsJsonSchemas,
} from "./lib/server-settings-schema.ts";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
writeServerSettingsJsonSchemas({ rootDir });

console.log(`Wrote ${SERVER_SETTINGS_SCHEMA_RELATIVE_PATH}`);
