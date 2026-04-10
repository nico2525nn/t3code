import {
  type ClientSettings,
  type EnvironmentId,
  type PersistedSavedEnvironmentRecord,
} from "@t3tools/contracts";
import { ensureLocalApi } from "./localApi";
export {
  CLIENT_SETTINGS_STORAGE_KEY,
  SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
} from "./clientPersistenceStorage";

export async function readPersistedClientSettings(): Promise<ClientSettings | null> {
  return ensureLocalApi().persistence.getClientSettings();
}

export async function writePersistedClientSettings(settings: ClientSettings): Promise<void> {
  await ensureLocalApi().persistence.setClientSettings(settings);
}

export async function readPersistedSavedEnvironmentRegistry(): Promise<
  ReadonlyArray<PersistedSavedEnvironmentRecord>
> {
  return ensureLocalApi().persistence.getSavedEnvironmentRegistry();
}

export async function writePersistedSavedEnvironmentRegistry(
  records: ReadonlyArray<PersistedSavedEnvironmentRecord>,
): Promise<void> {
  await ensureLocalApi().persistence.setSavedEnvironmentRegistry(records);
}

export async function readPersistedSavedEnvironmentSecret(
  environmentId: EnvironmentId,
): Promise<string | null> {
  return ensureLocalApi().persistence.getSavedEnvironmentSecret(environmentId);
}

export async function writePersistedSavedEnvironmentSecret(
  environmentId: EnvironmentId,
  secret: string,
): Promise<boolean> {
  return ensureLocalApi().persistence.setSavedEnvironmentSecret(environmentId, secret);
}

export async function removePersistedSavedEnvironmentSecret(
  environmentId: EnvironmentId,
): Promise<void> {
  await ensureLocalApi().persistence.removeSavedEnvironmentSecret(environmentId);
}
