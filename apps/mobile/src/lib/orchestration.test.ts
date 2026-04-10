import { describe, expect, it } from "vitest";

import { EventId, ProjectId } from "@t3tools/contracts";
import type { OrchestrationReadModel } from "@t3tools/contracts";

import { applyRealtimeEvent } from "./orchestration";

const baseSnapshot: OrchestrationReadModel = {
  snapshotSequence: 0,
  updatedAt: "2026-04-01T00:00:00.000Z",
  projects: [],
  threads: [],
};

const baseEventFields = {
  eventId: EventId.makeUnsafe("event-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
} as const;

describe("applyRealtimeEvent project identity handling", () => {
  it("preserves repository identity on project.created", () => {
    const next = applyRealtimeEvent(baseSnapshot, {
      ...baseEventFields,
      sequence: 1,
      occurredAt: "2026-04-01T01:00:00.000Z",
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      type: "project.created",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "T3 Code",
        workspaceRoot: "/repo",
        repositoryIdentity: {
          canonicalKey: "github.com/t3tools/t3code",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@github.com:t3tools/t3code.git",
          },
          provider: "github",
          owner: "t3tools",
          name: "t3code",
        },
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-04-01T01:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
    });

    expect(next.projects[0]?.repositoryIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
  });

  it("applies repository identity updates on project.meta-updated", () => {
    const seeded = applyRealtimeEvent(baseSnapshot, {
      ...baseEventFields,
      sequence: 1,
      occurredAt: "2026-04-01T01:00:00.000Z",
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      type: "project.created",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        title: "T3 Code",
        workspaceRoot: "/repo",
        repositoryIdentity: null,
        defaultModelSelection: null,
        scripts: [],
        createdAt: "2026-04-01T01:00:00.000Z",
        updatedAt: "2026-04-01T01:00:00.000Z",
      },
    });

    const next = applyRealtimeEvent(seeded, {
      ...baseEventFields,
      eventId: EventId.makeUnsafe("event-2"),
      sequence: 2,
      occurredAt: "2026-04-01T02:00:00.000Z",
      aggregateKind: "project",
      aggregateId: ProjectId.makeUnsafe("project-1"),
      type: "project.meta-updated",
      payload: {
        projectId: ProjectId.makeUnsafe("project-1"),
        repositoryIdentity: {
          canonicalKey: "github.com/t3tools/t3code",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@github.com:t3tools/t3code.git",
          },
          provider: "github",
          owner: "t3tools",
          name: "t3code",
        },
        updatedAt: "2026-04-01T02:00:00.000Z",
      },
    });

    expect(next.projects[0]?.repositoryIdentity?.canonicalKey).toBe("github.com/t3tools/t3code");
  });
});
