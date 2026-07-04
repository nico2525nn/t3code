import {
  deriveLogicalProjectKey,
  deriveProjectGroupLabel,
} from "@t3tools/client-runtime/state/project-grouping";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { getThreadSortTimestamp, sortThreads } from "@t3tools/client-runtime/state/thread-sort";
import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarProjectSortOrder,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { scopedProjectKey } from "../../lib/scopedEntities";

export type HomeProjectSortOrder = Exclude<SidebarProjectSortOrder, "manual">;

/**
 * Default home view only surfaces threads active within this window, to keep the
 * screen compact while keeping recent work visible.
 */
const RECENT_THREAD_WINDOW_MS = 5 * 24 * 60 * 60 * 1000;
/** Fallback when a project has no threads inside the recency window. */
const RECENT_THREAD_FALLBACK_COUNT = 3;

export interface HomeThreadGroup {
  readonly key: string;
  readonly title: string;
  readonly representative: EnvironmentProject;
  readonly projects: ReadonlyArray<EnvironmentProject>;
  /** Full sorted thread history for the group (revealed when expanded / searching). */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Subset shown by default: threads from the last few days, or the most recent few. */
  readonly recentThreads: ReadonlyArray<EnvironmentThreadShell>;
}

interface MutableHomeThreadGroup {
  readonly key: string;
  readonly projects: EnvironmentProject[];
  readonly threads: EnvironmentThreadShell[];
}

function groupSortTimestamp(group: HomeThreadGroup, sortOrder: HomeProjectSortOrder): number {
  return group.threads.reduce(
    (latest, thread) => Math.max(latest, getThreadSortTimestamp(thread, sortOrder)),
    Number.NEGATIVE_INFINITY,
  );
}

/**
 * Trims a group's threads to recent activity for the default home view.
 * `sortedThreads` must already be ordered newest-first for `threadSortOrder`.
 * Keeps threads within {@link RECENT_THREAD_WINDOW_MS}; when none qualify, keeps
 * the most recent {@link RECENT_THREAD_FALLBACK_COUNT} so a project never vanishes.
 */
function selectRecentThreads(
  sortedThreads: ReadonlyArray<EnvironmentThreadShell>,
  threadSortOrder: SidebarThreadSortOrder,
  now: number,
): ReadonlyArray<EnvironmentThreadShell> {
  const cutoff = now - RECENT_THREAD_WINDOW_MS;
  const recent = sortedThreads.filter(
    (thread) => getThreadSortTimestamp(thread, threadSortOrder) >= cutoff,
  );
  return recent.length > 0 ? recent : sortedThreads.slice(0, RECENT_THREAD_FALLBACK_COUNT);
}

export function buildHomeThreadGroups(input: {
  readonly projects: ReadonlyArray<EnvironmentProject>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
  /** Current time used for the recency window; defaults to now. Injectable for tests. */
  readonly now?: number;
}): ReadonlyArray<HomeThreadGroup> {
  const now = input.now ?? Date.now();
  const groups = new Map<string, MutableHomeThreadGroup>();
  const groupKeyByProjectKey = new Map<string, string>();

  for (const project of input.projects) {
    if (input.environmentId !== null && project.environmentId !== input.environmentId) {
      continue;
    }

    const groupKey = deriveLogicalProjectKey(project, {
      groupingMode: input.projectGroupingMode,
    });
    const physicalKey = scopedProjectKey(project.environmentId, project.id);
    groupKeyByProjectKey.set(physicalKey, groupKey);

    const existing = groups.get(groupKey);
    if (existing) {
      existing.projects.push(project);
    } else {
      groups.set(groupKey, { key: groupKey, projects: [project], threads: [] });
    }
  }

  for (const thread of input.threads) {
    if (thread.archivedAt !== null) {
      continue;
    }
    if (input.environmentId !== null && thread.environmentId !== input.environmentId) {
      continue;
    }

    const physicalKey = scopedProjectKey(thread.environmentId, thread.projectId);
    const groupKey = groupKeyByProjectKey.get(physicalKey);
    if (!groupKey) {
      continue;
    }
    groups.get(groupKey)?.threads.push(thread);
  }

  const query = input.searchQuery.trim().toLocaleLowerCase();
  const result: HomeThreadGroup[] = [];

  for (const group of groups.values()) {
    const representative = group.projects[0];
    if (!representative || group.threads.length === 0) {
      continue;
    }

    const title =
      group.projects.length > 1
        ? deriveProjectGroupLabel({ representative, members: group.projects })
        : representative.title;
    const groupMatches =
      query.length === 0 ||
      title.toLocaleLowerCase().includes(query) ||
      group.projects.some((project) => project.title.toLocaleLowerCase().includes(query));
    const matchingThreads = groupMatches
      ? group.threads
      : group.threads.filter((thread) => thread.title.toLocaleLowerCase().includes(query));

    if (matchingThreads.length === 0) {
      continue;
    }

    const sortedThreads = sortThreads(matchingThreads, input.threadSortOrder);
    // An active search should reach the full history, so the recency window
    // only trims the default (no-query) view.
    const recentThreads =
      query.length === 0
        ? selectRecentThreads(sortedThreads, input.threadSortOrder, now)
        : sortedThreads;

    result.push({
      key: group.key,
      title,
      representative,
      projects: group.projects,
      threads: sortedThreads,
      recentThreads,
    });
  }

  return Arr.sort(
    result,
    Order.mapInput(
      Order.Struct({
        timestamp: Order.flip(Order.Number),
        title: Order.String,
        key: Order.String,
      }),
      (group: HomeThreadGroup) => ({
        timestamp: groupSortTimestamp(group, input.projectSortOrder),
        title: group.title,
        key: group.key,
      }),
    ),
  );
}
