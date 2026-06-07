import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mockBootstrapRemoteBearerSession = vi.hoisted(() => vi.fn());
const mockEnsureSavedEnvironmentConnection = vi.hoisted(() => vi.fn());
const mockFetchRemoteEnvironmentDescriptor = vi.hoisted(() => vi.fn());
const mockFetchRemoteSessionState = vi.hoisted(() => vi.fn());
const mockRemoteHttpRunPromise = vi.hoisted(() => vi.fn());
const mockRemoveSavedEnvironmentByInstance = vi.hoisted(() =>
  vi.fn(async (environmentId: EnvironmentId) => {
    const { useSavedEnvironmentRegistryStore, useSavedEnvironmentRuntimeStore } =
      await import("../runtime/catalog");
    useSavedEnvironmentRegistryStore.getState().remove(environmentId);
    useSavedEnvironmentRuntimeStore.getState().clear(environmentId);
  }),
);

vi.mock("@t3tools/client-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/client-runtime")>();
  return {
    ...actual,
    bootstrapRemoteBearerSession: mockBootstrapRemoteBearerSession,
    fetchRemoteEnvironmentDescriptor: mockFetchRemoteEnvironmentDescriptor,
    fetchRemoteSessionState: mockFetchRemoteSessionState,
  };
});

vi.mock("../../lib/runtime", () => ({
  remoteHttpRuntime: {
    runPromise: mockRemoteHttpRunPromise,
  },
}));

vi.mock("../../localApi", () => ({
  ensureLocalApi: () => ({
    persistence: {
      getSavedEnvironmentSecret: async () => null,
      setSavedEnvironmentRegistry: async () => undefined,
      setSavedEnvironmentSecret: async () => true,
      removeSavedEnvironmentSecret: async () => undefined,
    },
  }),
}));

vi.mock("../runtime/service", () => ({
  ensureSavedEnvironmentConnection: mockEnsureSavedEnvironmentConnection,
  removeSavedEnvironmentByInstance: mockRemoveSavedEnvironmentByInstance,
}));

describe("local secondary environment reconciliation", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.stubGlobal("window", {
      desktopBridge: {
        getLocalEnvironmentBootstraps: () => [
          {
            id: "primary",
            label: "Windows",
            httpBaseUrl: "http://127.0.0.1:3773",
            wsBaseUrl: "ws://127.0.0.1:3773",
            bootstrapToken: "primary-token",
          },
          {
            id: "wsl:ubuntu",
            label: "WSL (Ubuntu)",
            httpBaseUrl: "http://127.0.0.1:3774",
            wsBaseUrl: "ws://127.0.0.1:3774",
            bootstrapToken: "wsl-bootstrap-token",
          },
        ],
        getWslState: async () => ({
          enabled: true,
          distro: "Ubuntu",
          available: true,
          wslOnly: false,
          distros: [],
          preflightError: null,
        }),
      },
    });
    mockFetchRemoteEnvironmentDescriptor.mockImplementation(() => ({ _tag: "descriptor" }));
    mockBootstrapRemoteBearerSession.mockImplementation(() => ({ _tag: "bearer" }));
    mockFetchRemoteSessionState.mockImplementation(() => ({ _tag: "session" }));
    mockRemoteHttpRunPromise.mockImplementation(async (effect) => {
      const tag = (effect as { _tag?: string })._tag;
      if (tag === "descriptor") {
        return {
          environmentId: EnvironmentId.make("environment-wsl"),
          label: "WSL (Ubuntu)",
        };
      }
      if (tag === "bearer") {
        return {
          access_token: "wsl-bearer-token",
          scope: "orchestration:read access:write",
        };
      }
      if (tag === "session") {
        return {
          authenticated: false,
          scopes: null,
        };
      }
      throw new Error(`Unexpected remote effect: ${String(tag)}`);
    });
  });

  afterEach(async () => {
    const local = await import("./index");
    local.__resetLocalSecondaryReconcilerForTests();
    const catalog = await import("../runtime/catalog");
    catalog.resetSavedEnvironmentRegistryStoreForTests();
    catalog.resetSavedEnvironmentRuntimeStoreForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("removes the desktop-local record when the initial connection fails", async () => {
    mockEnsureSavedEnvironmentConnection.mockRejectedValueOnce(new Error("connect failed"));

    const local = await import("./index");
    const catalog = await import("../runtime/catalog");

    await local.reconcileLocalSecondaryEnvironments();

    expect(mockEnsureSavedEnvironmentConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        environmentId: EnvironmentId.make("environment-wsl"),
        desktopLocal: { instanceId: "wsl:ubuntu" },
      }),
      {
        bearerToken: "wsl-bearer-token",
        scopes: ["orchestration:read", "access:write"],
      },
    );
    expect(mockRemoveSavedEnvironmentByInstance).toHaveBeenCalledWith(
      EnvironmentId.make("environment-wsl"),
    );
    expect(
      catalog.useSavedEnvironmentRegistryStore.getState().byId[
        EnvironmentId.make("environment-wsl")
      ],
    ).toBeUndefined();
    expect(
      local.useLocalSecondaryReconcileStore.getState().registrationErrors["wsl:ubuntu"]?.message,
    ).toBe("connect failed");
  });
});
