import * as SecureStore from "expo-secure-store";

import type { SavedRemoteConnection } from "./connection";

const CONNECTIONS_KEY = "t3code:connections";

type SavedRemoteConnectionMetadata = Omit<SavedRemoteConnection, "bearerToken">;

async function readStorageItem(key: string): Promise<string | null> {
  return await SecureStore.getItemAsync(key);
}

async function writeStorageItem(key: string, value: string): Promise<void> {
  await SecureStore.setItemAsync(key, value);
}

async function removeStorageItem(key: string): Promise<void> {
  await SecureStore.deleteItemAsync(key);
}

function connectionTokenKey(environmentId: string): string {
  return `t3code:bearer-token:${environmentId}`;
}

async function loadSecureToken(environmentId: string): Promise<string> {
  return (await readStorageItem(connectionTokenKey(environmentId))) ?? "";
}

async function storeSecureToken(environmentId: string, token: string): Promise<void> {
  const tokenKey = connectionTokenKey(environmentId);
  if (token.trim().length === 0) {
    await removeStorageItem(tokenKey);
    return;
  }

  await writeStorageItem(tokenKey, token);
}

async function loadSavedConnectionMetadata(): Promise<
  ReadonlyArray<SavedRemoteConnectionMetadata>
> {
  const raw = (await readStorageItem(CONNECTIONS_KEY)) ?? "";
  if (!raw.trim()) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as {
      readonly connections?: ReadonlyArray<SavedRemoteConnectionMetadata>;
    };
    return parsed.connections ?? [];
  } catch {
    return [];
  }
}

async function saveSavedConnectionMetadata(
  connections: ReadonlyArray<SavedRemoteConnectionMetadata>,
): Promise<void> {
  await writeStorageItem(CONNECTIONS_KEY, JSON.stringify({ connections }));
}

export async function loadSavedConnections(): Promise<ReadonlyArray<SavedRemoteConnection>> {
  const metadata = await loadSavedConnectionMetadata();
  const resolved = await Promise.all(
    metadata.map(async (connection): Promise<SavedRemoteConnection | null> => {
      const bearerToken = (await loadSecureToken(connection.environmentId)).trim();
      if (!bearerToken) {
        return null;
      }

      return Object.assign({}, connection, {
        bearerToken,
      });
    }),
  );

  return resolved.filter((connection): connection is SavedRemoteConnection => connection !== null);
}

export async function saveConnection(connection: SavedRemoteConnection): Promise<void> {
  const current = await loadSavedConnectionMetadata();
  const nextConnection: SavedRemoteConnectionMetadata = {
    environmentId: connection.environmentId,
    environmentLabel: connection.environmentLabel,
    pairingUrl: connection.pairingUrl.trim(),
    displayUrl: connection.displayUrl.trim(),
    httpBaseUrl: connection.httpBaseUrl.trim(),
    wsBaseUrl: connection.wsBaseUrl.trim(),
  };
  const next = current.some((entry) => entry.environmentId === connection.environmentId)
    ? current.map((entry) =>
        entry.environmentId === connection.environmentId ? nextConnection : entry,
      )
    : [...current, nextConnection];

  await Promise.all([
    saveSavedConnectionMetadata(next),
    storeSecureToken(connection.environmentId, connection.bearerToken.trim()),
  ]);
}

export async function clearSavedConnection(environmentId: string): Promise<void> {
  const current = await loadSavedConnectionMetadata();
  await Promise.all([
    saveSavedConnectionMetadata(current.filter((entry) => entry.environmentId !== environmentId)),
    storeSecureToken(environmentId, ""),
  ]);
}
