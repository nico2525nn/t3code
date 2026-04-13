import { describe, expect, it } from "vitest";

import { ProjectId, ThreadId } from "@t3tools/contracts";

import type { ScopedMobileProject, ScopedMobileThread } from "./scopedEntities";
import { groupProjectsByRepository } from "./repositoryGroups";

function makeProject(
  input: Partial<ScopedMobileProject> &
    Pick<ScopedMobileProject, "environmentId" | "environmentLabel" | "id" | "title">,
): ScopedMobileProject {
  return {
    workspaceRoot: `/workspaces/${input.id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    ...input,
  };
}

function makeThread(
  input: Partial<ScopedMobileThread> &
    Pick<
      ScopedMobileThread,
      "environmentId" | "environmentLabel" | "id" | "projectId" | "title" | "modelSelection"
    >,
): ScopedMobileThread {
  return {
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
    archivedAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
  };
}

describe("groupProjectsByRepository", () => {
  it("groups projects across environments by repository identity", () => {
    const repoIdentity = {
      canonicalKey: "github.com/t3tools/t3code",
      locator: {
        source: "git-remote" as const,
        remoteName: "origin",
        remoteUrl: "git@github.com:t3tools/t3code.git",
      },
      provider: "github",
      owner: "t3tools",
      name: "t3code",
      displayName: "T3 Code",
    };

    const projects = [
      makeProject({
        environmentId: "env-local",
        environmentLabel: "Local",
        id: ProjectId.make("project-local"),
        title: "T3 Code",
        repositoryIdentity: repoIdentity,
      }),
      makeProject({
        environmentId: "env-staging",
        environmentLabel: "Staging",
        id: ProjectId.make("project-staging"),
        title: "T3 Code",
        repositoryIdentity: repoIdentity,
      }),
    ];

    const threads = [
      makeThread({
        environmentId: "env-staging",
        environmentLabel: "Staging",
        id: ThreadId.make("thread-2"),
        projectId: ProjectId.make("project-staging"),
        title: "Fix reconnect flow",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        updatedAt: "2026-04-02T12:00:00.000Z",
      }),
      makeThread({
        environmentId: "env-local",
        environmentLabel: "Local",
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-local"),
        title: "Polish mobile shell",
        modelSelection: { provider: "codex", model: "gpt-5.4" },
        updatedAt: "2026-04-03T12:00:00.000Z",
      }),
    ];

    const groups = groupProjectsByRepository({ projects, threads });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      key: "github.com/t3tools/t3code",
      title: "T3 Code",
      subtitle: "t3tools/t3code",
      projectCount: 2,
      threadCount: 2,
    });
    expect(groups[0]?.projects.map((entry) => entry.project.environmentLabel)).toEqual([
      "Local",
      "Staging",
    ]);
  });

  it("falls back to a scoped project key when repository identity is unavailable", () => {
    const projects = [
      makeProject({
        environmentId: "env-local",
        environmentLabel: "Local",
        id: ProjectId.make("project-local"),
        title: "Scratchpad",
      }),
    ];

    const groups = groupProjectsByRepository({ projects, threads: [] });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("env-local:project-local");
    expect(groups[0]?.title).toBe("Scratchpad");
    expect(groups[0]?.subtitle).toBeNull();
  });
});
