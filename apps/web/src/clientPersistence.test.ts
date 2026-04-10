import { EnvironmentId, type ClientSettings, type LocalApi } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_SETTINGS_STORAGE_KEY,
  readPersistedClientSettings,
  readPersistedSavedEnvironmentSecret,
  writePersistedClientSettings,
  writePersistedSavedEnvironmentRegistry,
  writePersistedSavedEnvironmentSecret,
} from "./clientPersistence";
import {
  readBrowserClientSettings,
  readBrowserSavedEnvironmentRegistry,
  readBrowserSavedEnvironmentSecret,
  removeBrowserSavedEnvironmentSecret,
  writeBrowserClientSettings,
  writeBrowserSavedEnvironmentRegistry,
  writeBrowserSavedEnvironmentSecret,
} from "./clientPersistenceStorage";

const testEnvironmentId = EnvironmentId.makeUnsafe("environment-1");

const clientSettings: ClientSettings = {
  confirmThreadArchive: true,
  confirmThreadDelete: false,
  diffWordWrap: true,
  sidebarProjectSortOrder: "manual",
  sidebarThreadSortOrder: "created_at",
  timestampFormat: "24-hour",
};

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
    location: {
      origin: "http://localhost:3000",
    },
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

function installBrowserPersistenceApi(windowForTest: Window & typeof globalThis): void {
  windowForTest.nativeApi = {
    persistence: {
      getClientSettings: async () => readBrowserClientSettings(),
      setClientSettings: async (settings: ClientSettings) => {
        writeBrowserClientSettings(settings);
      },
      getSavedEnvironmentRegistry: async () => readBrowserSavedEnvironmentRegistry(),
      setSavedEnvironmentRegistry: async (
        records: Awaited<ReturnType<LocalApi["persistence"]["getSavedEnvironmentRegistry"]>>,
      ) => {
        writeBrowserSavedEnvironmentRegistry(records);
      },
      getSavedEnvironmentSecret: async (
        environmentId: Parameters<LocalApi["persistence"]["getSavedEnvironmentSecret"]>[0],
      ) => readBrowserSavedEnvironmentSecret(environmentId),
      setSavedEnvironmentSecret: async (
        environmentId: Parameters<LocalApi["persistence"]["setSavedEnvironmentSecret"]>[0],
        secret: Parameters<LocalApi["persistence"]["setSavedEnvironmentSecret"]>[1],
      ) => writeBrowserSavedEnvironmentSecret(environmentId, secret),
      removeSavedEnvironmentSecret: async (
        environmentId: Parameters<LocalApi["persistence"]["removeSavedEnvironmentSecret"]>[0],
      ) => {
        removeBrowserSavedEnvironmentSecret(environmentId);
      },
    },
  } as unknown as LocalApi;
}

afterEach(async () => {
  const { __resetLocalApiForTests } = await import("./localApi");
  await __resetLocalApiForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function resetLocalApiForTest(): Promise<void> {
  const { __resetLocalApiForTests } = await import("./localApi");
  await __resetLocalApiForTests();
}

describe("clientPersistence", () => {
  it("reads and writes client settings in browser storage mode", async () => {
    const testWindow = getTestWindow();
    installBrowserPersistenceApi(testWindow);
    await resetLocalApiForTest();

    await writePersistedClientSettings(clientSettings);

    await expect(readPersistedClientSettings()).resolves.toEqual(clientSettings);
  });

  it("reads saved environment bearer tokens from browser storage mode", async () => {
    const testWindow = getTestWindow();
    installBrowserPersistenceApi(testWindow);
    await resetLocalApiForTest();
    writeBrowserSavedEnvironmentRegistry([
      {
        environmentId: testEnvironmentId,
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ]);
    writeBrowserSavedEnvironmentSecret(testEnvironmentId, "bearer-token");

    await expect(readPersistedSavedEnvironmentSecret(testEnvironmentId)).resolves.toBe(
      "bearer-token",
    );
  });

  it("preserves browser-mode secrets when the secret is written before metadata", async () => {
    const testWindow = getTestWindow();
    installBrowserPersistenceApi(testWindow);
    await resetLocalApiForTest();

    await writePersistedSavedEnvironmentSecret(testEnvironmentId, "bearer-token");
    await writePersistedSavedEnvironmentRegistry([
      {
        environmentId: testEnvironmentId,
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: null,
      },
    ]);

    await expect(readPersistedSavedEnvironmentSecret(testEnvironmentId)).resolves.toBe(
      "bearer-token",
    );
  });

  it("can read client settings through the desktop bridge", async () => {
    const testWindow = getTestWindow();
    testWindow.nativeApi = {
      persistence: {
        getClientSettings: async () => clientSettings,
        setClientSettings: async () => undefined,
        getSavedEnvironmentRegistry: async () => [],
        setSavedEnvironmentRegistry: async () => undefined,
        getSavedEnvironmentSecret: async () => null,
        setSavedEnvironmentSecret: async () => true,
        removeSavedEnvironmentSecret: async () => undefined,
      },
    } as unknown as LocalApi;
    await resetLocalApiForTest();

    await expect(readPersistedClientSettings()).resolves.toEqual(clientSettings);
    expect(testWindow.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)).toBeNull();
  });
});
