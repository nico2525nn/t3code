import { Platform } from "react-native";

import type { SavedRemoteConnection } from "./connection";

const CONNECTIONS_KEY = "t3remote:connections";
const memoryStorage = new Map<string, string>();

type AsyncStorageModule = typeof import("@react-native-async-storage/async-storage");
type AsyncStorageLike = Pick<AsyncStorageModule["default"], "getItem" | "setItem" | "removeItem">;
type SecureStoreModule = typeof import("expo-secure-store");
type SavedRemoteConnectionMetadata = Omit<SavedRemoteConnection, "bearerToken">;

let asyncStoragePromise: Promise<AsyncStorageLike | null> | null = null;
let secureStorePromise: Promise<SecureStoreModule | null> | null = null;

async function loadAsyncStorage(): Promise<AsyncStorageLike | null> {
  if (!asyncStoragePromise) {
    asyncStoragePromise = import("@react-native-async-storage/async-storage")
      .then((module) => module.default)
      .catch(() => null);
  }

  return await asyncStoragePromise;
}

async function loadSecureStore(): Promise<SecureStoreModule | null> {
  if (Platform.OS === "web") {
    return null;
  }

  if (!secureStorePromise) {
    secureStorePromise = import("expo-secure-store").catch(() => null);
  }

  return await secureStorePromise;
}

async function readFallbackItem(key: string): Promise<string | null> {
  return memoryStorage.get(key) ?? null;
}

async function writeFallbackItem(key: string, value: string): Promise<void> {
  memoryStorage.set(key, value);
}

async function removeFallbackItem(key: string): Promise<void> {
  memoryStorage.delete(key);
}

async function readStorageItem(key: string): Promise<string | null> {
  const asyncStorage = await loadAsyncStorage();
  if (!asyncStorage) {
    return await readFallbackItem(key);
  }

  try {
    return await asyncStorage.getItem(key);
  } catch {
    return await readFallbackItem(key);
  }
}

async function writeStorageItem(key: string, value: string): Promise<void> {
  const asyncStorage = await loadAsyncStorage();
  if (!asyncStorage) {
    await writeFallbackItem(key, value);
    return;
  }

  try {
    await asyncStorage.setItem(key, value);
  } catch {
    await writeFallbackItem(key, value);
  }
}

async function removeStorageItem(key: string): Promise<void> {
  const asyncStorage = await loadAsyncStorage();
  if (!asyncStorage) {
    await removeFallbackItem(key);
    return;
  }

  try {
    await asyncStorage.removeItem(key);
  } catch {
    await removeFallbackItem(key);
  }
}

function connectionTokenKey(environmentId: string): string {
  return `t3remote:bearer-token:${environmentId}`;
}

async function loadSecureToken(environmentId: string): Promise<string> {
  const tokenKey = connectionTokenKey(environmentId);
  if (Platform.OS === "web") {
    return (await readStorageItem(tokenKey)) ?? "";
  }

  const secureStore = await loadSecureStore();
  try {
    if (secureStore) {
      return (await secureStore.getItemAsync(tokenKey)) ?? "";
    }
  } catch {
    // Fall through to async storage.
  }

  return (await readStorageItem(tokenKey)) ?? "";
}

async function storeSecureToken(environmentId: string, token: string): Promise<void> {
  const tokenKey = connectionTokenKey(environmentId);
  if (token.trim().length === 0) {
    if (Platform.OS === "web") {
      await removeStorageItem(tokenKey);
      return;
    }

    const secureStore = await loadSecureStore();
    try {
      await secureStore?.deleteItemAsync(tokenKey);
    } catch {
      // Ignore secure store cleanup failures and clear fallback storage.
    }
    await removeStorageItem(tokenKey);
    return;
  }

  if (Platform.OS === "web") {
    await writeStorageItem(tokenKey, token);
    return;
  }

  const secureStore = await loadSecureStore();
  try {
    if (secureStore) {
      await secureStore.setItemAsync(tokenKey, token);
      return;
    }
  } catch {
    // Fall through to async storage fallback.
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
