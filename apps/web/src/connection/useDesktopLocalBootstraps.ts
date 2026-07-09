import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

function bootstrapsEqual(
  left: ReadonlyArray<DesktopEnvironmentBootstrap>,
  right: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.id === other.id &&
      entry.label === other.label &&
      entry.runningDistro === other.runningDistro &&
      entry.httpBaseUrl === other.httpBaseUrl &&
      entry.wsBaseUrl === other.wsBaseUrl &&
      entry.bootstrapToken === other.bootstrapToken
    );
  });
}

// One shared poller for all consumers (sidebar, command palette, ...): a single
// interval runs only while someone is subscribed, and listeners are notified
// only when the topology actually changed — each poll returns a fresh array,
// so publishing it unconditionally would re-render every consumer per tick.
const listeners = new Set<() => void>();
let currentSnapshot: ReadonlyArray<DesktopEnvironmentBootstrap> | null = null;
let pollInterval: ReturnType<typeof setInterval> | null = null;

function poll(): void {
  const next = readDesktopSecondaryBootstraps();
  if (currentSnapshot !== null && bootstrapsEqual(currentSnapshot, next)) {
    return;
  }
  currentSnapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (pollInterval === null) {
    poll();
    pollInterval = setInterval(poll, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };
}

function getSnapshot(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  // First read happens during render, before subscribe() has polled.
  currentSnapshot ??= readDesktopSecondaryBootstraps();
  return currentSnapshot;
}

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). The bridge exposes no change event, so we re-read on an interval;
 * failed reads retain the latest successful snapshot, while a successful empty
 * read clears it. Use this instead of polling the bridge ad hoc so every
 * renderer consumer reads the same topology.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
