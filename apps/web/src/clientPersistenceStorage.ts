import {
  ClientSettingsSchema,
  type ClientSettings,
  EnvironmentId,
  type EnvironmentId as EnvironmentIdValue,
  type PersistedSavedEnvironmentRecord,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

export const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
export const SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY = "t3code:saved-environment-registry:v1";

interface BrowserSavedEnvironmentRecord extends PersistedSavedEnvironmentRecord {
  readonly bearerToken?: string;
}

interface BrowserSavedEnvironmentRegistryState {
  readonly byId?: Record<string, unknown>;
  readonly secretsById?: Record<string, string>;
}

interface BrowserSavedEnvironmentRegistryDocument {
  readonly state?: BrowserSavedEnvironmentRegistryState;
  readonly version?: number;
}

const BrowserSavedEnvironmentRecordSchema = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  httpBaseUrl: Schema.String,
  wsBaseUrl: Schema.String,
  createdAt: Schema.String,
  lastConnectedAt: Schema.NullOr(Schema.String),
  bearerToken: Schema.optionalKey(Schema.String),
});

const BrowserSavedEnvironmentRegistryDocumentSchema = Schema.Struct({
  version: Schema.optionalKey(Schema.Number),
  state: Schema.optionalKey(
    Schema.Struct({
      byId: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
      secretsById: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});

const decodeBrowserSavedEnvironmentRecord = Schema.decodeUnknownSync(
  BrowserSavedEnvironmentRecordSchema,
);

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function normalizeBrowserSavedEnvironmentRecord(
  value: unknown,
): BrowserSavedEnvironmentRecord | null {
  try {
    return decodeBrowserSavedEnvironmentRecord(value);
  } catch {
    return null;
  }
}

function toPersistedSavedEnvironmentRecord(
  record: PersistedSavedEnvironmentRecord,
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

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, ClientSettingsSchema);
  } catch {
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}

function readBrowserSavedEnvironmentRegistryDocument(): BrowserSavedEnvironmentRegistryDocument {
  if (!hasWindow()) {
    return {};
  }

  try {
    return (
      getLocalStorageItem(
        SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
        BrowserSavedEnvironmentRegistryDocumentSchema,
      ) ?? {}
    );
  } catch {
    return {};
  }
}

function writeBrowserSavedEnvironmentRegistryDocument(
  document: BrowserSavedEnvironmentRegistryDocument,
): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(
    SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
    document,
    BrowserSavedEnvironmentRegistryDocumentSchema,
  );
}

function readBrowserSavedEnvironmentRecordsWithSecrets(): ReadonlyArray<BrowserSavedEnvironmentRecord> {
  const state = readBrowserSavedEnvironmentRegistryDocument().state;
  const byId = state?.byId ?? {};
  const secretsById = state?.secretsById ?? {};
  return Object.values(byId).flatMap((record) => {
    const normalizedRecord = normalizeBrowserSavedEnvironmentRecord(record);
    if (!normalizedRecord) {
      return [];
    }

    const bearerToken =
      typeof secretsById[normalizedRecord.environmentId] === "string" &&
      secretsById[normalizedRecord.environmentId]
        ? secretsById[normalizedRecord.environmentId]
        : typeof normalizedRecord.bearerToken === "string" &&
            normalizedRecord.bearerToken.length > 0
          ? normalizedRecord.bearerToken
          : null;

    return [
      {
        ...normalizedRecord,
        ...(bearerToken ? { bearerToken } : {}),
      } satisfies BrowserSavedEnvironmentRecord,
    ];
  });
}

function writeBrowserSavedEnvironmentRecords(
  records: ReadonlyArray<BrowserSavedEnvironmentRecord>,
): void {
  writeBrowserSavedEnvironmentRegistryDocument({
    version: 1,
    state: {
      byId: Object.fromEntries(records.map((record) => [record.environmentId, record])),
      secretsById: Object.fromEntries(
        records.flatMap((record) =>
          record.bearerToken ? [[record.environmentId, record.bearerToken] as const] : [],
        ),
      ),
    },
  });
}

export function readBrowserSavedEnvironmentRegistry(): ReadonlyArray<PersistedSavedEnvironmentRecord> {
  return readBrowserSavedEnvironmentRecordsWithSecrets().map((record) =>
    toPersistedSavedEnvironmentRecord(record),
  );
}

export function writeBrowserSavedEnvironmentRegistry(
  records: ReadonlyArray<PersistedSavedEnvironmentRecord>,
): void {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  const directSecretsById = document.state?.secretsById ?? {};
  const existing = new Map(
    readBrowserSavedEnvironmentRecordsWithSecrets().map(
      (record) => [record.environmentId, record] as const,
    ),
  );
  writeBrowserSavedEnvironmentRecords(
    records.map((record) => ({
      ...record,
      ...((existing.get(record.environmentId)?.bearerToken ??
      directSecretsById[record.environmentId])
        ? {
            bearerToken:
              existing.get(record.environmentId)?.bearerToken ??
              directSecretsById[record.environmentId],
          }
        : {}),
    })),
  );
}

export function readBrowserSavedEnvironmentSecret(
  environmentId: EnvironmentIdValue,
): string | null {
  const state = readBrowserSavedEnvironmentRegistryDocument().state;
  const directSecret = state?.secretsById?.[environmentId];
  if (typeof directSecret === "string" && directSecret.length > 0) {
    return directSecret;
  }

  return (
    readBrowserSavedEnvironmentRecordsWithSecrets().find(
      (record) => record.environmentId === environmentId,
    )?.bearerToken ?? null
  );
}

export function writeBrowserSavedEnvironmentSecret(
  environmentId: EnvironmentIdValue,
  secret: string,
): boolean {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  const state = document.state ?? {};
  const byId = state.byId ?? {};
  const existingRecord = normalizeBrowserSavedEnvironmentRecord(byId[environmentId]);
  writeBrowserSavedEnvironmentRegistryDocument({
    version: document.version ?? 1,
    state: {
      byId: existingRecord
        ? {
            ...byId,
            [environmentId]: {
              ...existingRecord,
              bearerToken: secret,
            },
          }
        : byId,
      secretsById: {
        ...state.secretsById,
        [environmentId]: secret,
      },
    },
  });
  return true;
}

export function removeBrowserSavedEnvironmentSecret(environmentId: EnvironmentIdValue): void {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  const state = document.state ?? {};
  const byId = { ...state.byId };
  const existingRecord = normalizeBrowserSavedEnvironmentRecord(byId[environmentId]);
  const nextById = existingRecord
    ? {
        ...byId,
        [environmentId]: toPersistedSavedEnvironmentRecord(existingRecord),
      }
    : byId;
  const { [environmentId]: _removed, ...remainingSecrets } = state.secretsById ?? {};

  writeBrowserSavedEnvironmentRegistryDocument({
    version: document.version ?? 1,
    state: {
      byId: nextById,
      secretsById: remainingSecrets,
    },
  });
}
