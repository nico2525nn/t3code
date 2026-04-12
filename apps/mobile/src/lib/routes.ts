import type { Router } from "expo-router";

import type { SelectedThreadRef } from "../state/use-remote-app-state";
import type { ScopedMobileThread } from "./scopedEntities";

type ThreadRouteInput =
  | Pick<SelectedThreadRef, "environmentId" | "threadId">
  | Pick<ScopedMobileThread, "environmentId" | "id">;

export function buildThreadRoutePath(input: ThreadRouteInput): string {
  const environmentId = input.environmentId;
  const threadId = "threadId" in input ? input.threadId : input.id;

  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

export function dismissRoute(router: Router) {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace("/");
}
