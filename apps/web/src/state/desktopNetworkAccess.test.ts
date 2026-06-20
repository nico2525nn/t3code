import type { AdvertisedEndpoint, DesktopServerExposureState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createDesktopNetworkAccessStateAtom,
  DesktopNetworkAccessLoadError,
  DesktopNetworkAccessUnavailableError,
} from "./desktopNetworkAccess";

const serverExposureState: DesktopServerExposureState = {
  advertisedHost: "192.168.1.10",
  endpointUrl: "http://192.168.1.10:37737",
  mode: "network-accessible",
  tailscaleServeEnabled: false,
  tailscaleServePort: 443,
};

const advertisedEndpoints: ReadonlyArray<AdvertisedEndpoint> = [];
const isDesktopNetworkAccessLoadError = Schema.is(DesktopNetworkAccessLoadError);

describe("desktopNetworkAccessState", () => {
  it("retains the loaded snapshot when the settings screen remounts", async () => {
    const getServerExposureState = vi.fn(async () => serverExposureState);
    const getAdvertisedEndpoints = vi.fn(async () => advertisedEndpoints);
    const atom = createDesktopNetworkAccessStateAtom(() => ({
      getAdvertisedEndpoints,
      getServerExposureState,
    }));
    const registry = AtomRegistry.make();

    const unmount = registry.mount(atom);
    await vi.waitFor(() => {
      expect(AsyncResult.value(registry.get(atom))).toEqual(
        expect.objectContaining({ _tag: "Some" }),
      );
    });
    unmount();

    const remount = registry.mount(atom);
    const result = registry.get(atom);
    expect(AsyncResult.value(result)).toEqual(
      expect.objectContaining({
        _tag: "Some",
        value: { advertisedEndpoints, serverExposureState },
      }),
    );
    expect(getServerExposureState).toHaveBeenCalledTimes(1);
    expect(getAdvertisedEndpoints).toHaveBeenCalledTimes(1);

    remount();
    registry.dispose();
  });

  it("reports an unavailable desktop bridge without inventing a cause", async () => {
    const atom = createDesktopNetworkAccessStateAtom(() => undefined);
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) {
      throw new Error("Expected desktop network access to fail");
    }
    const error = Cause.squash(result.cause);

    expect(error).toBeInstanceOf(DesktopNetworkAccessUnavailableError);
    expect(error).toMatchObject({
      _tag: "DesktopNetworkAccessUnavailableError",
      message: "Desktop network access is unavailable.",
    });

    registry.dispose();
  });

  it("retains the failing bridge operation and cause", async () => {
    const cause = new Error("native bridge rejected");
    const atom = createDesktopNetworkAccessStateAtom(() => ({
      getAdvertisedEndpoints: () => Promise.reject(cause),
      getServerExposureState: () => Promise.resolve(serverExposureState),
    }));
    const registry = AtomRegistry.make();
    registry.mount(atom);

    await vi.waitFor(() => {
      expect(AsyncResult.isFailure(registry.get(atom))).toBe(true);
    });
    const result = registry.get(atom);
    if (!AsyncResult.isFailure(result)) {
      throw new Error("Expected desktop network access to fail");
    }
    const error = Cause.squash(result.cause);
    if (!isDesktopNetworkAccessLoadError(error)) {
      throw error;
    }

    expect(error).toMatchObject({
      operation: "get-advertised-endpoints",
      message: "Desktop network access operation 'get advertised endpoints' failed.",
    });
    expect(error.cause).toBe(cause);

    registry.dispose();
  });
});
