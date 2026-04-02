import { afterEach, describe, expect, it, vi } from "vitest";

import { percentile } from "../../../../test/perf/support/artifact";
import { installBrowserPerfCollector } from "../../../../test/perf/support/browserMetrics";

describe("percentile", () => {
  it("returns the minimum value for the zero percentile", () => {
    expect(percentile([9, 3, 6], 0)).toBe(3);
  });
});

describe("installBrowserPerfCollector", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels the previous animation frame loop before reset starts a new one", () => {
    let nextHandle = 1;
    const callbacks = new Map<number, FrameRequestCallback>();
    const requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    });
    const cancelAnimationFrame = vi.fn((handle: number) => {
      callbacks.delete(handle);
    });

    vi.stubGlobal("window", {
      requestAnimationFrame,
      cancelAnimationFrame,
    } as unknown as Window & typeof globalThis);
    vi.stubGlobal("document", {
      querySelectorAll: vi.fn(() => []),
    } as unknown as Document);
    vi.stubGlobal("PerformanceObserver", undefined);

    installBrowserPerfCollector();

    const collector = window.__t3PerfCollector;
    expect(collector).toBeDefined();
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    collector?.reset();
    expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);

    collector?.reset();
    expect(cancelAnimationFrame).toHaveBeenLastCalledWith(2);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(3);
  });
});
