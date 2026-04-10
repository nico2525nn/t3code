import type { RepositoryIdentity } from "@t3tools/contracts";

import { sortCopy } from "./arrayCompat";
import type { ScopedMobileProject, ScopedMobileThread } from "./scopedEntities";
import { scopedProjectKey } from "./scopedEntities";

export interface MobileRepositoryProjectGroup {
  readonly key: string;
  readonly project: ScopedMobileProject;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
  readonly latestActivityAt: string;
}

export interface MobileRepositoryGroup {
  readonly key: string;
  readonly title: string;
  readonly subtitle: string | null;
  readonly repositoryIdentity: RepositoryIdentity | null;
  readonly projectCount: number;
  readonly threadCount: number;
  readonly latestActivityAt: string;
  readonly projects: ReadonlyArray<MobileRepositoryProjectGroup>;
}

function compareIsoDateDescending(left: string, right: string): number {
  return new Date(right).getTime() - new Date(left).getTime();
}

function deriveRepositoryGroupKey(project: ScopedMobileProject): string {
  return (
    project.repositoryIdentity?.canonicalKey ?? scopedProjectKey(project.environmentId, project.id)
  );
}

function deriveRepositoryTitle(project: ScopedMobileProject): string {
  const identity = project.repositoryIdentity;
  return identity?.displayName ?? identity?.name ?? project.title;
}

function deriveRepositorySubtitle(identity: RepositoryIdentity | null | undefined): string | null {
  if (!identity) {
    return null;
  }
  if (identity.owner && identity.name) {
    return `${identity.owner}/${identity.name}`;
  }
  return identity.canonicalKey;
}

function deriveProjectLatestActivity(
  project: ScopedMobileProject,
  threads: ReadonlyArray<ScopedMobileThread>,
): string {
  const latestThread = threads[0];
  return latestThread?.updatedAt ?? latestThread?.createdAt ?? project.updatedAt;
}

export function groupProjectsByRepository(input: {
  readonly projects: ReadonlyArray<ScopedMobileProject>;
  readonly threads: ReadonlyArray<ScopedMobileThread>;
}): ReadonlyArray<MobileRepositoryGroup> {
  const threadsByProjectKey = new Map<string, ScopedMobileThread[]>();

  for (const thread of input.threads) {
    const key = scopedProjectKey(thread.environmentId, thread.projectId);
    const existing = threadsByProjectKey.get(key);
    if (existing) {
      existing.push(thread);
    } else {
      threadsByProjectKey.set(key, [thread]);
    }
  }

  const grouped = new Map<string, MobileRepositoryGroup>();

  for (const project of input.projects) {
    const key = deriveRepositoryGroupKey(project);
    const projectKey = scopedProjectKey(project.environmentId, project.id);
    const threads = sortCopy(threadsByProjectKey.get(projectKey) ?? [], (left, right) =>
      compareIsoDateDescending(
        left.updatedAt ?? left.createdAt,
        right.updatedAt ?? right.createdAt,
      ),
    );
    const latestActivityAt = deriveProjectLatestActivity(project, threads);
    const projectGroup: MobileRepositoryProjectGroup = {
      key: projectKey,
      project,
      threads,
      latestActivityAt,
    };

    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        key,
        title: deriveRepositoryTitle(project),
        subtitle: deriveRepositorySubtitle(project.repositoryIdentity),
        repositoryIdentity: project.repositoryIdentity ?? null,
        projectCount: 1,
        threadCount: threads.length,
        latestActivityAt,
        projects: [projectGroup],
      });
      continue;
    }

    grouped.set(key, {
      ...existing,
      title: existing.repositoryIdentity ? existing.title : deriveRepositoryTitle(project),
      subtitle: existing.subtitle ?? deriveRepositorySubtitle(project.repositoryIdentity),
      repositoryIdentity: existing.repositoryIdentity ?? project.repositoryIdentity ?? null,
      projectCount: existing.projectCount + 1,
      threadCount: existing.threadCount + threads.length,
      latestActivityAt:
        compareIsoDateDescending(existing.latestActivityAt, latestActivityAt) > 0
          ? latestActivityAt
          : existing.latestActivityAt,
      projects: sortCopy(
        [...existing.projects, projectGroup],
        (left, right) =>
          compareIsoDateDescending(left.latestActivityAt, right.latestActivityAt) ||
          left.project.environmentLabel.localeCompare(right.project.environmentLabel) ||
          left.project.title.localeCompare(right.project.title),
      ),
    });
  }

  return sortCopy(
    [...grouped.values()],
    (left, right) =>
      compareIsoDateDescending(left.latestActivityAt, right.latestActivityAt) ||
      left.title.localeCompare(right.title),
  );
}
