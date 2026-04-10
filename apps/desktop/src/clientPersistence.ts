import * as FS from "node:fs";
import * as Path from "node:path";

import type { ClientSettings, PersistedSavedEnvironmentRecord } from "@t3tools/contracts";
import { Predicate } from "effect";

interface ClientSettingsDocument {
  readonly settings: ClientSettings;
}

interface PersistedSavedEnvironmentStorageRecord extends PersistedSavedEnvironmentRecord {
  readonly encryptedBearerToken?: string;
}

interface SavedEnvironmentRegistryDocument {
  readonly records: readonly PersistedSavedEnvironmentStorageRecord[];
  readonly encryptedBearerTokenById: Readonly<Record<string, string>>;
}

export interface DesktopSecretStorage {
  readonly isEncryptionAvailable: () => boolean;
  readonly encryptString: (value: string) => Buffer;
  readonly decryptString: (value: Buffer) => string;
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    if (!FS.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(FS.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeJsonFile(filePath: string, value: unknown): void {
  const directory = Path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  FS.mkdirSync(directory, { recursive: true });
  FS.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  FS.renameSync(tempPath, filePath);
}

function isPersistedSavedEnvironmentStorageRecord(
  value: unknown,
): value is PersistedSavedEnvironmentStorageRecord {
  return (
    Predicate.isObject(value) &&
    typeof value.environmentId === "string" &&
    typeof value.label === "string" &&
    typeof value.httpBaseUrl === "string" &&
    typeof value.wsBaseUrl === "string" &&
    typeof value.createdAt === "string" &&
    (value.lastConnectedAt === null || typeof value.lastConnectedAt === "string") &&
    (value.encryptedBearerToken === undefined || typeof value.encryptedBearerToken === "string")
  );
}

function readSavedEnvironmentRegistryDocument(filePath: string): SavedEnvironmentRegistryDocument {
  const parsed = readJsonFile<SavedEnvironmentRegistryDocument>(filePath);
  if (!Predicate.isObject(parsed)) {
    return { records: [], encryptedBearerTokenById: {} };
  }

  const records = Array.isArray(parsed.records)
    ? parsed.records.filter(isPersistedSavedEnvironmentStorageRecord)
    : [];
  const encryptedBearerTokenById = Predicate.isObject(parsed.encryptedBearerTokenById)
    ? Object.fromEntries(
        Object.entries(parsed.encryptedBearerTokenById).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : {};

  return {
    records,
    encryptedBearerTokenById,
  };
}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentStorageRecord,
): PersistedSavedEnvironmentRecord {
  return {
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  };
}

export function readClientSettings(settingsPath: string): ClientSettings | null {
  return readJsonFile<ClientSettingsDocument>(settingsPath)?.settings ?? null;
}

export function writeClientSettings(settingsPath: string, settings: ClientSettings): void {
  writeJsonFile(settingsPath, { settings } satisfies ClientSettingsDocument);
}

export function readSavedEnvironmentRegistry(
  registryPath: string,
): readonly PersistedSavedEnvironmentRecord[] {
  return readSavedEnvironmentRegistryDocument(registryPath).records.map((record) =>
    toPersistedSavedEnvironmentRecord(record),
  );
}

export function writeSavedEnvironmentRegistry(
  registryPath: string,
  records: readonly PersistedSavedEnvironmentRecord[],
): void {
  const currentDocument = readSavedEnvironmentRegistryDocument(registryPath);
  const encryptedBearerTokenById = currentDocument.encryptedBearerTokenById;
  writeJsonFile(registryPath, {
    records,
    encryptedBearerTokenById,
  } satisfies SavedEnvironmentRegistryDocument);
}

export function readSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
  readonly secretStorage: DesktopSecretStorage;
}): string | null {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);
  const encoded = document.encryptedBearerTokenById[input.environmentId];
  if (!encoded) {
    return null;
  }

  if (!input.secretStorage.isEncryptionAvailable()) {
    return null;
  }

  try {
    return input.secretStorage.decryptString(Buffer.from(encoded, "base64"));
  } catch {
    return null;
  }
}

export function writeSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
  readonly secret: string;
  readonly secretStorage: DesktopSecretStorage;
}): boolean {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);

  if (!input.secretStorage.isEncryptionAvailable()) {
    return false;
  }

  writeJsonFile(input.registryPath, {
    records: document.records.map((record) => toPersistedSavedEnvironmentRecord(record)),
    encryptedBearerTokenById: {
      ...document.encryptedBearerTokenById,
      [input.environmentId]: input.secretStorage.encryptString(input.secret).toString("base64"),
    },
  } satisfies SavedEnvironmentRegistryDocument);
  return true;
}

export function removeSavedEnvironmentSecret(input: {
  readonly registryPath: string;
  readonly environmentId: string;
}): void {
  const document = readSavedEnvironmentRegistryDocument(input.registryPath);
  if (!(input.environmentId in document.encryptedBearerTokenById)) {
    return;
  }

  const { [input.environmentId]: _removed, ...remaining } = document.encryptedBearerTokenById;
  writeJsonFile(input.registryPath, {
    records: document.records.map((record) => toPersistedSavedEnvironmentRecord(record)),
    encryptedBearerTokenById: remaining,
  } satisfies SavedEnvironmentRegistryDocument);
}
