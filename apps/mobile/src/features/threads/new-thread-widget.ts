import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import type { NewThreadWidgetProps } from "../../widgets/NewThread";

// Candidate pool synced to the widget. Deliberately larger than any family
// displays (medium shows 3 rows, large 7): the "pinned projects" widget
// configuration is per widget instance and only visible inside the widget
// process, so the layout matches pins against this pool — a pin should still
// resolve when its project is not among the most recent few.
export const NEW_THREAD_WIDGET_PROJECT_SYNC_LIMIT = 20;

/**
 * Builds the home-screen widget payload: the most-recently-active projects,
 * each with a deep link into the new-task draft composer for that project.
 *
 * "Recently active" means the newest thread update in the project, falling
 * back to the project's own updatedAt for projects with no threads — so the
 * widget surfaces where the user actually works, not what was created last.
 */
export function makeNewThreadWidgetProps(
  projects: ReadonlyArray<EnvironmentProject>,
  threads: ReadonlyArray<EnvironmentThreadShell>,
): NewThreadWidgetProps {
  const latestThreadActivity = new Map<string, string>();
  for (const thread of threads) {
    const key = projectActivityKey(thread.environmentId, thread.projectId);
    const previous = latestThreadActivity.get(key);
    // ISO-8601 timestamps order lexicographically.
    if (previous === undefined || thread.updatedAt > previous) {
      latestThreadActivity.set(key, thread.updatedAt);
    }
  }

  const lastActivity = (project: EnvironmentProject): string => {
    const threadActivity = latestThreadActivity.get(
      projectActivityKey(project.environmentId, project.id),
    );
    return threadActivity !== undefined && threadActivity > project.updatedAt
      ? threadActivity
      : project.updatedAt;
  };

  const ordered = [...projects].sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));

  return {
    projects: ordered.slice(0, NEW_THREAD_WIDGET_PROJECT_SYNC_LIMIT).map((project) => ({
      title: project.title,
      // Matches the NewTaskSheet > NewTaskDraft linking config in Stack.tsx;
      // the widget layout prefixes the scheme after a safety check.
      deepLink:
        `/new/draft?environmentId=${encodeURIComponent(String(project.environmentId))}` +
        `&projectId=${encodeURIComponent(String(project.id))}` +
        `&title=${encodeURIComponent(project.title)}`,
    })),
  };
}

function projectActivityKey(environmentId: string, projectId: string): string {
  return `${environmentId}\u0000${projectId}`;
}
