import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildServerSettingsJsonSchema,
  getVersionedServerSettingsSchemaRelativePath,
  SERVER_SETTINGS_SCHEMA_RELATIVE_PATH,
  writeServerSettingsJsonSchemas,
} from "./server-settings-schema";

describe("buildServerSettingsJsonSchema", () => {
  it("builds a JSON schema document for settings.json", () => {
    const schema = buildServerSettingsJsonSchema();

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.title).toBe("T3 Code Server Settings");
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties).toMatchObject({
      enableAssistantStreaming: expect.any(Object),
      defaultThreadEnvMode: expect.any(Object),
      textGenerationModelSelection: expect.any(Object),
      providers: expect.any(Object),
    });
  });

  it("writes latest and versioned schema files", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "t3-server-settings-schema-"));

    try {
      const result = writeServerSettingsJsonSchemas({ rootDir, version: "1.2.3" });
      expect(result.changed).toBe(true);

      const latestSchema = JSON.parse(
        readFileSync(resolve(rootDir, SERVER_SETTINGS_SCHEMA_RELATIVE_PATH), "utf8"),
      ) as Record<string, unknown>;
      const versionedSchema = JSON.parse(
        readFileSync(
          resolve(rootDir, getVersionedServerSettingsSchemaRelativePath("1.2.3")),
          "utf8",
        ),
      ) as Record<string, unknown>;

      expect(latestSchema).toEqual(versionedSchema);
      expect(latestSchema.title).toBe("T3 Code Server Settings");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
