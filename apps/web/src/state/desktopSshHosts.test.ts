import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AtomRegistry } from "effect/unstable/reactivity";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { describe, expect, it, vi } from "vite-plus/test";

import { createDesktopSshHostsStateAtom } from "./desktopSshHosts";

const hosts: ReadonlyArray<DesktopDiscoveredSshHost> = [
  {
    alias: "devbox",
    hostname: "devbox.local",
    port: null,
    source: "ssh-config",
    username: null,
  },
];

describe("desktopSshHostsState", () => {
  it("retains discovered hosts when the settings screen remounts", async () => {
    const discoverSshHosts = vi.fn(async () => hosts);
    const atom = createDesktopSshHostsStateAtom(() => ({ discoverSshHosts }));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some", value: hosts }),
      );
    });
    unmount();

    const remount = registry.mount(atom);
    expect(AsyncResult.value(registry.get(atom))).toEqual(
      expect.objectContaining({ _tag: "Some", value: hosts }),
    );
    expect(discoverSshHosts).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
  });

  it("distinguishes an unavailable desktop bridge", async () => {
    const atom = createDesktopSshHostsStateAtom(() => undefined);
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });

    const error = Option.getOrThrow(AsyncResult.error(registry.get(atom)));
    expect(error._tag).toBe("DesktopSshDiscoveryBridgeUnavailableError");
    expect(error.message).toBe("Desktop SSH host discovery is unavailable.");
    expect("cause" in error).toBe(false);

    unmount();
    registry.dispose();
  });

  it("preserves the exact SSH discovery failure cause", async () => {
    const cause = new Error("Could not parse Include directive");
    const discoverSshHosts = vi.fn(() => Promise.reject(cause));
    const atom = createDesktopSshHostsStateAtom(() => ({ discoverSshHosts }));
    const registry = AtomRegistry.make();
    const unmount = registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });

    const error = Option.getOrThrow(AsyncResult.error(registry.get(atom)));
    expect(error._tag).toBe("DesktopSshDiscoveryError");
    expect(error.message).toBe("Failed to discover SSH hosts.");
    expect(error.message).not.toContain(cause.message);
    expect("cause" in error ? error.cause : undefined).toBe(cause);
    expect(discoverSshHosts).toHaveBeenCalledTimes(1);

    unmount();
    registry.dispose();
  });
});
