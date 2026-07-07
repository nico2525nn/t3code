import { useEffect } from "react";
import { Platform } from "react-native";

import { useProjects, useThreadShells } from "../../state/entities";
import NewThreadWidget from "../../widgets/NewThread";
import { makeNewThreadWidgetProps } from "./new-thread-widget";

// Last payload written to the widget timeline. Module-level (not React state)
// so navigator remounts don't rewrite an unchanged payload: every write ends
// in a WidgetCenter reload, and iOS throttles widgets that reload too often.
let lastSyncedSignature: string | null = null;

/**
 * Keeps the NewThread home-screen widget's project shortcuts in sync with the
 * workspace. Writing the snapshot also persists the widget layout to the
 * shared app group, which is what lets the widget render at all — so this
 * must run on every launch, not only when projects change.
 */
export function useNewThreadWidgetSync(): void {
  const projects = useProjects();
  const threads = useThreadShells();

  useEffect(() => {
    if (Platform.OS !== "ios") {
      return;
    }
    const props = makeNewThreadWidgetProps(projects, threads);
    const signature = JSON.stringify(props);
    if (signature === lastSyncedSignature) {
      return;
    }
    lastSyncedSignature = signature;
    try {
      NewThreadWidget.updateSnapshot(props);
    } catch (error) {
      // Clear the signature so the next data change retries the write.
      lastSyncedSignature = null;
      if (__DEV__) {
        console.warn("[new-thread-widget] snapshot update failed", error);
      }
    }
  }, [projects, threads]);
}
