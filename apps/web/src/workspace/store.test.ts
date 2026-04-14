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
    const initialSurfaceId = initialDocument.windowsById[windowId]!.activeTabId;

    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    const nextDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(1);
    expect(nextDocument.windowsById[windowId]!.tabIds).toEqual([initialSurfaceId]);
    expect(nextDocument.windowsById[windowId]!.activeTabId).toBe(initialSurfaceId);
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

  it("collapses the split tree when closing the last tab in a window", async () => {
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
    const closingSurfaceId = splitDocument.windowsById[closingWindowId]!.activeTabId!;
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

  it("opens a terminal surface as a tab in the focused window", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadRef = scopeThreadRef("environment-a" as never, "thread-a" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadRef));

    const initialDocument = useWorkspaceStore.getState().document;
    const windowId = initialDocument.focusedWindowId!;

    useWorkspaceStore.getState().openTerminalSurfaceForThread(threadRef, "new-tab");

    const nextDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(1);
    expect(nextDocument.windowsById[windowId]!.tabIds).toHaveLength(2);
    const activeSurfaceId = nextDocument.windowsById[windowId]!.activeTabId!;
    expect(nextDocument.surfacesById[activeSurfaceId]?.kind).toBe("terminal");
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
    const activeSurfaceId = nextDocument.windowsById[activeWindowId]!.activeTabId!;
    expect(nextDocument.surfacesById[activeSurfaceId]?.kind).toBe("terminal");
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
    const sourceSurfaceId = initialDocument.windowsById[sourceWindowId]!.activeTabId!;

    useWorkspaceStore.getState().splitWindowSurface(sourceWindowId, "x");

    const nextDocument = useWorkspaceStore.getState().document;
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(2);
    const newWindowId = nextDocument.focusedWindowId!;
    expect(newWindowId).not.toBe(sourceWindowId);
    const newSurfaceId = nextDocument.windowsById[newWindowId]!.activeTabId!;
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
    const middleSurfaceId = document.windowsById[middleWindowId]!.activeTabId!;

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
    const middleSurfaceId = document.windowsById[middleWindowId]!.activeTabId!;

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

  it("moves the active tab into the adjacent pane and collapses the source pane if empty", async () => {
    getTestWindow();
    const { useWorkspaceStore } = await import("./store");
    const { serverThreadSurfaceInput } = await import("./types");
    const threadA = scopeThreadRef("environment-a" as never, "thread-a" as never);
    const threadB = scopeThreadRef("environment-b" as never, "thread-b" as never);

    useWorkspaceStore.getState().resetWorkspace();
    useWorkspaceStore.getState().openThreadSurface(serverThreadSurfaceInput(threadA));
    useWorkspaceStore.getState().openThreadInSplit(serverThreadSurfaceInput(threadB), "x");
    useWorkspaceStore.getState().focusAdjacentWindow("left");

    const sourceWindowId = useWorkspaceStore.getState().document.focusedWindowId!;
    useWorkspaceStore.getState().moveActiveTabToAdjacentWindow("right");

    const nextDocument = useWorkspaceStore.getState().document;
    expect(nextDocument.windowsById[sourceWindowId]).toBeUndefined();
    expect(Object.keys(nextDocument.windowsById)).toHaveLength(1);
    const remainingWindowId = nextDocument.focusedWindowId!;
    expect(nextDocument.windowsById[remainingWindowId]!.tabIds).toHaveLength(2);
    expect(nextDocument.nodesById[nextDocument.rootNodeId!]?.kind).toBe("window");
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
