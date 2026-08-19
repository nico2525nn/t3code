import { derivePhysicalProjectKeyFromPath } from "@t3tools/client-runtime/state/project-grouping";
import {
  forgetProjectFavicon,
  rememberProjectFavicon,
} from "@t3tools/client-runtime/state/project-favicon";
import type { ComponentType, Dispatch, ReactElement, SetStateAction } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId } from "@t3tools/contracts";

const testState = vi.hoisted(() => ({
  faviconUrl: "https://environment.test/api/assets/token-a/v1-20-favicon.svg" as string | null,
  faviconSources: new Map<string, unknown>(),
  lastRequests: [] as Array<{ environmentId: unknown; resource: unknown }>,
}));

const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: unknown[] = [];
  const nextIndex = () => cursor++;

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      cursor = 0;
      slots = [];
    },
    useMemoCache(size: number): unknown[] {
      const index = nextIndex();
      if (!slots[index]) {
        slots[index] = Array.from({ length: size }, () => Symbol.for("react.memo_cache_sentinel"));
      }
      return slots[index] as unknown[];
    },
    useState<T>(initialValue: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
      const index = nextIndex();
      if (index >= slots.length) {
        slots[index] =
          typeof initialValue === "function" ? (initialValue as () => T)() : initialValue;
      }
      const setValue: Dispatch<SetStateAction<T>> = (nextValue) => {
        const previous = slots[index] as T;
        slots[index] =
          typeof nextValue === "function" ? (nextValue as (value: T) => T)(previous) : nextValue;
      };
      return [slots[index] as T, setValue];
    },
  };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: hooks.useState,
    useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
  };
});

vi.mock("react/compiler-runtime", () => ({ c: hooks.useMemoCache }));
vi.mock("../assets/assetUrls", () => ({
  useAssetUrlState: (environmentId: unknown, resource: unknown) => {
    testState.lastRequests.push({ environmentId, resource });
    return testState.faviconUrl === null
      ? { _tag: "Loading" }
      : { _tag: "Success", url: testState.faviconUrl };
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => testState.faviconSources,
}));
vi.mock("~/state/projects", () => ({ projectFaviconSourcesAtom: Symbol("sources") }));

import { ProjectFavicon } from "./ProjectFavicon";

const environmentId = "environment-test" as EnvironmentId;
const cwd = "/workspace-test";
const iconKey = derivePhysicalProjectKeyFromPath(environmentId, cwd);

type ProjectFaviconImageProps = {
  readonly cacheKey: string;
  readonly iconKey: string;
  readonly src: string;
  readonly remember: boolean;
  readonly className?: string | undefined;
  readonly fallbackIcon: ComponentType<{ className?: string }>;
};

type ImageElement = ReactElement<{
  readonly src: string;
  readonly onLoad?: () => void;
  readonly onError?: () => void;
}>;

type ProjectFaviconImageElement = ReactElement<{
  readonly children: [ReactElement | null, ImageElement | null, ImageElement | null];
}>;

function renderFavicon(faviconPath?: string): ReactElement<ProjectFaviconImageProps> {
  hooks.beginRender();
  const element = ProjectFavicon({
    environmentId,
    cwd,
    ...(faviconPath === undefined ? {} : { faviconPath }),
  }) as ReactElement<ProjectFaviconImageProps>;
  hooks.reset();
  return element;
}

function resolveImageComponent(): {
  readonly Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement;
  readonly props: ProjectFaviconImageProps;
} {
  const element = renderFavicon();
  return {
    Component: element.type as (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
    props: element.props,
  };
}

function renderImage(
  Component: (props: ProjectFaviconImageProps) => ProjectFaviconImageElement,
  props: ProjectFaviconImageProps,
): ProjectFaviconImageElement {
  hooks.beginRender();
  return Component(props);
}

describe("ProjectFavicon", () => {
  beforeEach(() => {
    hooks.reset();
    testState.faviconUrl = "https://environment.test/api/assets/token-a/v1-20-favicon.svg";
    testState.faviconSources = new Map();
    testState.lastRequests = [];
    forgetProjectFavicon(iconKey, "https://environment.test/api/assets/token-a/v1-20-favicon.svg");
    forgetProjectFavicon("repo-key", "https://source.test/api/assets/token-s/v1-source.png");
  });

  it("falls back when the displayed favicon fails without discarding a valid older image early", () => {
    const { Component, props } = resolveImageComponent();
    const initialLoadingImage = renderImage(Component, props).props.children[2];
    initialLoadingImage?.props.onLoad?.();

    const refreshedProps = {
      ...props,
      src: "https://environment.test/api/assets/token-b/v1-20-favicon.svg",
    };
    const refreshing = renderImage(Component, refreshedProps).props.children;
    expect(refreshing[1]?.props.src).toBe(props.src);
    refreshing[2]?.props.onError?.();

    const afterRefreshError = renderImage(Component, refreshedProps).props.children;
    expect(afterRefreshError[1]?.props.src).toBe(props.src);
    afterRefreshError[1]?.props.onError?.();

    const afterDisplayedError = renderImage(Component, refreshedProps).props.children;
    expect(afterDisplayedError[0]).not.toBeNull();
    expect(afterDisplayedError[1]).toBeNull();
  });

  it("requests a saved favicon path when one is set", () => {
    renderFavicon("brand/icon.svg");

    expect(testState.lastRequests.at(-1)?.resource).toEqual({
      _tag: "project-favicon",
      cwd: "/workspace-test",
      path: "brand/icon.svg",
    });
  });

  it("requests the repository group's favicon source instead of the row's project", () => {
    testState.faviconSources = new Map([
      [
        iconKey,
        {
          environmentId: "environment-source",
          cwd: "/source-checkout",
          faviconPath: "assets/icon.png",
          iconKey: "repo-key",
        },
      ],
    ]);

    const element = renderFavicon("brand/icon.svg");

    expect(testState.lastRequests[0]).toEqual({
      environmentId: "environment-source",
      resource: { _tag: "project-favicon", cwd: "/source-checkout", path: "assets/icon.png" },
    });
    expect(element.props.iconKey).toBe("repo-key");
  });

  it("keeps showing the remembered icon while the connection is gone", () => {
    testState.faviconUrl = null;

    expect(renderFavicon().props.src).toBeUndefined();

    rememberProjectFavicon(iconKey, {
      url: "https://environment.test/api/assets/token-a/v1-20-favicon.svg",
      cacheKey: "remembered-cache-key",
    });
    const element = renderFavicon();
    expect(element.props.src).toBe("https://environment.test/api/assets/token-a/v1-20-favicon.svg");
    expect(element.props.cacheKey).toBe("remembered-cache-key");
    expect(element.props.remember).toBe(false);
  });
});
