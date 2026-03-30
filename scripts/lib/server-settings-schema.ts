import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";

import { ServerSettings } from "@t3tools/contracts/settings";
import { toJsonSchemaObject } from "@t3tools/shared/schemaJson";

const JSON_SCHEMA_DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

export const SERVER_SETTINGS_SCHEMA_RELATIVE_PATH =
  "apps/marketing/public/schemas/server-settings.schema.json";
export const SERVER_SETTINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH =
  "apps/marketing/public/schemas/server-settings";

export const getVersionedServerSettingsSchemaRelativePath = (version: string) =>
  `${SERVER_SETTINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH}/${version}.schema.json`;

export function buildServerSettingsJsonSchema(): Record<string, unknown> {
  const schema = toJsonSchemaObject(ServerSettings);
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("ServerSettings JSON schema must be an object schema.");
  }

  return {
    $schema: JSON_SCHEMA_DRAFT_2020_12,
    title: "T3 Code Server Settings",
    description: "JSON Schema for the server-authoritative settings.json file consumed by T3 Code.",
    ...schema,
  };
}

function writeJsonFileIfChanged(filePath: string, document: Record<string, unknown>): boolean {
  const nextContent = `${JSON.stringify(document, null, 2)}\n`;
  const previousContent = (() => {
    try {
      return readFileSync(filePath, "utf8");
    } catch {
      return null;
    }
  })();

  if (previousContent === nextContent) {
    return false;
  }

  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, nextContent);
  return true;
}

export function writeServerSettingsJsonSchemas(options?: {
  readonly rootDir?: string;
  readonly version?: string;
}): {
  readonly changed: boolean;
} {
  const rootDir = resolve(options?.rootDir ?? process.cwd());
  const latestSchema = buildServerSettingsJsonSchema();
  let changed = writeJsonFileIfChanged(
    resolve(rootDir, SERVER_SETTINGS_SCHEMA_RELATIVE_PATH),
    latestSchema,
  );

  if (options?.version) {
    changed =
      writeJsonFileIfChanged(
        resolve(rootDir, getVersionedServerSettingsSchemaRelativePath(options.version)),
        latestSchema,
      ) || changed;
  }

  return { changed };
}
