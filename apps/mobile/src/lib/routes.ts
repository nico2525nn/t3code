import type { Router } from "expo-router";

import type { SelectedThreadRef } from "../state/use-remote-app-state";
import type { ScopedMobileProject, ScopedMobileThread } from "./scopedEntities";

type ThreadRouteInput =
  | Pick<SelectedThreadRef, "environmentId" | "threadId">
  | Pick<ScopedMobileThread, "environmentId" | "id">;

export function buildThreadRoutePath(input: ThreadRouteInput): string {
  const environmentId = input.environmentId;
  const threadId = "threadId" in input ? input.threadId : input.id;

  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

export function buildNewTaskDraftRoutePath(
  project: Pick<ScopedMobileProject, "environmentId" | "id">,
): string {
  const params = new URLSearchParams({
    environmentId: project.environmentId,
    projectId: project.id,
  });

  return `/new-draft?${params.toString()}`;
}

export function dismissRoute(router: Router) {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace("/");
}
