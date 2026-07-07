import { describe, expect, it } from "vite-plus/test";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";

import {
  makeNewThreadWidgetProps,
  NEW_THREAD_WIDGET_PROJECT_SYNC_LIMIT,
} from "./new-thread-widget";

function makeProject(overrides: {
  readonly id: string;
  readonly environmentId?: string;
  readonly title?: string;
  readonly updatedAt?: string;
}): EnvironmentProject {
  return {
    id: overrides.id,
    environmentId: overrides.environmentId ?? "env-1",
    title: overrides.title ?? overrides.id,
    updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00.000Z",
  } as unknown as EnvironmentProject;
}

function makeThread(overrides: {
  readonly projectId: string;
  readonly environmentId?: string;
  readonly updatedAt: string;
}): EnvironmentThreadShell {
  return {
    id: `thread-${overrides.projectId}`,
    projectId: overrides.projectId,
    environmentId: overrides.environmentId ?? "env-1",
    updatedAt: overrides.updatedAt,
  } as unknown as EnvironmentThreadShell;
}

describe("makeNewThreadWidgetProps", () => {
  it("orders projects by their newest thread activity", () => {
    const props = makeNewThreadWidgetProps(
      [
        makeProject({ id: "stale", updatedAt: "2026-07-06T00:00:00.000Z" }),
        makeProject({ id: "busy", updatedAt: "2026-07-01T00:00:00.000Z" }),
      ],
      [makeThread({ projectId: "busy", updatedAt: "2026-07-07T00:00:00.000Z" })],
    );
    expect(props.projects?.map((project) => project.title)).toEqual(["busy", "stale"]);
  });

  it("falls back to the project's own updatedAt when it has no threads", () => {
    const props = makeNewThreadWidgetProps(
      [
        makeProject({ id: "old", updatedAt: "2026-07-01T00:00:00.000Z" }),
        makeProject({ id: "fresh", updatedAt: "2026-07-07T00:00:00.000Z" }),
      ],
      [],
    );
    expect(props.projects?.map((project) => project.title)).toEqual(["fresh", "old"]);
  });

  it("ignores thread activity from a same-named project in another environment", () => {
    const props = makeNewThreadWidgetProps(
      [
        makeProject({ id: "proj", environmentId: "env-1", title: "one" }),
        makeProject({
          id: "proj",
          environmentId: "env-2",
          title: "two",
          updatedAt: "2026-07-02T00:00:00.000Z",
        }),
      ],
      [
        makeThread({
          projectId: "proj",
          environmentId: "env-2",
          updatedAt: "2026-07-07T00:00:00.000Z",
        }),
      ],
    );
    expect(props.projects?.map((project) => project.title)).toEqual(["two", "one"]);
  });

  it("caps the payload at the widget's sync limit", () => {
    const props = makeNewThreadWidgetProps(
      Array.from({ length: NEW_THREAD_WIDGET_PROJECT_SYNC_LIMIT + 5 }, (_, n) =>
        makeProject({
          id: `p${n}`,
          updatedAt: `2026-06-${String(n + 1).padStart(2, "0")}T00:00:00.000Z`,
        }),
      ),
      [],
    );
    expect(props.projects).toHaveLength(NEW_THREAD_WIDGET_PROJECT_SYNC_LIMIT);
    expect(props.projects?.[0]?.title).toBe(`p${NEW_THREAD_WIDGET_PROJECT_SYNC_LIMIT + 4}`);
  });

  it("URL-encodes deep link parameters", () => {
    const props = makeNewThreadWidgetProps(
      [makeProject({ id: "p 1", environmentId: "env&1", title: "T3 & friends" })],
      [],
    );
    expect(props.projects?.[0]?.deepLink).toBe(
      "/new/draft?environmentId=env%261&projectId=p%201&title=T3%20%26%20friends",
    );
  });

  it("returns an empty list when there are no projects", () => {
    expect(makeNewThreadWidgetProps([], []).projects).toEqual([]);
  });
});
