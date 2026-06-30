import { type EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { AppNavigation } from "../navigation/app-navigation";
import type { AppNavigationTarget } from "../navigation/route-model";
import type { SelectedThreadRef } from "../state/remote-runtime-types";

type Router = AppNavigation;

type ThreadRouteInput =
  | Pick<SelectedThreadRef, "environmentId" | "threadId">
  | Pick<EnvironmentThreadShell, "environmentId" | "id">;
type PlainThreadRouteInput =
  | {
      environmentId: EnvironmentId;
      threadId: ThreadId;
    }
  | {
      environmentId: EnvironmentId;
      id: ThreadId;
    };

export function buildThreadRoutePath(input: ThreadRouteInput | PlainThreadRouteInput): string {
  const environmentId = input.environmentId;
  const threadId = "threadId" in input ? input.threadId : input.id;

  return `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
}

export function buildThreadReviewRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
): string {
  return `${buildThreadRoutePath(input)}/review`;
}

export function buildThreadFilesRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
  relativePath?: string | null,
  line?: number | null,
): string {
  const basePath = `${buildThreadRoutePath(input)}/files`;
  if (!relativePath) {
    return basePath;
  }

  const pathSegments = relativePath.split("/").filter((segment) => segment.length > 0);
  if (pathSegments.length === 0) {
    return basePath;
  }

  const encodedPath = pathSegments.map(encodeURIComponent).join("/");
  const lineParam =
    Number.isFinite(line) && Number(line) > 0 ? `?line=${Math.floor(Number(line))}` : "";
  return `${basePath}/${encodedPath}${lineParam}`;
}

export function buildThreadTerminalRoutePath(
  input: ThreadRouteInput | PlainThreadRouteInput,
  terminalId?: string | null,
): string {
  const basePath = `${buildThreadRoutePath(input)}/terminal`;
  if (!terminalId) {
    return basePath;
  }

  return `${basePath}?terminalId=${encodeURIComponent(terminalId)}`;
}

export function buildThreadTerminalNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
  terminalId?: string | null,
): AppNavigationTarget {
  const environmentId = String(input.environmentId);
  const threadId = String("threadId" in input ? input.threadId : input.id);

  const params: { environmentId: string; threadId: string; terminalId?: string } = {
    environmentId,
    threadId,
  };

  if (terminalId != null && terminalId !== "") {
    params.terminalId = terminalId;
  }

  return {
    name: "ThreadTerminal",
    params,
  };
}

export function buildThreadFilesNavigation(
  input: ThreadRouteInput | PlainThreadRouteInput,
  relativePath?: string | null,
  line?: number | null,
): AppNavigationTarget {
  const environmentId = String(input.environmentId);
  const threadId = String("threadId" in input ? input.threadId : input.id);
  const path = relativePath?.split("/").filter((segment) => segment.length > 0) ?? [];

  if (path.length === 0) {
    return {
      name: "ThreadFiles",
      params: { environmentId, threadId },
    };
  }

  const params: {
    environmentId: string;
    threadId: string;
    path: string[];
    line?: string;
  } = { environmentId, threadId, path };
  if (Number.isFinite(line) && Number(line) > 0) {
    params.line = String(Math.floor(Number(line)));
  }

  return {
    name: "ThreadFile",
    params,
  };
}

export function dismissRoute(router: Router) {
  if (router.canGoBack()) {
    router.back();
    return;
  }

  router.replace("/");
}
