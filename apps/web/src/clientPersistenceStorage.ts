import {
  ClientSettingsSchema,
  type ClientSettings,
  type EnvironmentId,
  type PersistedSavedEnvironmentRecord,
} from "@t3tools/contracts";
import { Predicate, Schema } from "effect";

export const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
export const SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY = "t3code:saved-environment-registry:v1";

interface BrowserSavedEnvironmentRecord extends PersistedSavedEnvironmentRecord {
  readonly bearerToken?: string;
}

interface BrowserSavedEnvironmentRegistryState {
  readonly byId?: Record<string, BrowserSavedEnvironmentRecord>;
  readonly secretsById?: Record<string, string>;
}

interface BrowserSavedEnvironmentRegistryDocument {
  readonly state?: BrowserSavedEnvironmentRegistryState;
  readonly version?: number;
}

const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const encodeClientSettings = Schema.encodeSync(Schema.fromJsonString(ClientSettingsSchema));

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

function readJson(rawValue: string | null): unknown {
  if (!rawValue) {
    return null;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return null;
  }
}

function isPersistedSavedEnvironmentRecord(
  value: unknown,
): value is PersistedSavedEnvironmentRecord & { readonly bearerToken?: unknown } {
  return (
    Predicate.isObject(value) &&
    typeof value.environmentId === "string" &&
    typeof value.label === "string" &&
    typeof value.httpBaseUrl === "string" &&
    typeof value.wsBaseUrl === "string" &&
    typeof value.createdAt === "string" &&
    (value.lastConnectedAt === null || typeof value.lastConnectedAt === "string")
  );
}

function normalizePersistedSavedEnvironmentRecord(
  value: unknown,
): PersistedSavedEnvironmentRecord | null {
  if (!isPersistedSavedEnvironmentRecord(value)) {
    return null;
  }

  return {
    environmentId: value.environmentId,
    label: value.label,
    httpBaseUrl: value.httpBaseUrl,
    wsBaseUrl: value.wsBaseUrl,
    createdAt: value.createdAt,
    lastConnectedAt: value.lastConnectedAt,
  };
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY);
    return raw ? decodeClientSettings(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.setItem(CLIENT_SETTINGS_STORAGE_KEY, encodeClientSettings(settings));
}

function readBrowserSavedEnvironmentRegistryDocument(): BrowserSavedEnvironmentRegistryDocument {
  if (!hasWindow()) {
    return {};
  }

  const raw = window.localStorage.getItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY);
  const parsed = readJson(raw);
  return Predicate.isObject(parsed) ? (parsed as BrowserSavedEnvironmentRegistryDocument) : {};
}

function writeBrowserSavedEnvironmentRegistryDocument(
  document: BrowserSavedEnvironmentRegistryDocument,
): void {
  if (!hasWindow()) {
    return;
  }

  window.localStorage.setItem(SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY, JSON.stringify(document));
}

function readBrowserSavedEnvironmentRecordsWithSecrets(): ReadonlyArray<BrowserSavedEnvironmentRecord> {
  const state = readBrowserSavedEnvironmentRegistryDocument().state;
  const byId = state?.byId ?? {};
  const secretsById = state?.secretsById ?? {};
  return Object.values(byId).flatMap((record) => {
    const normalizedRecord = normalizePersistedSavedEnvironmentRecord(record);
    if (!normalizedRecord) {
      return [];
    }

    const bearerToken =
      typeof secretsById[normalizedRecord.environmentId] === "string" &&
      secretsById[normalizedRecord.environmentId]
        ? secretsById[normalizedRecord.environmentId]
        : typeof record.bearerToken === "string" && record.bearerToken.length > 0
          ? record.bearerToken
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
  return readBrowserSavedEnvironmentRecordsWithSecrets().map((record) => ({
    environmentId: record.environmentId,
    label: record.label,
    httpBaseUrl: record.httpBaseUrl,
    wsBaseUrl: record.wsBaseUrl,
    createdAt: record.createdAt,
    lastConnectedAt: record.lastConnectedAt,
  }));
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

export function readBrowserSavedEnvironmentSecret(environmentId: EnvironmentId): string | null {
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
  environmentId: EnvironmentId,
  secret: string,
): boolean {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  const state = document.state ?? {};
  const byId = state.byId ?? {};
  const existingRecord = byId[environmentId];
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

export function removeBrowserSavedEnvironmentSecret(environmentId: EnvironmentId): void {
  const document = readBrowserSavedEnvironmentRegistryDocument();
  const state = document.state ?? {};
  const byId = { ...state.byId };
  const existingRecord = byId[environmentId];
  const nextById = existingRecord
    ? {
        ...byId,
        [environmentId]: {
          environmentId: existingRecord.environmentId,
          label: existingRecord.label,
          httpBaseUrl: existingRecord.httpBaseUrl,
          wsBaseUrl: existingRecord.wsBaseUrl,
          createdAt: existingRecord.createdAt,
          lastConnectedAt: existingRecord.lastConnectedAt,
        },
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
