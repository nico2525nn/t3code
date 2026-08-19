import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentProject } from "./models.ts";
import { derivePhysicalProjectKeyFromPath } from "./projectGrouping.ts";
import {
  forgetProjectFavicon,
  getRememberedProjectFavicon,
  planProjectFaviconRender,
  rememberProjectFavicon,
  selectProjectFaviconSources,
  subscribeProjectFaviconMemory,
} from "./projectFavicon.ts";

const repositoryIdentity = {
  canonicalKey: "github.com/t3tools/t3code",
  locator: {
    source: "git-remote" as const,
    remoteName: "upstream",
    remoteUrl: "https://github.com/t3tools/t3code.git",
  },
  provider: "github",
  owner: "t3tools",
  name: "t3code",
  displayName: "T3 Code",
};

function makeProject(
  environmentId: string,
  id: string,
  workspaceRoot: string,
  overrides: Partial<EnvironmentProject> = {},
): EnvironmentProject {
  return {
    environmentId: EnvironmentId.make(environmentId),
    id: ProjectId.make(id),
    title: id,
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectProjectFaviconSources", () => {
  it("maps every repository member to one shared source", () => {
    const sources = selectProjectFaviconSources(
      [
        makeProject("env-a", "a", "/work/t3code"),
        makeProject("env-b", "b", "/machines/t3code", { faviconPath: "assets/icon.png" }),
        makeProject("env-c", "c", "/home/t3code"),
      ],
      null,
    );

    const expected = {
      environmentId: "env-a",
      cwd: "/work/t3code",
      faviconPath: null,
      iconKey: repositoryIdentity.canonicalKey,
    };
    expect(sources.get(derivePhysicalProjectKeyFromPath("env-a", "/work/t3code"))).toEqual(
      expected,
    );
    expect(sources.get(derivePhysicalProjectKeyFromPath("env-b", "/machines/t3code"))).toEqual(
      expected,
    );
    expect(sources.get(derivePhysicalProjectKeyFromPath("env-c", "/home/t3code"))).toEqual(
      expected,
    );
  });

  it("prefers the primary environment's member as the source", () => {
    const sources = selectProjectFaviconSources(
      [
        makeProject("env-a", "a", "/work/t3code", { updatedAt: "2026-08-01T00:00:00.000Z" }),
        makeProject("env-b", "b", "/machines/t3code", { faviconPath: "assets/icon.png" }),
      ],
      EnvironmentId.make("env-b"),
    );

    expect(sources.get(derivePhysicalProjectKeyFromPath("env-a", "/work/t3code"))).toMatchObject({
      environmentId: "env-b",
      cwd: "/machines/t3code",
      faviconPath: "assets/icon.png",
    });
  });

  it("falls back to the freshest member when the primary environment has none", () => {
    const sources = selectProjectFaviconSources(
      [
        makeProject("env-a", "a", "/work/t3code"),
        makeProject("env-b", "b", "/machines/t3code", { updatedAt: "2026-08-01T00:00:00.000Z" }),
      ],
      EnvironmentId.make("env-x"),
    );

    expect(
      sources.get(derivePhysicalProjectKeyFromPath("env-a", "/work/t3code"))?.environmentId,
    ).toBe("env-b");
  });

  it("keeps projects without a repository identity as their own source", () => {
    const key = derivePhysicalProjectKeyFromPath("env-a", "/work/scratch");
    const sources = selectProjectFaviconSources(
      [
        makeProject("env-a", "a", "/work/scratch", { repositoryIdentity: null }),
        makeProject("env-b", "b", "/machines/t3code"),
      ],
      null,
    );

    expect(sources.get(key)).toEqual({
      environmentId: "env-a",
      cwd: "/work/scratch",
      faviconPath: null,
      iconKey: key,
    });
  });
});

describe("project favicon memory", () => {
  it("remembers, updates, and forgets icons per key", () => {
    const key = "memory-test-basic";
    expect(getRememberedProjectFavicon(key)).toBeNull();

    rememberProjectFavicon(key, { url: "https://a/1.png", cacheKey: "cache-1" });
    expect(getRememberedProjectFavicon(key)).toEqual({
      url: "https://a/1.png",
      cacheKey: "cache-1",
    });

    rememberProjectFavicon(key, { url: "https://a/2.png", cacheKey: "cache-2" });
    expect(getRememberedProjectFavicon(key)?.url).toBe("https://a/2.png");

    forgetProjectFavicon(key, "https://a/1.png");
    expect(getRememberedProjectFavicon(key)?.url).toBe("https://a/2.png");

    forgetProjectFavicon(key, "https://a/2.png");
    expect(getRememberedProjectFavicon(key)).toBeNull();
  });

  it("notifies subscribers only on real changes", () => {
    const key = "memory-test-notify";
    let notified = 0;
    const unsubscribe = subscribeProjectFaviconMemory(() => {
      notified += 1;
    });

    rememberProjectFavicon(key, { url: "https://a/1.png", cacheKey: "cache-1" });
    rememberProjectFavicon(key, { url: "https://a/1.png", cacheKey: "cache-1" });
    expect(notified).toBe(1);

    forgetProjectFavicon(key, "https://a/other.png");
    expect(notified).toBe(1);

    forgetProjectFavicon(key, "https://a/1.png");
    expect(notified).toBe(2);

    unsubscribe();
    rememberProjectFavicon(key, { url: "https://a/1.png", cacheKey: "cache-1" });
    expect(notified).toBe(2);
  });
});

describe("planProjectFaviconRender", () => {
  const live = { url: "https://source/icon.png", cacheKey: "source-key" };
  const own = { url: "https://own/icon.png", cacheKey: "own-key" };
  const remembered = { url: "https://memory/icon.png", cacheKey: "memory-key" };

  it("prefers the live source and marks it for remembering", () => {
    expect(planProjectFaviconRender({ sourceLive: live, ownLive: own, remembered })).toEqual({
      ...live,
      remember: true,
    });
  });

  it("falls back to memory before the row's own environment", () => {
    expect(planProjectFaviconRender({ sourceLive: null, ownLive: own, remembered })).toEqual({
      ...remembered,
      remember: false,
    });
    expect(planProjectFaviconRender({ sourceLive: null, ownLive: own, remembered: null })).toEqual({
      ...own,
      remember: true,
    });
    expect(
      planProjectFaviconRender({ sourceLive: null, ownLive: null, remembered: null }),
    ).toBeNull();
  });
});
