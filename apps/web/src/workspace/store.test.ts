import { scopeThreadRef } from "@t3tools/client-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

function createLocalStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

function getTestWindow(): Window & typeof globalThis {
  const localStorage = createLocalStorageStub();
  const testWindow = {
    localStorage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as Window & typeof globalThis;
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return testWindow;
}

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("workspace store", () => {
  it("focuses an existing thread surface instead of duplicating it by default", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    const initialDocument = useWorkspaceStore.getState().document;
    const windowId = Object.keys(initialDocument.windowsById)[0]!;
    const initialSurfaceId = initialDocument.windowsById[windowId]!.surfaceId;

    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    const nextDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(1);
    expect(nextDocument.windowsById[windowId]!.surfaceId).toBe(initialSurfaceId);
    expect(Object.keys(nextDocument.surfacesById)).toHaveLength(1);
  });

  it("does not rewrite workspace state when refocusing the already active surface", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    const initialDocument = useWorkspaceStore.getState().document;
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    expect(useWorkspaceStore.getState().document).toBe(initialDocument);
  });

  it("normalizes legacy persisted tab-based workspace documents on load", async () => {
    const testWindow = getTestWindow();
    const { WORKSPACE_DOCUMENT_STORAGE_KEY } = await import("../clientPersistenceStorage");

    testWindow.localStorage.setItem(
      WORKSPACE_DOCUMENT_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        layoutEngine: "split",
        rootNodeId: "node-1",
        nodesById: {
          "node-1": {
            id: "node-1",
            kind: "window",
            windowId: "window-1",
          },
        },
        windowsById: {
          "window-1": {
            id: "window-1",
            tabIds: ["surface-1"],
            activeTabId: "surface-1",
          },
        },
        surfacesById: {
          "surface-1": {
            id: "surface-1",
            kind: "thread",
            input: {
              scope: "server",
              threadRef: {
                environmentId: "environment-a",
                threadId: "thread-a",
              },
            },
          },
        },
        focusedWindowId: "window-1",
        mobileActiveWindowId: "window-1",
      }),
    );

    const { useWorkspaceStore } = await import("./store");

    expect(useWorkspaceStore.getState().document.windowsById["window-1"]).toEqual({
      id: "window-1",
      surfaceId: "surface-1",
    });
  });

  it("collapses the split tree when closing the last pane in a window", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    const splitDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(splitDocument.windowsById)).toHaveLength(2);
    expect(splitDocument.rootNodeId).not.toBeNull();
    expect(splitDocument.nodesById[splitDocument.rootNodeId!]?.kind).toBe("split");

    const closingWindowId = splitDocument.focusedWindowId!;
    const closingSurfaceId = splitDocument.windowsById[closingWindowId]!.surfaceId!;
    useWorkspaceStore.getState().closeSurface(closingSurfaceId);

    const collapsedDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(collapsedDocument.windowsById)).toHaveLength(1);
    expect(collapsedDocument.rootNodeId).not.toBeNull();
    expect(collapsedDocument.nodesById[collapsedDocument.rootNodeId!]?.kind).toBe("window");
  });

  it("creates one terminal surface per thread and toggles it off cleanly", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));
    useWorkspaceStore.getState().ensureTerminalSurfaceForThread(threadRef);

    let document = useWorkspaceStore.getState().document;
    expect(
      Object.values(document.surfacesById).filter((surface) => surface.kind === "terminal"),
    ).toHaveLength(1);

    useWorkspaceStore.getState().ensureTerminalSurfaceForThread(threadRef);
    document = useWorkspaceStore.getState().document;
    expect(
      Object.values(document.surfacesById).filter((surface) => surface.kind === "terminal"),
    ).toHaveLength(1);

    useWorkspaceStore.getState().toggleTerminalSurfaceForThread(threadRef);
    document = useWorkspaceStore.getState().document;
    expect(
      Object.values(document.surfacesById).filter((surface) => surface.kind === "terminal"),
    ).toHaveLength(0);
  });

  it("replaces the focused pane with a terminal surface by default", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    const initialDocument = useWorkspaceStore.getState().document;
    const windowId = initialDocument.focusedWindowId!;

    useWorkspaceStore.getState().openTerminalSurfaceForThread(threadRef);

    const nextDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(1);
    expect(nextDocument.windowsById[windowId]!.surfaceId).not.toBe(
      initialDocument.windowsById[windowId]!.surfaceId,
    );
    expect(nextDocument.surfacesById[nextDocument.windowsById[windowId]!.surfaceId!]?.kind).toBe(
      "terminal",
    );
  });

  it("opens a terminal surface in a split when requested", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));
    useWorkspaceStore.getState().openTerminalSurfaceForThread(threadRef, "split-right");

    const nextDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(2);
    const activeWindowId = nextDocument.focusedWindowId!;
    const activeSurfaceId = nextDocument.windowsById[activeWindowId]!.surfaceId!;
    expect(nextDocument.surfacesById[activeSurfaceId]?.kind).toBe("terminal");
  });

  it("creates a new terminal split even when one already exists for the thread", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));
    useWorkspaceStore.getState().openTerminalSurfaceForThread(threadRef, "split-right");
    useWorkspaceStore.getState().openTerminalSurfaceForThread(threadRef, "split-right");

    const nextDocument = useWorkspaceStore.getState().document;
    const terminalSurfaces = Object.values(nextDocument.surfacesById).filter(
      (surface) => surface.kind === "terminal",
    );
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(3);
    expect(terminalSurfaces).toHaveLength(2);
    expect(new Set(terminalSurfaces.map((surface) => surface.input.terminalId)).size).toBe(2);
  });

  it("splits terminal panes into a new terminal session instead of duplicating the same one", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));
    useWorkspaceStore.getState().openTerminalSurfaceForThread(threadRef);

    const terminalWindowId = useWorkspaceStore.getState().document.focusedWindowId!;
    useWorkspaceStore.getState().splitWindowSurface(terminalWindowId, "x");

    const nextDocument = useWorkspaceStore.getState().document;
    const terminalSurfaces = Object.values(nextDocument.surfacesById).filter(
      (surface) => surface.kind === "terminal",
    );

    expect(terminalSurfaces).toHaveLength(2);
    expect(new Set(terminalSurfaces.map((surface) => surface.input.terminalId)).size).toBe(2);
  });

  it("splits the active surface in the selected window", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    const initialDocument = useWorkspaceStore.getState().document;
    const sourceWindowId = initialDocument.focusedWindowId!;
    const sourceSurfaceId = initialDocument.windowsById[sourceWindowId]!.surfaceId!;

    useWorkspaceStore.getState().splitWindowSurface(sourceWindowId, "x");

    const nextDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(2);
    const newWindowId = nextDocument.focusedWindowId!;
    expect(newWindowId).not.toBe(sourceWindowId);
    const newSurfaceId = nextDocument.windowsById[newWindowId]!.surfaceId!;
    expect(newSurfaceId).not.toBe(sourceSurfaceId);
    expect(nextDocument.surfacesById[newSurfaceId]?.kind).toBe("thread");
    expect(nextDocument.nodesById[nextDocument.rootNodeId!]?.kind).toBe("split");
  });

  it("rebalances same-axis auto splits evenly when adding a third pane", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);
    const threadC = scopeThreadRef("environment-c" as never, "thread-c" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadC), "x");

    const nextDocument = useWorkspaceStore.getState().document;
    const rootNode = nextDocument.nodesById[nextDocument.rootNodeId!];
    expect(rootNode?.kind).toBe("split");
    if (rootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    expect(rootNode.childIds).toHaveLength(3);
    expect(rootNode.sizingMode).toBe("auto");
    expect(rootNode.sizes).toEqual([1 / 3, 1 / 3, 1 / 3]);
  });

  it("persists resized split proportions on the workspace node", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    const splitNodeId = useWorkspaceStore.getState().document.rootNodeId!;
    useWorkspaceStore.getState().setSplitNodeSizes(splitNodeId, [1, 3]);

    const nextDocument = useWorkspaceStore.getState().document;
    const splitNode = nextDocument.nodesById[splitNodeId];
    expect(splitNode?.kind).toBe("split");
    if (splitNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    expect(splitNode.sizes).toEqual([0.25, 0.75]);
    expect(splitNode.sizingMode).toBe("manual");
  });

  it("keeps manual same-axis splits local when adding another pane", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);
    const threadC = scopeThreadRef("environment-c" as never, "thread-c" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    const rootNodeId = useWorkspaceStore.getState().document.rootNodeId!;
    useWorkspaceStore.getState().setSplitNodeSizes(rootNodeId, [0.7, 0.3]);
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadC), "x");

    const nextDocument = useWorkspaceStore.getState().document;
    const rootNode = nextDocument.nodesById[rootNodeId];
    expect(rootNode?.kind).toBe("split");
    if (rootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    expect(rootNode.childIds).toHaveLength(2);
    expect(rootNode.sizingMode).toBe("manual");
    expect(rootNode.sizes).toEqual([0.7, 0.3]);

    const nestedNode = nextDocument.nodesById[rootNode.childIds[1]!];
    expect(nestedNode?.kind).toBe("split");
    if (nestedNode?.kind !== "split") {
      throw new Error("Expected nested split node");
    }
    expect(nestedNode.axis).toBe("x");
    expect(nestedNode.sizingMode).toBe("auto");
    expect(nestedNode.childIds).toHaveLength(2);
  });

  it("rebalances auto split groups after closing a pane", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);
    const threadC = scopeThreadRef("environment-c" as never, "thread-c" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadC), "x");

    let document = useWorkspaceStore.getState().document;
    const rootNode = document.nodesById[document.rootNodeId!];
    expect(rootNode?.kind).toBe("split");
    if (rootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }

    const middleNode = rootNode.childIds[1] ? document.nodesById[rootNode.childIds[1]!] : null;
    const middleWindowId = middleNode?.kind === "window" ? middleNode.windowId : null;
    if (!middleWindowId) {
      throw new Error("Expected middle window node");
    }
    const middleSurfaceId = document.windowsById[middleWindowId]!.surfaceId!;

    useWorkspaceStore.getState().closeSurface(middleSurfaceId);

    document = useWorkspaceStore.getState().document;
    const nextRootNode = document.nodesById[document.rootNodeId!];
    expect(nextRootNode?.kind).toBe("split");
    if (nextRootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    expect(nextRootNode.childIds).toHaveLength(2);
    expect(nextRootNode.sizingMode).toBe("auto");
    expect(nextRootNode.sizes).toEqual([0.5, 0.5]);
  });

  it("preserves remaining proportions after closing a pane in a manual split group", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);
    const threadC = scopeThreadRef("environment-c" as never, "thread-c" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadC), "x");

    const rootNodeId = useWorkspaceStore.getState().document.rootNodeId!;
    useWorkspaceStore.getState().setSplitNodeSizes(rootNodeId, [0.2, 0.3, 0.5]);

    let document = useWorkspaceStore.getState().document;
    const rootNode = document.nodesById[rootNodeId];
    expect(rootNode?.kind).toBe("split");
    if (rootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }

    const middleNode = rootNode.childIds[1] ? document.nodesById[rootNode.childIds[1]!] : null;
    const middleWindowId = middleNode?.kind === "window" ? middleNode.windowId : null;
    if (!middleWindowId) {
      throw new Error("Expected middle window node");
    }
    const middleSurfaceId = document.windowsById[middleWindowId]!.surfaceId!;

    useWorkspaceStore.getState().closeSurface(middleSurfaceId);

    document = useWorkspaceStore.getState().document;
    const nextRootNode = document.nodesById[document.rootNodeId!];
    expect(nextRootNode?.kind).toBe("split");
    if (nextRootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    expect(nextRootNode.childIds).toHaveLength(2);
    expect(nextRootNode.sizingMode).toBe("manual");
    expect(nextRootNode.sizes[0]).toBeCloseTo(2 / 7);
    expect(nextRootNode.sizes[1]).toBeCloseTo(5 / 7);
  });

  it("focuses the adjacent pane in the requested direction", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    const rightWindowId = useWorkspaceStore.getState().document.focusedWindowId!;
    useWorkspaceStore.getState().focusAdjacentWindow("left");

    const nextDocument = useWorkspaceStore.getState().document;
    expect(nextDocument.focusedWindowId).not.toBe(rightWindowId);
    expect(nextDocument.focusedWindowId).toBe(nextDocument.mobileActiveWindowId);
  });

  it("cycles focus between panes in previous and next order", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    const leftWindowId = useWorkspaceStore.getState().document.focusedWindowId!;
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");
    const rightWindowId = useWorkspaceStore.getState().document.focusedWindowId!;

    useWorkspaceStore.getState().focusWindowByStep(-1);
    expect(useWorkspaceStore.getState().document.focusedWindowId).toBe(leftWindowId);

    useWorkspaceStore.getState().focusWindowByStep(1);
    expect(useWorkspaceStore.getState().document.focusedWindowId).toBe(rightWindowId);
  });

  it("resizes the focused pane toward an adjacent pane", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    const beforeDocument = useWorkspaceStore.getState().document;
    const rootNode = beforeDocument.nodesById[beforeDocument.rootNodeId!];
    expect(rootNode?.kind).toBe("split");
    if (rootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    const beforeSizes = [...rootNode.sizes];

    useWorkspaceStore.getState().resizeFocusedWindow("left");

    const nextDocument = useWorkspaceStore.getState().document;
    const nextRootNode = nextDocument.nodesById[nextDocument.rootNodeId!];
    expect(nextRootNode?.kind).toBe("split");
    if (nextRootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    expect(nextRootNode.sizingMode).toBe("manual");
    expect(nextRootNode.sizes[1]).toBeGreaterThan(beforeSizes[1] ?? 0);
    expect(nextRootNode.sizes[0]).toBeLessThan(beforeSizes[0] ?? 0);
  });

  it("equalizes splits back to auto sizing", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");
    const splitNodeId = useWorkspaceStore.getState().document.rootNodeId!;
    useWorkspaceStore.getState().setSplitNodeSizes(splitNodeId, [1, 3]);

    useWorkspaceStore.getState().equalizeSplits();

    const nextDocument = useWorkspaceStore.getState().document;
    const rootNode = nextDocument.nodesById[splitNodeId];
    expect(rootNode?.kind).toBe("split");
    if (rootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    expect(rootNode.sizingMode).toBe("auto");
    expect(rootNode.sizes).toEqual([0.5, 0.5]);
  });

  it("toggles zoom for the focused pane", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));

    const focusedWindowId = useWorkspaceStore.getState().document.focusedWindowId!;
    useWorkspaceStore.getState().toggleFocusedWindowZoom();
    expect(useWorkspaceStore.getState().zoomedWindowId).toBe(focusedWindowId);

    useWorkspaceStore.getState().toggleFocusedWindowZoom();
    expect(useWorkspaceStore.getState().zoomedWindowId).toBeNull();
  });

  it("closes the focused pane and keeps the remaining pane active", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    const closingWindowId = useWorkspaceStore.getState().document.focusedWindowId!;
    useWorkspaceStore.getState().closeFocusedWindow();

    const nextDocument = useWorkspaceStore.getState().document;
    expect(nextDocument.windowsById[closingWindowId]).toBeUndefined();
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(1);
    expect(nextDocument.nodesById[nextDocument.rootNodeId!]?.kind).toBe("window");
  });

  it("swaps an existing thread surface onto the target pane when placed in the center", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    const leftWindowId = useWorkspaceStore.getState().document.focusedWindowId!;
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");
    const rightWindowId = useWorkspaceStore.getState().document.focusedWindowId!;

    useWorkspaceStore.getState().placeThreadSurface(serverThreadSurfaceInput(threadA), {
      kind: "window",
      windowId: rightWindowId,
      placement: "center",
    });

    const nextDocument = useWorkspaceStore.getState().document;
    const leftSurfaceId = nextDocument.windowsById[leftWindowId]!.surfaceId!;
    const rightSurfaceId = nextDocument.windowsById[rightWindowId]!.surfaceId!;
    expect(Object.keys(nextDocument.surfacesById)).toHaveLength(2);
    expect(nextDocument.surfacesById[rightSurfaceId]?.kind).toBe("thread");
    expect(nextDocument.surfacesById[rightSurfaceId]?.input).toEqual(
      serverThreadSurfaceInput(threadA),
    );
    expect(nextDocument.surfacesById[leftSurfaceId]?.input).toEqual(
      serverThreadSurfaceInput(threadB),
    );
  });

  it("replaces the target pane with a new thread surface when placed in the center", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));

    const targetWindowId = useWorkspaceStore.getState().document.focusedWindowId!;
    useWorkspaceStore.getState().placeThreadSurface(serverThreadSurfaceInput(threadB), {
      kind: "window",
      windowId: targetWindowId,
      placement: "center",
    });

    const nextDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(1);
    expect(Object.keys(nextDocument.surfacesById)).toHaveLength(1);
    expect(
      nextDocument.surfacesById[nextDocument.windowsById[targetWindowId]!.surfaceId!]?.input,
    ).toEqual(serverThreadSurfaceInput(threadB));
  });

  it("moves the focused pane by swapping positions with the adjacent pane", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    const beforeDocument = useWorkspaceStore.getState().document;
    const rootNode = beforeDocument.nodesById[beforeDocument.rootNodeId!];
    expect(rootNode?.kind).toBe("split");
    if (rootNode?.kind !== "split") {
      throw new Error("Expected split node");
    }
    const leftNodeId = rootNode.childIds[0]!;
    const rightNodeId = rootNode.childIds[1]!;
    const rightWindowId = beforeDocument.focusedWindowId!;

    useWorkspaceStore.getState().moveFocusedWindow("left");

    const nextDocument = useWorkspaceStore.getState().document;
    expect(nextDocument.focusedWindowId).toBe(rightWindowId);
    expect(nextDocument.nodesById[leftNodeId]).toMatchObject({
      kind: "window",
      windowId: rightWindowId,
    });
    expect(nextDocument.nodesById[rightNodeId]).not.toMatchObject({
      kind: "window",
      windowId: rightWindowId,
    });
  });

  it("clears the workspace tree when closing the last focused pane", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().closeFocusedWindow();

    const nextDocument = useWorkspaceStore.getState().document;
    expect(nextDocument.rootNodeId).toBeNull();
    expect(nextDocument.focusedWindowId).toBeNull();
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(0);
    expect(Object.keys(nextDocument.surfacesById)).toHaveLength(0);
  });

  it("converts an existing split workspace into paper columns", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");
    useWorkspaceStore.getState().setLayoutEngine("paper");

    const nextDocument = useWorkspaceStore.getState().document;
    expect(nextDocument.layoutEngine).toBe("paper");
    const rootNode = nextDocument.nodesById[nextDocument.rootNodeId!];
    expect(rootNode?.kind).toBe("paper-root");
    if (rootNode?.kind !== "paper-root") {
      throw new Error("Expected paper root");
    }
    expect(rootNode.childIds).toHaveLength(2);
    expect(rootNode.widths).toEqual([1, 1]);
    for (const columnId of rootNode.childIds) {
      const column = nextDocument.nodesById[columnId];
      expect(column?.kind).toBe("paper-column");
      if (column?.kind !== "paper-column") {
        throw new Error("Expected paper column");
      }
      expect(column.childIds).toHaveLength(1);
    }
  });

  it("stacks split-down panes inside a paper column and split-right creates a new column", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);
    const threadC = scopeThreadRef("environment-c" as never, "thread-c" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().setLayoutEngine("paper");
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "y");
    useWorkspaceStore.getState().focusAdjacentWindow("up");
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadC), "x");

    const nextDocument = useWorkspaceStore.getState().document;
    const rootNode = nextDocument.nodesById[nextDocument.rootNodeId!];
    expect(rootNode?.kind).toBe("paper-root");
    if (rootNode?.kind !== "paper-root") {
      throw new Error("Expected paper root");
    }
    expect(rootNode.childIds).toHaveLength(2);

    const firstColumn = nextDocument.nodesById[rootNode.childIds[0]!];
    const secondColumn = nextDocument.nodesById[rootNode.childIds[1]!];
    expect(firstColumn?.kind).toBe("paper-column");
    expect(secondColumn?.kind).toBe("paper-column");
    if (firstColumn?.kind !== "paper-column" || secondColumn?.kind !== "paper-column") {
      throw new Error("Expected paper columns");
    }

    expect(firstColumn.childIds).toHaveLength(2);
    expect(secondColumn.childIds).toHaveLength(1);
  });

  it("resizes paper columns by adjusting neighboring widths", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().setLayoutEngine("paper");
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    const beforeDocument = useWorkspaceStore.getState().document;
    const beforeRoot = beforeDocument.nodesById[beforeDocument.rootNodeId!];
    expect(beforeRoot?.kind).toBe("paper-root");
    if (beforeRoot?.kind !== "paper-root") {
      throw new Error("Expected paper root");
    }

    useWorkspaceStore.getState().resizeFocusedWindow("left");

    const nextDocument = useWorkspaceStore.getState().document;
    const nextRoot = nextDocument.nodesById[nextDocument.rootNodeId!];
    expect(nextRoot?.kind).toBe("paper-root");
    if (nextRoot?.kind !== "paper-root") {
      throw new Error("Expected paper root");
    }
    expect(nextRoot.sizingMode).toBe("manual");
    expect(nextRoot.widths[1]).toBeGreaterThan(beforeRoot.widths[1] ?? 0);
    expect(nextRoot.widths[0]).toBeLessThan(beforeRoot.widths[0] ?? 0);
  });

  it("removes an empty paper column when its last pane closes", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().setLayoutEngine("paper");
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");

    useWorkspaceStore.getState().closeFocusedWindow();

    const nextDocument = useWorkspaceStore.getState().document;
    expect(nextDocument.layoutEngine).toBe("paper");
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(1);
    const rootNode = nextDocument.nodesById[nextDocument.rootNodeId!];
    expect(rootNode?.kind).toBe("paper-root");
    if (rootNode?.kind !== "paper-root") {
      throw new Error("Expected paper root");
    }
    expect(rootNode.childIds).toHaveLength(1);
  });

  it("persists workspace documents after the debounce interval", async () => {
    vi.useFakeTimers();
    const testWindow = getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { WORKSPACE_DOCUMENT_STORAGE_KEY } = await import("../clientPersistenceStorage");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    expect(testWindow.localStorage.getItem(WORKSPACE_DOCUMENT_STORAGE_KEY)).toBeNull();

    await vi.advanceTimersByTimeAsync(150);

    const persisted = JSON.parse(testWindow.localStorage.getItem(WORKSPACE_DOCUMENT_STORAGE_KEY)!);
    expect(persisted.layoutEngine).toBe("split");
    expect(persisted.focusedWindowId).not.toBeNull();
  });
});
