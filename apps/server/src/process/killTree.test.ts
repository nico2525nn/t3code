import { describe, expect, it, vi } from "vitest";

import { killChildProcessTree } from "./killTree";

describe("killChildProcessTree", () => {
  it("uses taskkill on Windows when a pid is available", () => {
    const kill = vi.fn();
    const spawnSyncImpl = vi.fn();

    killChildProcessTree({ pid: 123, kill } as never, "SIGTERM", {
      platform: "win32",
      spawnSyncImpl,
    });

    expect(spawnSyncImpl).toHaveBeenCalledWith("taskkill", ["/pid", "123", "/T", "/F"], {
      stdio: "ignore",
    });
    expect(kill).not.toHaveBeenCalled();
  });

  it("falls back to direct kill when taskkill fails", () => {
    const kill = vi.fn();
    const spawnSyncImpl = vi.fn(() => {
      throw new Error("taskkill unavailable");
    });

    killChildProcessTree({ pid: 456, kill } as never, "SIGKILL", {
      platform: "win32",
      spawnSyncImpl,
    });

    expect(kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("kills directly on non-Windows platforms", () => {
    const kill = vi.fn();
    const spawnSyncImpl = vi.fn();

    killChildProcessTree({ pid: 789, kill } as never, "SIGTERM", {
      platform: "darwin",
      spawnSyncImpl,
    });

    expect(spawnSyncImpl).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
});
