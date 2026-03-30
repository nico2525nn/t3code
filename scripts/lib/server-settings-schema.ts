import { ServerSettings } from "@t3tools/contracts/settings";
import { buildJsonSchemaDocument, writeJsonSchemaArtifacts } from "./json-schema";

export const SERVER_SETTINGS_SCHEMA_RELATIVE_PATH =
  "apps/marketing/public/schemas/server-settings.schema.json";
export const SERVER_SETTINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH =
  "apps/marketing/public/schemas/server-settings";

export const getVersionedServerSettingsSchemaRelativePath = (version: string) =>
  `${SERVER_SETTINGS_VERSIONED_SCHEMA_DIRECTORY_RELATIVE_PATH}/${version}.schema.json`;

export function buildServerSettingsJsonSchema(): Record<string, unknown> {
  return buildJsonSchemaDocument(ServerSettings, {
    title: "T3 Code Server Settings",
    description: "JSON Schema for the server-authoritative settings.json file consumed by T3 Code.",
  });
}

export function writeServerSettingsJsonSchemas(options?: {
  readonly rootDir?: string;
  readonly version?: string;
}): {
  readonly changed: boolean;
} {
  return writeJsonSchemaArtifacts({
    latestRelativePath: SERVER_SETTINGS_SCHEMA_RELATIVE_PATH,
    getVersionedRelativePath: getVersionedServerSettingsSchemaRelativePath,
    document: buildServerSettingsJsonSchema(),
    ...(options?.rootDir === undefined ? {} : { rootDir: options.rootDir }),
    ...(options?.version === undefined ? {} : { version: options.version }),
  });
}
