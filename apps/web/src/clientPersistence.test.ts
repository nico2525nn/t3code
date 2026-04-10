import { EnvironmentId, type ClientSettings, type DesktopBridge } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CLIENT_SETTINGS_STORAGE_KEY,
  SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
  migrateBrowserSavedEnvironmentRegistryToDesktopPersistence,
  readPersistedClientSettings,
  readPersistedSavedEnvironmentSecret,
  writePersistedClientSettings,
  writePersistedSavedEnvironmentRegistry,
  writePersistedSavedEnvironmentSecret,
} from "./clientPersistence";

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
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("clientPersistence", () => {
  it("reads and writes client settings in browser storage mode", async () => {
    getTestWindow();

    await writePersistedClientSettings(clientSettings);

    await expect(readPersistedClientSettings()).resolves.toEqual(clientSettings);
  });

  it("reads saved environment bearer tokens from browser storage mode", async () => {
    const testWindow = getTestWindow();
    testWindow.localStorage.setItem(
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          byId: {
            [testEnvironmentId]: {
              environmentId: testEnvironmentId,
              label: "Remote environment",
              httpBaseUrl: "https://remote.example.com/",
              wsBaseUrl: "wss://remote.example.com/",
              bearerToken: "bearer-token",
              createdAt: "2026-04-09T00:00:00.000Z",
              lastConnectedAt: null,
            },
          },
        },
      }),
    );

    await expect(readPersistedSavedEnvironmentSecret(testEnvironmentId)).resolves.toBe(
      "bearer-token",
    );
  });

  it("preserves browser-mode secrets when the secret is written before metadata", async () => {
    getTestWindow();

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

  it("migrates saved environment metadata and tokens into desktop persistence", async () => {
    const testWindow = getTestWindow();
    const setSavedEnvironmentRegistry = vi.fn().mockResolvedValue(undefined);
    const setSavedEnvironmentSecret = vi.fn().mockResolvedValue(true);

    testWindow.localStorage.setItem(
      SAVED_ENVIRONMENT_REGISTRY_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          byId: {
            [testEnvironmentId]: {
              environmentId: testEnvironmentId,
              label: "Remote environment",
              httpBaseUrl: "https://remote.example.com/",
              wsBaseUrl: "wss://remote.example.com/",
              bearerToken: "bearer-token",
              createdAt: "2026-04-09T00:00:00.000Z",
              lastConnectedAt: "2026-04-09T01:00:00.000Z",
            },
          },
        },
      }),
    );

    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => null,
      getClientSettings: async () => null,
      setClientSettings: async () => undefined,
      getSavedEnvironmentRegistry: async () => [],
      setSavedEnvironmentRegistry,
      getSavedEnvironmentSecret: async () => null,
      setSavedEnvironmentSecret,
      removeSavedEnvironmentSecret: async () => undefined,
      getServerExposureState: async () => ({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
      }),
      setServerExposureMode: async () => ({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
      }),
      pickFolder: async () => null,
      confirm: async () => true,
      setTheme: async () => undefined,
      showContextMenu: async () => null,
      openExternal: async () => true,
      onMenuAction: () => () => undefined,
      getUpdateState: async () => {
        throw new Error("not implemented");
      },
      checkForUpdate: async () => {
        throw new Error("not implemented");
      },
      downloadUpdate: async () => {
        throw new Error("not implemented");
      },
      installUpdate: async () => {
        throw new Error("not implemented");
      },
      onUpdateState: () => () => undefined,
    } satisfies DesktopBridge;

    await expect(migrateBrowserSavedEnvironmentRegistryToDesktopPersistence()).resolves.toEqual([
      {
        environmentId: testEnvironmentId,
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: "2026-04-09T01:00:00.000Z",
      },
    ]);

    expect(setSavedEnvironmentRegistry).toHaveBeenCalledWith([
      {
        environmentId: testEnvironmentId,
        label: "Remote environment",
        httpBaseUrl: "https://remote.example.com/",
        wsBaseUrl: "wss://remote.example.com/",
        createdAt: "2026-04-09T00:00:00.000Z",
        lastConnectedAt: "2026-04-09T01:00:00.000Z",
      },
    ]);
    expect(setSavedEnvironmentSecret).toHaveBeenCalledWith(testEnvironmentId, "bearer-token");
  });

  it("can read client settings through the desktop bridge", async () => {
    const testWindow = getTestWindow();
    testWindow.desktopBridge = {
      getLocalEnvironmentBootstrap: () => null,
      getClientSettings: async () => clientSettings,
      setClientSettings: async () => undefined,
      getSavedEnvironmentRegistry: async () => [],
      setSavedEnvironmentRegistry: async () => undefined,
      getSavedEnvironmentSecret: async () => null,
      setSavedEnvironmentSecret: async () => true,
      removeSavedEnvironmentSecret: async () => undefined,
      getServerExposureState: async () => ({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
      }),
      setServerExposureMode: async () => ({
        mode: "local-only",
        endpointUrl: null,
        advertisedHost: null,
      }),
      pickFolder: async () => null,
      confirm: async () => true,
      setTheme: async () => undefined,
      showContextMenu: async () => null,
      openExternal: async () => true,
      onMenuAction: () => () => undefined,
      getUpdateState: async () => {
        throw new Error("not implemented");
      },
      checkForUpdate: async () => {
        throw new Error("not implemented");
      },
      downloadUpdate: async () => {
        throw new Error("not implemented");
      },
      installUpdate: async () => {
        throw new Error("not implemented");
      },
      onUpdateState: () => () => undefined,
    } satisfies DesktopBridge;

    await expect(readPersistedClientSettings()).resolves.toEqual(clientSettings);
    expect(testWindow.localStorage.getItem(CLIENT_SETTINGS_STORAGE_KEY)).toBeNull();
  });
});
