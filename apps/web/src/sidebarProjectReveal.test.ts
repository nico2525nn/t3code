import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveSidebarProjectRevealKey,
  scrollSidebarProjectIntoView,
} from "./sidebarProjectReveal";

const projectRef = scopeProjectRef(
  EnvironmentId.make("environment-local"),
  ProjectId.make("project-1"),
);

describe("resolveSidebarProjectRevealKey", () => {
  it("resolves a physical project to its grouped sidebar row", () => {
    expect(
      resolveSidebarProjectRevealKey({
        projectRef,
        physicalProjectKeyByScopedRef: new Map([
          [scopedProjectKey(projectRef), "physical-project"],
        ]),
        physicalToLogicalKey: new Map([["physical-project", "logical-project"]]),
      }),
    ).toBe("logical-project");
  });

  it("uses the physical row key when the project is not grouped", () => {
    expect(
      resolveSidebarProjectRevealKey({
        projectRef,
        physicalProjectKeyByScopedRef: new Map([
          [scopedProjectKey(projectRef), "physical-project"],
        ]),
        physicalToLogicalKey: new Map(),
      }),
    ).toBe("physical-project");
  });

  it("waits until the requested project is available in the sidebar", () => {
    expect(
      resolveSidebarProjectRevealKey({
        projectRef,
        physicalProjectKeyByScopedRef: new Map(),
        physicalToLogicalKey: new Map(),
      }),
    ).toBeNull();
  });
});

describe("scrollSidebarProjectIntoView", () => {
  it("smoothly centers the selected project header", () => {
    const scrollIntoView = vi.fn();

    scrollSidebarProjectIntoView({ scrollIntoView });

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
  });
});
