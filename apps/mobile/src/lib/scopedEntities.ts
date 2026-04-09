import type {
  ApprovalRequestId,
  OrchestrationProject,
  OrchestrationThread,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

export interface ScopedMobileProject extends OrchestrationProject {
  readonly environmentId: string;
  readonly environmentLabel: string;
}

export interface ScopedMobileThread extends OrchestrationThread {
  readonly environmentId: string;
  readonly environmentLabel: string;
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
