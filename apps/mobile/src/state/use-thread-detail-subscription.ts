import { useEffect } from "react";

import { applyThreadDetailEvent } from "@t3tools/client-runtime";
import { ThreadId } from "@t3tools/contracts";

import { scopedThreadKey } from "../lib/scopedEntities";
import { remoteEnvironmentStore } from "./remote-environment-store";
import { getEnvironmentClient } from "./use-remote-environment-registry";

/**
 * Subscribe to full thread detail (messages, activities, checkpoints, etc.)
 * for the given environment + thread.  The subscription is torn down when the
 * component unmounts or the identifiers change.
 *
 * Received snapshots and incremental events are written into
 * `remoteEnvironmentStore.threadDetailByKey` so that `useThreadSelection` can
 * merge them over the shell stubs.
 */
export function useThreadDetailSubscription(
  environmentId: string | null,
  threadId: string | null,
): void {
  useEffect(() => {
    if (!environmentId || !threadId) {
      return;
    }

    const brandedThreadId = ThreadId.make(threadId);
    const key = scopedThreadKey(environmentId, brandedThreadId);
    let unsubscribe: (() => void) | null = null;
    let disposed = false;

    function attach() {
      if (disposed) {
        return;
      }

      const client = getEnvironmentClient(environmentId!);
      if (!client) {
        return;
      }

      unsubscribe = client.orchestration.subscribeThread({ threadId: brandedThreadId }, (item) => {
        if (disposed) {
          return;
        }

        const store = remoteEnvironmentStore.getState();

        if (item.kind === "snapshot") {
          store.setThreadDetail(key, item.snapshot.thread);
          return;
        }

        const current = store.threadDetailByKey[key];
        if (!current) {
          return;
        }

        const result = applyThreadDetailEvent(current, item.event);
        if (result.kind === "updated") {
          store.setThreadDetail(key, result.thread);
        } else if (result.kind === "deleted") {
          store.removeThreadDetail(key);
        }
      });
    }

    attach();

    // If the client isn't available yet (still connecting), retry when the
    // connection state changes via a simple polling interval that clears once
    // attached.  This avoids coupling to the connection listener API.
    let retryTimer: ReturnType<typeof setInterval> | null = null;
    if (!unsubscribe) {
      retryTimer = setInterval(() => {
        if (disposed) {
          if (retryTimer) clearInterval(retryTimer);
          return;
        }
        if (unsubscribe) {
          if (retryTimer) clearInterval(retryTimer);
          return;
        }
        attach();
        if (unsubscribe && retryTimer) {
          clearInterval(retryTimer);
          retryTimer = null;
        }
      }, 500);
    }

    return () => {
      disposed = true;
      if (retryTimer) clearInterval(retryTimer);
      unsubscribe?.();
      remoteEnvironmentStore.getState().removeThreadDetail(key);
    };
  }, [environmentId, threadId]);
}
