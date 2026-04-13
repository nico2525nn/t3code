import type {
  ApprovalRequestId,
  OrchestrationProjectShell,
  OrchestrationThread,
  OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export interface ScopedMobileProject extends OrchestrationProjectShell {
  readonly environmentId: string;
  readonly environmentLabel: string;
}

/**
 * Thread shape used throughout the mobile UI.  Extends the lightweight shell
 * type with the full-detail fields the composer and detail screen expect.
 * The shell snapshot stubs these as empty arrays; `useThreadSelection`
 * overlays real data from the per-thread `subscribeThread` subscription
 * when a thread is selected.
 */
export interface ScopedMobileThread extends OrchestrationThreadShell {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly deletedAt: OrchestrationThread["deletedAt"];
  readonly messages: OrchestrationThread["messages"];
  readonly proposedPlans: OrchestrationThread["proposedPlans"];
  readonly activities: OrchestrationThread["activities"];
  readonly checkpoints: OrchestrationThread["checkpoints"];
}

export function scopedProjectKey(environmentId: string, projectId: ProjectId): string {
  return `${environmentId}:${projectId}`;
}

export function scopedThreadKey(environmentId: string, threadId: ThreadId): string {
  return `${environmentId}:${threadId}`;
}

export function scopedRequestKey(environmentId: string, requestId: ApprovalRequestId): string {
  return `${environmentId}:${requestId}`;
}
