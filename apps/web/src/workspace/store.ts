import { useMemo } from "react";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";

import {
  readBrowserWorkspaceDocument,
  writeBrowserWorkspaceDocument,
} from "../clientPersistenceStorage";
import { randomUUID } from "../lib/utils";
import { selectThreadTerminalState, useTerminalStateStore } from "../terminalStateStore";
import type { ThreadRouteTarget } from "../threadRoutes";
import { DEFAULT_THREAD_TERMINAL_ID } from "../types";
import {
  createEmptyWorkspaceDocument,
  isWorkspaceDocument,
  normalizeWorkspacePaperColumnWidths,
  normalizeWorkspaceSplitSizes,
  routeTargetForSurface,
  sameTerminalSurfaceInput,
  sameThreadSurfaceInput,
  type TerminalSurfaceInput,
  type ThreadSurfaceInput,
  type WorkspaceAxis,
  type WorkspaceDirection,
  type WorkspaceDocument,
  type WorkspaceLayoutEngine,
  type WorkspaceNode,
  type WorkspacePlacementTarget,
  type WorkspaceSurfaceInstance,
  type WorkspaceWindow,
} from "./types";

type OpenThreadDisposition = "focus-or-replace" | "split-right" | "split-down";
type OpenTerminalDisposition = OpenThreadDisposition;

const WORKSPACE_PERSIST_DEBOUNCE_MS = 150;
const WORKSPACE_RESIZE_STEP = 0.08;
const WORKSPACE_MIN_RESIZE_FRACTION = 0.12;
const WORKSPACE_MIN_PAPER_COLUMN_WIDTH = 0.45;

let persistTimer: number | null = null;
const WINDOW_RECT_EPSILON = 0.001;

function scheduleWorkspacePersistence(document: WorkspaceDocument): void {
  if (typeof window === "undefined") {
    return;
  }

  if (persistTimer !== null) {
    window.clearTimeout(persistTimer);
  }

  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    writeBrowserWorkspaceDocument(document);
  }, WORKSPACE_PERSIST_DEBOUNCE_MS);
}

function nextWorkspaceId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function nextTerminalSessionId(): string {
  return `terminal-${randomUUID()}`;
}

function equalSplitSizes(childCount: number): number[] {
  return normalizeWorkspaceSplitSizes(undefined, childCount);
}

function equalPaperColumnWidths(childCount: number): number[] {
  return normalizeWorkspacePaperColumnWidths(undefined, childCount);
}

function createThreadSurface(input: ThreadSurfaceInput): WorkspaceSurfaceInstance {
  return {
    id: nextWorkspaceId("surface"),
    kind: "thread",
    input,
  };
}

function createTerminalSurface(input: TerminalSurfaceInput): WorkspaceSurfaceInstance {
  return {
    id: nextWorkspaceId("surface"),
    kind: "terminal",
    input,
  };
}

function duplicateSurface(surface: WorkspaceSurfaceInstance): WorkspaceSurfaceInstance {
  if (surface.kind === "thread") {
    return createThreadSurface(surface.input);
  }

  return createTerminalSurface({
    ...surface.input,
    terminalId: nextTerminalSessionId(),
  });
}

function cloneWindow(window: WorkspaceWindow): WorkspaceWindow {
  return {
    ...window,
  };
}

function getWindowBySurfaceId(
  document: WorkspaceDocument,
  surfaceId: string,
): { windowId: string; window: WorkspaceWindow } | null {
  for (const [windowId, window] of Object.entries(document.windowsById)) {
    if (window.surfaceId === surfaceId) {
      return { windowId, window };
    }
  }

  return null;
}

interface WorkspaceWindowRect {
  windowId: string;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function getWindowNodeByWindowId(
  document: WorkspaceDocument,
  windowId: string,
): { nodeId: string; node: Extract<WorkspaceNode, { kind: "window" }> } | null {
  for (const [nodeId, node] of Object.entries(document.nodesById)) {
    if (node.kind === "window" && node.windowId === windowId) {
      return { nodeId, node };
    }
  }

  return null;
}

function collectWindowRects(
  document: WorkspaceDocument,
  nodeId: string | null,
  rect: Omit<WorkspaceWindowRect, "windowId">,
  rects: WorkspaceWindowRect[],
): void {
  if (!nodeId) {
    return;
  }

  const node = document.nodesById[nodeId];
  if (!node) {
    return;
  }

  if (node.kind === "window") {
    rects.push({
      windowId: node.windowId,
      ...rect,
    });
    return;
  }

  if (node.kind === "paper-root") {
    const widths = normalizeWorkspacePaperColumnWidths(node.widths, node.childIds.length);
    let cursor = 0;

    for (const [index, childId] of node.childIds.entries()) {
      const width = widths[index] ?? 1;
      const nextCursor = cursor + width;
      collectWindowRects(
        document,
        childId,
        {
          left: cursor,
          top: 0,
          right: nextCursor,
          bottom: 1,
        },
        rects,
      );
      cursor = nextCursor;
    }

    return;
  }

  const sizes = normalizeWorkspaceSplitSizes(node.sizes, node.childIds.length);
  const axis = node.kind === "paper-column" ? "y" : node.axis;
  let cursor = axis === "x" ? rect.left : rect.top;

  for (const [index, childId] of node.childIds.entries()) {
    const size = sizes[index] ?? 0;
    if (axis === "x") {
      const nextCursor = cursor + (rect.right - rect.left) * size;
      collectWindowRects(
        document,
        childId,
        {
          left: cursor,
          top: rect.top,
          right: nextCursor,
          bottom: rect.bottom,
        },
        rects,
      );
      cursor = nextCursor;
      continue;
    }

    const nextCursor = cursor + (rect.bottom - rect.top) * size;
    collectWindowRects(
      document,
      childId,
      {
        left: rect.left,
        top: cursor,
        right: rect.right,
        bottom: nextCursor,
      },
      rects,
    );
    cursor = nextCursor;
  }
}

function getWorkspaceWindowRects(document: WorkspaceDocument): WorkspaceWindowRect[] {
  const rects: WorkspaceWindowRect[] = [];
  collectWindowRects(
    document,
    document.rootNodeId,
    {
      left: 0,
      top: 0,
      right: 1,
      bottom: 1,
    },
    rects,
  );
  return rects;
}

function getOrderedWorkspaceWindowIds(document: WorkspaceDocument): string[] {
  return getWorkspaceWindowRects(document)
    .toSorted((left, right) => {
      if (document.layoutEngine === "paper") {
        const leftDelta = left.left - right.left;
        if (Math.abs(leftDelta) > WINDOW_RECT_EPSILON) {
          return leftDelta;
        }
        return left.top - right.top;
      }

      const topDelta = left.top - right.top;
      if (Math.abs(topDelta) > WINDOW_RECT_EPSILON) {
        return topDelta;
      }
      return left.left - right.left;
    })
    .map((rect) => rect.windowId);
}

function axisOverlapLength(startA: number, endA: number, startB: number, endB: number): number {
  return Math.max(0, Math.min(endA, endB) - Math.max(startA, startB));
}

function findAdjacentWindowId(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  direction: WorkspaceDirection,
): string | null {
  if (!sourceWindowId) {
    return null;
  }

  const rects = getWorkspaceWindowRects(document);
  const sourceRect = rects.find((rect) => rect.windowId === sourceWindowId);
  if (!sourceRect) {
    return null;
  }

  let bestMatch: { windowId: string; gap: number; overlap: number } | null = null;

  for (const candidate of rects) {
    if (candidate.windowId === sourceWindowId) {
      continue;
    }

    let gap: number;
    let overlap: number;

    switch (direction) {
      case "left":
        gap = sourceRect.left - candidate.right;
        overlap = axisOverlapLength(
          sourceRect.top,
          sourceRect.bottom,
          candidate.top,
          candidate.bottom,
        );
        break;
      case "right":
        gap = candidate.left - sourceRect.right;
        overlap = axisOverlapLength(
          sourceRect.top,
          sourceRect.bottom,
          candidate.top,
          candidate.bottom,
        );
        break;
      case "up":
        gap = sourceRect.top - candidate.bottom;
        overlap = axisOverlapLength(
          sourceRect.left,
          sourceRect.right,
          candidate.left,
          candidate.right,
        );
        break;
      case "down":
        gap = candidate.top - sourceRect.bottom;
        overlap = axisOverlapLength(
          sourceRect.left,
          sourceRect.right,
          candidate.left,
          candidate.right,
        );
        break;
    }

    if (gap < -WINDOW_RECT_EPSILON || overlap <= WINDOW_RECT_EPSILON) {
      continue;
    }

    const normalizedGap = Math.max(0, gap);
    if (
      !bestMatch ||
      normalizedGap < bestMatch.gap - WINDOW_RECT_EPSILON ||
      (Math.abs(normalizedGap - bestMatch.gap) <= WINDOW_RECT_EPSILON &&
        overlap > bestMatch.overlap + WINDOW_RECT_EPSILON)
    ) {
      bestMatch = {
        windowId: candidate.windowId,
        gap: normalizedGap,
        overlap,
      };
    }
  }

  return bestMatch?.windowId ?? null;
}

function findParentNode(
  document: WorkspaceDocument,
  childNodeId: string,
): { parentId: string; parent: Extract<WorkspaceNode, { kind: "split" }>; index: number } | null {
  for (const [parentId, node] of Object.entries(document.nodesById)) {
    if (node.kind !== "split") {
      continue;
    }

    const index = node.childIds.indexOf(childNodeId);
    if (index >= 0) {
      return { parentId, parent: node, index };
    }
  }

  return null;
}

function getPaperRootNode(
  document: WorkspaceDocument,
): { nodeId: string; node: Extract<WorkspaceNode, { kind: "paper-root" }> } | null {
  if (!document.rootNodeId) {
    return null;
  }
  const node = document.nodesById[document.rootNodeId];
  if (!node || node.kind !== "paper-root") {
    return null;
  }
  return { nodeId: document.rootNodeId, node };
}

function getPaperColumnByWindowId(
  document: WorkspaceDocument,
  windowId: string,
): {
  columnId: string;
  column: Extract<WorkspaceNode, { kind: "paper-column" }>;
  root: Extract<WorkspaceNode, { kind: "paper-root" }>;
  rootId: string;
  windowNodeId: string;
  windowIndex: number;
  columnIndex: number;
} | null {
  const root = getPaperRootNode(document);
  const windowNode = getWindowNodeByWindowId(document, windowId);
  if (!root || !windowNode) {
    return null;
  }

  for (const [columnIndex, columnId] of root.node.childIds.entries()) {
    const column = document.nodesById[columnId];
    if (!column || column.kind !== "paper-column") {
      continue;
    }

    const windowIndex = column.childIds.indexOf(windowNode.nodeId);
    if (windowIndex >= 0) {
      return {
        columnId,
        column,
        root: root.node,
        rootId: root.nodeId,
        windowNodeId: windowNode.nodeId,
        windowIndex,
        columnIndex,
      };
    }
  }

  return null;
}

function createPaperTreeForWindow(options: {
  surface: WorkspaceSurfaceInstance;
  document: WorkspaceDocument;
}): WorkspaceDocument {
  const rootNodeId = nextWorkspaceId("node");
  const columnNodeId = nextWorkspaceId("node");
  const windowNodeId = nextWorkspaceId("node");
  const windowId = nextWorkspaceId("window");

  return {
    ...options.document,
    layoutEngine: "paper",
    rootNodeId,
    nodesById: {
      [rootNodeId]: {
        id: rootNodeId,
        kind: "paper-root",
        childIds: [columnNodeId],
        widths: [1],
        sizingMode: "auto",
      },
      [columnNodeId]: {
        id: columnNodeId,
        kind: "paper-column",
        childIds: [windowNodeId],
        sizes: [1],
        sizingMode: "auto",
      },
      [windowNodeId]: {
        id: windowNodeId,
        kind: "window",
        windowId,
      },
    },
    windowsById: {
      [windowId]: {
        id: windowId,
        surfaceId: options.surface.id,
      },
    },
    surfacesById: {
      ...options.document.surfacesById,
      [options.surface.id]: options.surface,
    },
    focusedWindowId: windowId,
    mobileActiveWindowId: windowId,
  };
}

function normalizePaperColumnSizes(
  column: Extract<WorkspaceNode, { kind: "paper-column" }>,
  sizes?: number[] | null,
): number[] {
  return normalizeWorkspaceSplitSizes(sizes ?? column.sizes, column.childIds.length);
}

function firstWindowId(document: WorkspaceDocument): string | null {
  if (document.focusedWindowId && document.windowsById[document.focusedWindowId]) {
    return document.focusedWindowId;
  }

  return Object.keys(document.windowsById)[0] ?? null;
}

function focusWindowByStep(document: WorkspaceDocument, step: -1 | 1): WorkspaceDocument {
  const windowIds = getOrderedWorkspaceWindowIds(document);
  if (windowIds.length <= 1) {
    return document;
  }

  const sourceWindowId = firstWindowId(document);
  if (!sourceWindowId) {
    return document;
  }

  const sourceIndex = windowIds.indexOf(sourceWindowId);
  if (sourceIndex < 0) {
    return document;
  }

  const nextIndex = (sourceIndex + step + windowIds.length) % windowIds.length;
  return setFocusedWindow(document, windowIds[nextIndex] ?? null);
}

function getFocusedSurface(document: WorkspaceDocument): WorkspaceSurfaceInstance | null {
  const windowId = firstWindowId(document);
  if (!windowId) {
    return null;
  }
  const window = document.windowsById[windowId];
  const surfaceId = window?.surfaceId ?? null;
  return surfaceId ? (document.surfacesById[surfaceId] ?? null) : null;
}

function setFocusedWindow(document: WorkspaceDocument, windowId: string | null): WorkspaceDocument {
  if (document.focusedWindowId === windowId && document.mobileActiveWindowId === windowId) {
    return document;
  }

  return {
    ...document,
    focusedWindowId: windowId,
    mobileActiveWindowId: windowId,
  };
}

function focusSurfaceById(document: WorkspaceDocument, surfaceId: string): WorkspaceDocument {
  const located = getWindowBySurfaceId(document, surfaceId);
  if (!located) {
    return document;
  }

  if (
    located.window.surfaceId === surfaceId &&
    document.focusedWindowId === located.windowId &&
    document.mobileActiveWindowId === located.windowId
  ) {
    return document;
  }

  const nextWindow = cloneWindow(located.window);
  nextWindow.surfaceId = surfaceId;

  return {
    ...document,
    windowsById: {
      ...document.windowsById,
      [located.windowId]: nextWindow,
    },
    focusedWindowId: located.windowId,
    mobileActiveWindowId: located.windowId,
  };
}

function replaceWindowSurface(
  document: WorkspaceDocument,
  windowId: string,
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  const currentWindow = document.windowsById[windowId];
  if (!currentWindow) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const nextSurfacesById = { ...document.surfacesById, [surface.id]: surface };
  const previousSurfaceId = currentWindow.surfaceId;
  if (previousSurfaceId && previousSurfaceId !== surface.id) {
    delete nextSurfacesById[previousSurfaceId];
  }

  return {
    ...document,
    windowsById: {
      ...document.windowsById,
      [windowId]: {
        ...currentWindow,
        surfaceId: surface.id,
      },
    },
    surfacesById: nextSurfacesById,
    focusedWindowId: windowId,
    mobileActiveWindowId: windowId,
  };
}

function insertSurfaceIntoWindow(
  document: WorkspaceDocument,
  windowId: string | null,
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  if (!windowId || !document.windowsById[windowId]) {
    if (document.layoutEngine === "paper") {
      return createPaperTreeForWindow({ document, surface });
    }

    const nextWindowId = nextWorkspaceId("window");
    const nextNodeId = nextWorkspaceId("node");
    return {
      ...document,
      rootNodeId: nextNodeId,
      nodesById: {
        [nextNodeId]: {
          id: nextNodeId,
          kind: "window",
          windowId: nextWindowId,
        },
      },
      windowsById: {
        [nextWindowId]: {
          id: nextWindowId,
          surfaceId: surface.id,
        },
      },
      surfacesById: {
        ...document.surfacesById,
        [surface.id]: surface,
      },
      focusedWindowId: nextWindowId,
      mobileActiveWindowId: nextWindowId,
    };
  }

  return replaceWindowSurface(document, windowId, surface);
}

function placementToSplitParams(placement: "left" | "right" | "top" | "bottom"): {
  axis: WorkspaceAxis;
  insertBefore: boolean;
} {
  switch (placement) {
    case "left":
      return { axis: "x", insertBefore: true };
    case "right":
      return { axis: "x", insertBefore: false };
    case "top":
      return { axis: "y", insertBefore: true };
    case "bottom":
      return { axis: "y", insertBefore: false };
  }
}

function splitPaperWindowWithSurface(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  axis: WorkspaceAxis,
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  if (!sourceWindowId || !document.windowsById[sourceWindowId]) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const sourceColumn = getPaperColumnByWindowId(document, sourceWindowId);
  if (!sourceColumn) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const nextWindowId = nextWorkspaceId("window");
  const nextWindowNodeId = nextWorkspaceId("node");
  const nextWindowNode: WorkspaceNode = {
    id: nextWindowNodeId,
    kind: "window",
    windowId: nextWindowId,
  };
  const nextNodesById: Record<string, WorkspaceNode> = {
    ...document.nodesById,
    [nextWindowNodeId]: nextWindowNode,
  };

  if (axis === "y") {
    const nextChildIds = [
      ...sourceColumn.column.childIds.slice(0, sourceColumn.windowIndex + 1),
      nextWindowNodeId,
      ...sourceColumn.column.childIds.slice(sourceColumn.windowIndex + 1),
    ];
    nextNodesById[sourceColumn.columnId] = {
      ...sourceColumn.column,
      childIds: nextChildIds,
      sizes:
        sourceColumn.column.sizingMode === "manual"
          ? normalizeWorkspaceSplitSizes(
              [
                ...sourceColumn.column.sizes.slice(0, sourceColumn.windowIndex + 1),
                sourceColumn.column.sizes[sourceColumn.windowIndex] ?? 1,
                ...sourceColumn.column.sizes.slice(sourceColumn.windowIndex + 1),
              ],
              nextChildIds.length,
            )
          : equalSplitSizes(nextChildIds.length),
      sizingMode: sourceColumn.column.sizingMode,
    };

    return {
      ...document,
      nodesById: nextNodesById,
      windowsById: {
        ...document.windowsById,
        [nextWindowId]: {
          id: nextWindowId,
          surfaceId: surface.id,
        },
      },
      surfacesById: {
        ...document.surfacesById,
        [surface.id]: surface,
      },
      focusedWindowId: nextWindowId,
      mobileActiveWindowId: nextWindowId,
    };
  }

  const nextColumnId = nextWorkspaceId("node");
  nextNodesById[nextColumnId] = {
    id: nextColumnId,
    kind: "paper-column",
    childIds: [nextWindowNodeId],
    sizes: [1],
    sizingMode: "auto",
  };

  const nextChildIds = [
    ...sourceColumn.root.childIds.slice(0, sourceColumn.columnIndex + 1),
    nextColumnId,
    ...sourceColumn.root.childIds.slice(sourceColumn.columnIndex + 1),
  ];

  nextNodesById[sourceColumn.rootId] = {
    ...sourceColumn.root,
    childIds: nextChildIds,
    widths:
      sourceColumn.root.sizingMode === "manual"
        ? normalizeWorkspacePaperColumnWidths(
            [
              ...sourceColumn.root.widths.slice(0, sourceColumn.columnIndex + 1),
              sourceColumn.root.widths[sourceColumn.columnIndex] ?? 1,
              ...sourceColumn.root.widths.slice(sourceColumn.columnIndex + 1),
            ],
            nextChildIds.length,
          )
        : equalPaperColumnWidths(nextChildIds.length),
    sizingMode: sourceColumn.root.sizingMode,
  };

  return {
    ...document,
    nodesById: nextNodesById,
    windowsById: {
      ...document.windowsById,
      [nextWindowId]: {
        id: nextWindowId,
        surfaceId: surface.id,
      },
    },
    surfacesById: {
      ...document.surfacesById,
      [surface.id]: surface,
    },
    focusedWindowId: nextWindowId,
    mobileActiveWindowId: nextWindowId,
  };
}

function splitPaperWindowWithSurfaceAtEdge(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  placement: "left" | "right" | "top" | "bottom",
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  if (!sourceWindowId || !document.windowsById[sourceWindowId]) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const sourceColumn = getPaperColumnByWindowId(document, sourceWindowId);
  if (!sourceColumn) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const nextWindowId = nextWorkspaceId("window");
  const nextWindowNodeId = nextWorkspaceId("node");
  const nextWindowNode: WorkspaceNode = {
    id: nextWindowNodeId,
    kind: "window",
    windowId: nextWindowId,
  };
  const nextNodesById: Record<string, WorkspaceNode> = {
    ...document.nodesById,
    [nextWindowNodeId]: nextWindowNode,
  };

  if (placement === "top" || placement === "bottom") {
    const insertIndex =
      placement === "top" ? sourceColumn.windowIndex : sourceColumn.windowIndex + 1;
    const nextChildIds = [
      ...sourceColumn.column.childIds.slice(0, insertIndex),
      nextWindowNodeId,
      ...sourceColumn.column.childIds.slice(insertIndex),
    ];
    nextNodesById[sourceColumn.columnId] = {
      ...sourceColumn.column,
      childIds: nextChildIds,
      sizes:
        sourceColumn.column.sizingMode === "manual"
          ? normalizeWorkspaceSplitSizes(
              [
                ...sourceColumn.column.sizes.slice(0, insertIndex),
                sourceColumn.column.sizes[sourceColumn.windowIndex] ?? 1,
                ...sourceColumn.column.sizes.slice(insertIndex),
              ],
              nextChildIds.length,
            )
          : equalSplitSizes(nextChildIds.length),
      sizingMode: sourceColumn.column.sizingMode,
    };

    return {
      ...document,
      nodesById: nextNodesById,
      windowsById: {
        ...document.windowsById,
        [nextWindowId]: {
          id: nextWindowId,
          surfaceId: surface.id,
        },
      },
      surfacesById: {
        ...document.surfacesById,
        [surface.id]: surface,
      },
      focusedWindowId: nextWindowId,
      mobileActiveWindowId: nextWindowId,
    };
  }

  const nextColumnId = nextWorkspaceId("node");
  nextNodesById[nextColumnId] = {
    id: nextColumnId,
    kind: "paper-column",
    childIds: [nextWindowNodeId],
    sizes: [1],
    sizingMode: "auto",
  };

  const insertIndex =
    placement === "left" ? sourceColumn.columnIndex : sourceColumn.columnIndex + 1;
  const nextChildIds = [
    ...sourceColumn.root.childIds.slice(0, insertIndex),
    nextColumnId,
    ...sourceColumn.root.childIds.slice(insertIndex),
  ];

  nextNodesById[sourceColumn.rootId] = {
    ...sourceColumn.root,
    childIds: nextChildIds,
    widths:
      sourceColumn.root.sizingMode === "manual"
        ? normalizeWorkspacePaperColumnWidths(
            [
              ...sourceColumn.root.widths.slice(0, insertIndex),
              sourceColumn.root.widths[sourceColumn.columnIndex] ?? 1,
              ...sourceColumn.root.widths.slice(insertIndex),
            ],
            nextChildIds.length,
          )
        : equalPaperColumnWidths(nextChildIds.length),
    sizingMode: sourceColumn.root.sizingMode,
  };

  return {
    ...document,
    nodesById: nextNodesById,
    windowsById: {
      ...document.windowsById,
      [nextWindowId]: {
        id: nextWindowId,
        surfaceId: surface.id,
      },
    },
    surfacesById: {
      ...document.surfacesById,
      [surface.id]: surface,
    },
    focusedWindowId: nextWindowId,
    mobileActiveWindowId: nextWindowId,
  };
}

function splitWindowWithSurface(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  axis: WorkspaceAxis,
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  if (document.layoutEngine === "paper") {
    return splitPaperWindowWithSurface(document, sourceWindowId, axis, surface);
  }

  if (!sourceWindowId || !document.windowsById[sourceWindowId]) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const sourceNode = getWindowNodeByWindowId(document, sourceWindowId);
  if (!sourceNode) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const parent = findParentNode(document, sourceNode.nodeId);
  const nextWindowId = nextWorkspaceId("window");
  const nextWindowNodeId = nextWorkspaceId("node");
  const nextWindowNode: WorkspaceNode = {
    id: nextWindowNodeId,
    kind: "window",
    windowId: nextWindowId,
  };
  const nextNodesById: Record<string, WorkspaceNode> = {
    ...document.nodesById,
    [nextWindowNodeId]: nextWindowNode,
  };

  if (parent && parent.parent.axis === axis && parent.parent.sizingMode === "auto") {
    const nextChildIds = [
      ...parent.parent.childIds.slice(0, parent.index + 1),
      nextWindowNodeId,
      ...parent.parent.childIds.slice(parent.index + 1),
    ];
    nextNodesById[parent.parentId] = {
      ...parent.parent,
      childIds: nextChildIds,
      sizes: equalSplitSizes(nextChildIds.length),
      sizingMode: "auto",
    };

    return {
      ...document,
      nodesById: nextNodesById,
      windowsById: {
        ...document.windowsById,
        [nextWindowId]: {
          id: nextWindowId,
          surfaceId: surface.id,
        },
      },
      surfacesById: {
        ...document.surfacesById,
        [surface.id]: surface,
      },
      focusedWindowId: nextWindowId,
      mobileActiveWindowId: nextWindowId,
    };
  }

  const nextSplitNodeId = nextWorkspaceId("node");
  const nextSplitNode: WorkspaceNode = {
    id: nextSplitNodeId,
    kind: "split",
    axis,
    childIds: [sourceNode.nodeId, nextWindowNodeId],
    sizes: equalSplitSizes(2),
    sizingMode: "auto",
  };
  nextNodesById[nextSplitNodeId] = nextSplitNode;

  let nextRootNodeId = document.rootNodeId;
  if (!parent) {
    nextRootNodeId = nextSplitNodeId;
  } else {
    nextNodesById[parent.parentId] = {
      ...parent.parent,
      childIds: parent.parent.childIds.map((childId, index) =>
        index === parent.index ? nextSplitNodeId : childId,
      ),
    };
  }

  return {
    ...document,
    rootNodeId: nextRootNodeId,
    nodesById: nextNodesById,
    windowsById: {
      ...document.windowsById,
      [nextWindowId]: {
        id: nextWindowId,
        surfaceId: surface.id,
      },
    },
    surfacesById: {
      ...document.surfacesById,
      [surface.id]: surface,
    },
    focusedWindowId: nextWindowId,
    mobileActiveWindowId: nextWindowId,
  };
}

function splitWindowWithSurfaceAtEdge(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  placement: "left" | "right" | "top" | "bottom",
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  if (document.layoutEngine === "paper") {
    return splitPaperWindowWithSurfaceAtEdge(document, sourceWindowId, placement, surface);
  }

  if (!sourceWindowId || !document.windowsById[sourceWindowId]) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const { axis, insertBefore } = placementToSplitParams(placement);
  const sourceNode = getWindowNodeByWindowId(document, sourceWindowId);
  if (!sourceNode) {
    return insertSurfaceIntoWindow(document, null, surface);
  }

  const parent = findParentNode(document, sourceNode.nodeId);
  const nextWindowId = nextWorkspaceId("window");
  const nextWindowNodeId = nextWorkspaceId("node");
  const nextWindowNode: WorkspaceNode = {
    id: nextWindowNodeId,
    kind: "window",
    windowId: nextWindowId,
  };
  const nextNodesById: Record<string, WorkspaceNode> = {
    ...document.nodesById,
    [nextWindowNodeId]: nextWindowNode,
  };

  if (parent && parent.parent.axis === axis && parent.parent.sizingMode === "auto") {
    const insertIndex = insertBefore ? parent.index : parent.index + 1;
    const nextChildIds = [
      ...parent.parent.childIds.slice(0, insertIndex),
      nextWindowNodeId,
      ...parent.parent.childIds.slice(insertIndex),
    ];
    nextNodesById[parent.parentId] = {
      ...parent.parent,
      childIds: nextChildIds,
      sizes: equalSplitSizes(nextChildIds.length),
      sizingMode: "auto",
    };

    return {
      ...document,
      nodesById: nextNodesById,
      windowsById: {
        ...document.windowsById,
        [nextWindowId]: {
          id: nextWindowId,
          surfaceId: surface.id,
        },
      },
      surfacesById: {
        ...document.surfacesById,
        [surface.id]: surface,
      },
      focusedWindowId: nextWindowId,
      mobileActiveWindowId: nextWindowId,
    };
  }

  const nextSplitNodeId = nextWorkspaceId("node");
  const childIds = insertBefore
    ? [nextWindowNodeId, sourceNode.nodeId]
    : [sourceNode.nodeId, nextWindowNodeId];
  const nextSplitNode: WorkspaceNode = {
    id: nextSplitNodeId,
    kind: "split",
    axis,
    childIds,
    sizes: equalSplitSizes(2),
    sizingMode: "auto",
  };
  nextNodesById[nextSplitNodeId] = nextSplitNode;

  let nextRootNodeId = document.rootNodeId;
  if (!parent) {
    nextRootNodeId = nextSplitNodeId;
  } else {
    nextNodesById[parent.parentId] = {
      ...parent.parent,
      childIds: parent.parent.childIds.map((childId, index) =>
        index === parent.index ? nextSplitNodeId : childId,
      ),
    };
  }

  return {
    ...document,
    rootNodeId: nextRootNodeId,
    nodesById: nextNodesById,
    windowsById: {
      ...document.windowsById,
      [nextWindowId]: {
        id: nextWindowId,
        surfaceId: surface.id,
      },
    },
    surfacesById: {
      ...document.surfacesById,
      [surface.id]: surface,
    },
    focusedWindowId: nextWindowId,
    mobileActiveWindowId: nextWindowId,
  };
}

function setWorkspaceSplitNodeSizes(
  document: WorkspaceDocument,
  nodeId: string,
  sizes: number[],
): WorkspaceDocument {
  const node = document.nodesById[nodeId];
  if (!node || (node.kind !== "split" && node.kind !== "paper-column")) {
    return document;
  }

  const currentSizes = normalizeWorkspaceSplitSizes(node.sizes, node.childIds.length);
  const nextSizes = normalizeWorkspaceSplitSizes(sizes, node.childIds.length);
  const changed = currentSizes.some(
    (size, index) => Math.abs(size - (nextSizes[index] ?? 0)) > 0.001,
  );
  if (!changed) {
    return document;
  }

  return {
    ...document,
    nodesById: {
      ...document.nodesById,
      [nodeId]: {
        ...node,
        sizes: nextSizes,
        sizingMode: "manual",
      },
    },
  };
}

function setPaperRootWidths(
  document: WorkspaceDocument,
  nodeId: string,
  widths: number[],
): WorkspaceDocument {
  const node = document.nodesById[nodeId];
  if (!node || node.kind !== "paper-root") {
    return document;
  }

  const currentWidths = normalizeWorkspacePaperColumnWidths(node.widths, node.childIds.length);
  const nextWidths = normalizeWorkspacePaperColumnWidths(widths, node.childIds.length);
  const changed = currentWidths.some(
    (width, index) => Math.abs(width - (nextWidths[index] ?? 0)) > 0.001,
  );
  if (!changed) {
    return document;
  }

  return {
    ...document,
    nodesById: {
      ...document.nodesById,
      [nodeId]: {
        ...node,
        widths: nextWidths,
        sizingMode: "manual",
      },
    },
  };
}

function removeChildFromSplitNode(
  node: Extract<WorkspaceNode, { kind: "split" }>,
  removeIndex: number,
): Extract<WorkspaceNode, { kind: "split" }> {
  const nextChildIds = node.childIds.filter((_, index) => index !== removeIndex);
  const nextSizes =
    node.sizingMode === "manual"
      ? normalizeWorkspaceSplitSizes(
          node.sizes.filter((_, index) => index !== removeIndex),
          nextChildIds.length,
        )
      : equalSplitSizes(nextChildIds.length);

  return {
    ...node,
    childIds: nextChildIds,
    sizes: nextSizes,
  };
}

function collapseSplitNode(
  nodesById: Record<string, WorkspaceNode>,
  splitNodeId: string,
): { nodesById: Record<string, WorkspaceNode>; replacementNodeId: string | null } {
  const splitNode = nodesById[splitNodeId];
  if (!splitNode || splitNode.kind !== "split") {
    return { nodesById, replacementNodeId: null };
  }

  if (splitNode.childIds.length === 0) {
    const { [splitNodeId]: _removed, ...rest } = nodesById;
    return { nodesById: rest, replacementNodeId: null };
  }

  if (splitNode.childIds.length > 1) {
    return { nodesById, replacementNodeId: splitNodeId };
  }

  const replacementNodeId = splitNode.childIds[0] ?? null;
  const { [splitNodeId]: _removed, ...rest } = nodesById;
  return { nodesById: rest, replacementNodeId };
}

function removeWindowNodeFromPaperTree(
  document: WorkspaceDocument,
  windowId: string,
): Pick<WorkspaceDocument, "rootNodeId" | "nodesById"> {
  const paperColumn = getPaperColumnByWindowId(document, windowId);
  if (!paperColumn) {
    return {
      rootNodeId: document.rootNodeId,
      nodesById: document.nodesById,
    };
  }

  const nextNodesById = { ...document.nodesById };
  delete nextNodesById[paperColumn.windowNodeId];

  const nextColumnChildIds = paperColumn.column.childIds.filter(
    (_, index) => index !== paperColumn.windowIndex,
  );

  if (nextColumnChildIds.length > 0) {
    nextNodesById[paperColumn.columnId] = {
      ...paperColumn.column,
      childIds: nextColumnChildIds,
      sizes:
        paperColumn.column.sizingMode === "manual"
          ? normalizeWorkspaceSplitSizes(
              paperColumn.column.sizes.filter((_, index) => index !== paperColumn.windowIndex),
              nextColumnChildIds.length,
            )
          : equalSplitSizes(nextColumnChildIds.length),
    };

    return {
      rootNodeId: document.rootNodeId,
      nodesById: nextNodesById,
    };
  }

  delete nextNodesById[paperColumn.columnId];
  const nextRootChildIds = paperColumn.root.childIds.filter(
    (_, index) => index !== paperColumn.columnIndex,
  );

  if (nextRootChildIds.length === 0) {
    delete nextNodesById[paperColumn.rootId];
    return {
      rootNodeId: null,
      nodesById: nextNodesById,
    };
  }

  nextNodesById[paperColumn.rootId] = {
    ...paperColumn.root,
    childIds: nextRootChildIds,
    widths:
      paperColumn.root.sizingMode === "manual"
        ? normalizeWorkspacePaperColumnWidths(
            paperColumn.root.widths.filter((_, index) => index !== paperColumn.columnIndex),
            nextRootChildIds.length,
          )
        : equalPaperColumnWidths(nextRootChildIds.length),
  };

  return {
    rootNodeId: paperColumn.rootId,
    nodesById: nextNodesById,
  };
}

function removeWindowNodeFromTree(
  document: WorkspaceDocument,
  windowId: string,
): Pick<WorkspaceDocument, "rootNodeId" | "nodesById"> {
  if (document.layoutEngine === "paper") {
    return removeWindowNodeFromPaperTree(document, windowId);
  }

  const windowNode = getWindowNodeByWindowId(document, windowId);
  if (!windowNode) {
    return {
      rootNodeId: document.rootNodeId,
      nodesById: document.nodesById,
    };
  }

  let nextNodesById = { ...document.nodesById };
  const { [windowNode.nodeId]: _removedWindowNode, ...nodesWithoutWindowNode } = nextNodesById;
  nextNodesById = nodesWithoutWindowNode;
  let nextRootNodeId = document.rootNodeId;
  let currentNodeId = windowNode.nodeId;

  while (true) {
    const parent = findParentNode(
      { ...document, nodesById: nextNodesById, rootNodeId: nextRootNodeId },
      currentNodeId,
    );
    if (!parent) {
      if (nextRootNodeId === currentNodeId) {
        nextRootNodeId = null;
      }
      break;
    }

    const nextParentNode = removeChildFromSplitNode(parent.parent, parent.index);
    const nextChildIds = nextParentNode.childIds;
    if (nextChildIds.length > 1) {
      nextNodesById[parent.parentId] = nextParentNode;
      break;
    }

    const collapsed = collapseSplitNode(
      {
        ...nextNodesById,
        [parent.parentId]: nextParentNode,
      },
      parent.parentId,
    );
    nextNodesById = collapsed.nodesById;
    if (document.rootNodeId === parent.parentId || nextRootNodeId === parent.parentId) {
      nextRootNodeId = collapsed.replacementNodeId;
    } else {
      const grandparent = findParentNode(
        { ...document, nodesById: nextNodesById, rootNodeId: nextRootNodeId },
        parent.parentId,
      );
      const replacementNodeId = collapsed.replacementNodeId;
      if (grandparent && replacementNodeId) {
        nextNodesById[grandparent.parentId] = {
          ...grandparent.parent,
          childIds: grandparent.parent.childIds.map((childId) =>
            childId === parent.parentId ? replacementNodeId : childId,
          ),
        };
      }
    }
    currentNodeId = parent.parentId;
  }

  return {
    rootNodeId: nextRootNodeId,
    nodesById: nextNodesById,
  };
}

function closeSurfaceById(document: WorkspaceDocument, surfaceId: string): WorkspaceDocument {
  const located = getWindowBySurfaceId(document, surfaceId);
  if (!located) {
    return document;
  }

  const nextSurfacesById = { ...document.surfacesById };
  delete nextSurfacesById[surfaceId];

  const nextWindowsById = { ...document.windowsById };
  delete nextWindowsById[located.windowId];
  const nextTree = removeWindowNodeFromTree(document, located.windowId);
  const fallbackWindowId = Object.keys(nextWindowsById)[0] ?? null;

  return {
    ...document,
    rootNodeId: nextTree.rootNodeId,
    nodesById: nextTree.nodesById,
    windowsById: nextWindowsById,
    surfacesById: nextSurfacesById,
    focusedWindowId: fallbackWindowId,
    mobileActiveWindowId: fallbackWindowId,
  };
}

function closeWindowById(document: WorkspaceDocument, windowId: string): WorkspaceDocument {
  const window = document.windowsById[windowId];
  if (!window) {
    return document;
  }

  const nextSurfacesById = { ...document.surfacesById };
  if (window.surfaceId) {
    delete nextSurfacesById[window.surfaceId];
  }

  const nextWindowsById = { ...document.windowsById };
  delete nextWindowsById[windowId];

  const nextTree = removeWindowNodeFromTree(document, windowId);
  const fallbackWindowId =
    findAdjacentWindowId(document, windowId, "right") ??
    findAdjacentWindowId(document, windowId, "left") ??
    findAdjacentWindowId(document, windowId, "down") ??
    findAdjacentWindowId(document, windowId, "up") ??
    Object.keys(nextWindowsById)[0] ??
    null;

  const focusedWindowId =
    fallbackWindowId && nextWindowsById[fallbackWindowId] ? fallbackWindowId : null;

  return {
    ...document,
    rootNodeId: nextTree.rootNodeId,
    nodesById: nextTree.nodesById,
    windowsById: nextWindowsById,
    surfacesById: nextSurfacesById,
    focusedWindowId,
    mobileActiveWindowId: focusedWindowId,
  };
}

function detachSurfaceFromWindow(
  document: WorkspaceDocument,
  surfaceId: string,
): {
  document: WorkspaceDocument;
  sourceWindowId: string | null;
  surface: WorkspaceSurfaceInstance | null;
} {
  const surface = document.surfacesById[surfaceId] ?? null;
  const located = getWindowBySurfaceId(document, surfaceId);
  if (!surface || !located) {
    return {
      document,
      sourceWindowId: null,
      surface,
    };
  }

  const nextWindowsById = { ...document.windowsById };
  delete nextWindowsById[located.windowId];
  const nextTree = removeWindowNodeFromTree(document, located.windowId);
  const fallbackWindowId = Object.keys(nextWindowsById)[0] ?? null;

  return {
    document: {
      ...document,
      rootNodeId: nextTree.rootNodeId,
      nodesById: nextTree.nodesById,
      windowsById: nextWindowsById,
      focusedWindowId: fallbackWindowId,
      mobileActiveWindowId: fallbackWindowId,
    },
    sourceWindowId: located.windowId,
    surface,
  };
}

function swapWindowSurfaces(
  document: WorkspaceDocument,
  sourceWindowId: string,
  targetWindowId: string,
): WorkspaceDocument {
  if (sourceWindowId === targetWindowId) {
    return document;
  }

  const sourceWindow = document.windowsById[sourceWindowId];
  const targetWindow = document.windowsById[targetWindowId];
  if (!sourceWindow || !targetWindow) {
    return document;
  }

  if (!sourceWindow.surfaceId || !targetWindow.surfaceId) {
    return document;
  }

  return {
    ...document,
    windowsById: {
      ...document.windowsById,
      [sourceWindowId]: {
        ...sourceWindow,
        surfaceId: targetWindow.surfaceId,
      },
      [targetWindowId]: {
        ...targetWindow,
        surfaceId: sourceWindow.surfaceId,
      },
    },
    focusedWindowId: targetWindowId,
    mobileActiveWindowId: targetWindowId,
  };
}

function replaceWindowSurfaceWithNewSurface(
  document: WorkspaceDocument,
  windowId: string,
  surface: WorkspaceSurfaceInstance,
): WorkspaceDocument {
  return replaceWindowSurface(document, windowId, surface);
}

function moveSurfaceToEdge(
  document: WorkspaceDocument,
  surfaceId: string,
  targetWindowId: string,
  placement: "left" | "right" | "top" | "bottom",
): WorkspaceDocument {
  const source = getWindowBySurfaceId(document, surfaceId);
  if (!source || !document.windowsById[targetWindowId]) {
    return document;
  }

  if (source.windowId === targetWindowId) {
    return document;
  }

  const detached = detachSurfaceFromWindow(document, surfaceId);
  const surface = detached.surface;
  if (!surface) {
    return document;
  }

  return splitWindowWithSurfaceAtEdge(detached.document, targetWindowId, placement, surface);
}

function swapWindowNodePositions(
  document: WorkspaceDocument,
  sourceWindowId: string,
  targetWindowId: string,
): WorkspaceDocument {
  if (sourceWindowId === targetWindowId) {
    return document;
  }

  const sourceNode = getWindowNodeByWindowId(document, sourceWindowId);
  const targetNode = getWindowNodeByWindowId(document, targetWindowId);
  if (!sourceNode || !targetNode) {
    return document;
  }

  return {
    ...document,
    nodesById: {
      ...document.nodesById,
      [sourceNode.nodeId]: {
        ...sourceNode.node,
        windowId: targetWindowId,
      },
      [targetNode.nodeId]: {
        ...targetNode.node,
        windowId: sourceWindowId,
      },
    },
  };
}

function findNodePath(
  document: WorkspaceDocument,
  targetNodeId: string,
  currentNodeId = document.rootNodeId,
): string[] | null {
  if (!currentNodeId) {
    return null;
  }
  if (currentNodeId === targetNodeId) {
    return [currentNodeId];
  }

  const currentNode = document.nodesById[currentNodeId];
  if (!currentNode || currentNode.kind !== "split") {
    return null;
  }

  for (const childId of currentNode.childIds) {
    const childPath = findNodePath(document, targetNodeId, childId);
    if (childPath) {
      return [currentNodeId, ...childPath];
    }
  }

  return null;
}

function findResizableSplitAdjustment(
  document: WorkspaceDocument,
  sourceWindowId: string | null,
  direction: WorkspaceDirection,
): {
  growIndex: number;
  shrinkIndex: number;
  splitNode: Extract<WorkspaceNode, { kind: "split" }>;
} | null {
  const targetWindowId = findAdjacentWindowId(document, sourceWindowId, direction);
  if (!sourceWindowId || !targetWindowId) {
    return null;
  }

  const sourceNode = getWindowNodeByWindowId(document, sourceWindowId);
  const targetNode = getWindowNodeByWindowId(document, targetWindowId);
  if (!sourceNode || !targetNode) {
    return null;
  }

  const sourcePath = findNodePath(document, sourceNode.nodeId);
  const targetPath = findNodePath(document, targetNode.nodeId);
  if (!sourcePath || !targetPath) {
    return null;
  }

  let sharedIndex = -1;
  const sharedLength = Math.min(sourcePath.length, targetPath.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (sourcePath[index] !== targetPath[index]) {
      break;
    }
    sharedIndex = index;
  }

  if (sharedIndex < 0) {
    return null;
  }

  const splitNodeId = sourcePath[sharedIndex];
  if (!splitNodeId) {
    return null;
  }
  const splitNode = document.nodesById[splitNodeId];
  const expectedAxis = direction === "left" || direction === "right" ? "x" : "y";
  if (!splitNode || splitNode.kind !== "split" || splitNode.axis !== expectedAxis) {
    return null;
  }

  const sourceBranchId = sourcePath[sharedIndex + 1];
  const targetBranchId = targetPath[sharedIndex + 1];
  const growIndex = splitNode.childIds.indexOf(sourceBranchId ?? "");
  const shrinkIndex = splitNode.childIds.indexOf(targetBranchId ?? "");
  if (growIndex < 0 || shrinkIndex < 0 || growIndex === shrinkIndex) {
    return null;
  }

  return {
    growIndex,
    shrinkIndex,
    splitNode,
  };
}

function resizeFocusedWindow(
  document: WorkspaceDocument,
  direction: WorkspaceDirection,
): WorkspaceDocument {
  if (document.layoutEngine === "paper") {
    const sourceWindowId = firstWindowId(document);
    if (!sourceWindowId) {
      return document;
    }

    const sourceColumn = getPaperColumnByWindowId(document, sourceWindowId);
    if (!sourceColumn) {
      return document;
    }

    if (direction === "left" || direction === "right") {
      const shrinkIndex =
        direction === "left" ? sourceColumn.columnIndex - 1 : sourceColumn.columnIndex + 1;
      if (shrinkIndex < 0 || shrinkIndex >= sourceColumn.root.childIds.length) {
        return document;
      }

      const currentWidths = normalizeWorkspacePaperColumnWidths(
        sourceColumn.root.widths,
        sourceColumn.root.childIds.length,
      );
      const shrinkWidth = currentWidths[shrinkIndex] ?? 0;
      const maxDelta = shrinkWidth - WORKSPACE_MIN_PAPER_COLUMN_WIDTH;
      if (maxDelta <= 0) {
        return document;
      }

      const nextWidths = [...currentWidths];
      const delta = Math.min(WORKSPACE_RESIZE_STEP, maxDelta);
      nextWidths[sourceColumn.columnIndex] = (nextWidths[sourceColumn.columnIndex] ?? 0) + delta;
      nextWidths[shrinkIndex] = shrinkWidth - delta;
      return setPaperRootWidths(document, sourceColumn.rootId, nextWidths);
    }

    const shrinkIndex =
      direction === "up" ? sourceColumn.windowIndex - 1 : sourceColumn.windowIndex + 1;
    if (shrinkIndex < 0 || shrinkIndex >= sourceColumn.column.childIds.length) {
      return document;
    }

    const currentSizes = normalizePaperColumnSizes(sourceColumn.column);
    const shrinkSize = currentSizes[shrinkIndex] ?? 0;
    const maxDelta = shrinkSize - WORKSPACE_MIN_RESIZE_FRACTION;
    if (maxDelta <= 0) {
      return document;
    }

    const nextSizes = [...currentSizes];
    const delta = Math.min(WORKSPACE_RESIZE_STEP, maxDelta);
    nextSizes[sourceColumn.windowIndex] = (nextSizes[sourceColumn.windowIndex] ?? 0) + delta;
    nextSizes[shrinkIndex] = shrinkSize - delta;

    return setWorkspaceSplitNodeSizes(document, sourceColumn.columnId, nextSizes);
  }

  const adjustment = findResizableSplitAdjustment(document, firstWindowId(document), direction);
  if (!adjustment) {
    return document;
  }

  const currentSizes = normalizeWorkspaceSplitSizes(
    adjustment.splitNode.sizes,
    adjustment.splitNode.childIds.length,
  );
  const shrinkSize = currentSizes[adjustment.shrinkIndex] ?? 0;
  const maxDelta = shrinkSize - WORKSPACE_MIN_RESIZE_FRACTION;
  if (maxDelta <= 0) {
    return document;
  }

  const nextSizes = [...currentSizes];
  const delta = Math.min(WORKSPACE_RESIZE_STEP, maxDelta);
  nextSizes[adjustment.growIndex] = (nextSizes[adjustment.growIndex] ?? 0) + delta;
  nextSizes[adjustment.shrinkIndex] = shrinkSize - delta;

  return {
    ...document,
    nodesById: {
      ...document.nodesById,
      [adjustment.splitNode.id]: {
        ...adjustment.splitNode,
        sizes: normalizeWorkspaceSplitSizes(nextSizes, adjustment.splitNode.childIds.length),
        sizingMode: "manual",
      },
    },
  };
}

function equalizeWorkspaceSplits(document: WorkspaceDocument): WorkspaceDocument {
  let changed = false;
  const nextNodesById = Object.fromEntries(
    Object.entries(document.nodesById).map(([nodeId, node]) => {
      if (node.kind === "split" || node.kind === "paper-column") {
        const nextSizes = equalSplitSizes(node.childIds.length);
        const sameSizes =
          node.sizingMode === "auto" &&
          node.sizes.length === nextSizes.length &&
          node.sizes.every((size, index) => Math.abs(size - (nextSizes[index] ?? 0)) <= 0.001);
        if (sameSizes) {
          return [nodeId, node];
        }

        changed = true;
        return [
          nodeId,
          {
            ...node,
            sizes: nextSizes,
            sizingMode: "auto",
          } satisfies WorkspaceNode,
        ];
      }

      if (node.kind === "paper-root") {
        const nextWidths = equalPaperColumnWidths(node.childIds.length);
        const sameWidths =
          node.sizingMode === "auto" &&
          node.widths.length === nextWidths.length &&
          node.widths.every((width, index) => Math.abs(width - (nextWidths[index] ?? 0)) <= 0.001);
        if (sameWidths) {
          return [nodeId, node];
        }

        changed = true;
        return [
          nodeId,
          {
            ...node,
            widths: nextWidths,
            sizingMode: "auto",
          } satisfies WorkspaceNode,
        ];
      }

      return [nodeId, node];
    }),
  ) as Record<string, WorkspaceNode>;

  if (!changed) {
    return document;
  }

  return {
    ...document,
    nodesById: nextNodesById,
  };
}

function findMatchingThreadSurfaceId(
  document: WorkspaceDocument,
  input: ThreadSurfaceInput,
): string | null {
  for (const surface of Object.values(document.surfacesById)) {
    if (surface.kind === "thread" && sameThreadSurfaceInput(surface.input, input)) {
      return surface.id;
    }
  }

  return null;
}

function findMatchingTerminalSurfaceIds(
  document: WorkspaceDocument,
  input: TerminalSurfaceInput,
): string[] {
  return Object.values(document.surfacesById)
    .filter(
      (surface) => surface.kind === "terminal" && sameTerminalSurfaceInput(surface.input, input),
    )
    .map((surface) => surface.id);
}

function findTerminalSurfaceIdsForThread(
  document: WorkspaceDocument,
  threadRef: TerminalSurfaceInput["threadRef"],
): string[] {
  return Object.values(document.surfacesById)
    .filter(
      (surface) =>
        surface.kind === "terminal" &&
        surface.input.threadRef.environmentId === threadRef.environmentId &&
        surface.input.threadRef.threadId === threadRef.threadId,
    )
    .map((surface) => surface.id);
}

function preferredTerminalIdForThread(threadRef: TerminalSurfaceInput["threadRef"]): string {
  return (
    selectThreadTerminalState(useTerminalStateStore.getState().terminalStateByThreadKey, threadRef)
      .activeTerminalId || DEFAULT_THREAD_TERMINAL_ID
  );
}

function terminalSurfaceInputForThread(options: {
  disposition: OpenTerminalDisposition;
  threadRef: TerminalSurfaceInput["threadRef"];
}): TerminalSurfaceInput {
  const { disposition, threadRef } = options;
  return {
    scope: "thread",
    threadRef,
    terminalId:
      disposition === "focus-or-replace"
        ? preferredTerminalIdForThread(threadRef)
        : nextTerminalSessionId(),
  };
}

function buildPaperDocumentFromColumns(
  document: WorkspaceDocument,
  columns: Array<{ width: number; windowIds: string[]; sizes: number[] }>,
): WorkspaceDocument {
  const validColumns = columns
    .map((column) => ({
      width: column.width,
      windowIds: column.windowIds.filter((windowId) => document.windowsById[windowId]),
      sizes: column.sizes,
    }))
    .filter((column) => column.windowIds.length > 0);

  if (validColumns.length === 0) {
    return createEmptyWorkspaceDocument("paper");
  }

  const rootNodeId = nextWorkspaceId("node");
  const nodesById: Record<string, WorkspaceNode> = {};
  const columnIds: string[] = [];

  for (const column of validColumns) {
    const columnId = nextWorkspaceId("node");
    columnIds.push(columnId);
    const childIds = column.windowIds.map((windowId) => {
      const nodeId = nextWorkspaceId("node");
      nodesById[nodeId] = {
        id: nodeId,
        kind: "window",
        windowId,
      };
      return nodeId;
    });

    nodesById[columnId] = {
      id: columnId,
      kind: "paper-column",
      childIds,
      sizes: normalizeWorkspaceSplitSizes(column.sizes, childIds.length),
      sizingMode: "auto",
    };
  }

  nodesById[rootNodeId] = {
    id: rootNodeId,
    kind: "paper-root",
    childIds: columnIds,
    widths: normalizeWorkspacePaperColumnWidths(
      validColumns.map((column) => column.width),
      columnIds.length,
    ),
    sizingMode: "auto",
  };

  const focusedWindowId =
    document.focusedWindowId && document.windowsById[document.focusedWindowId]
      ? document.focusedWindowId
      : (validColumns[0]?.windowIds[0] ?? null);

  return {
    ...document,
    layoutEngine: "paper",
    rootNodeId,
    nodesById,
    focusedWindowId,
    mobileActiveWindowId: focusedWindowId,
  };
}

function convertWorkspaceLayoutEngine(
  document: WorkspaceDocument,
  layoutEngine: WorkspaceLayoutEngine,
): WorkspaceDocument {
  if (document.layoutEngine === layoutEngine) {
    return document;
  }

  if (Object.keys(document.windowsById).length === 0) {
    return createEmptyWorkspaceDocument(layoutEngine);
  }

  if (layoutEngine === "paper") {
    const rects = getWorkspaceWindowRects(document).toSorted((left, right) => {
      const leftDelta = left.left - right.left;
      if (Math.abs(leftDelta) > WINDOW_RECT_EPSILON) {
        return leftDelta;
      }
      return left.top - right.top;
    });

    const groupedColumns: Array<{
      left: number;
      right: number;
      rects: WorkspaceWindowRect[];
    }> = [];

    for (const rect of rects) {
      const currentColumn = groupedColumns[groupedColumns.length - 1];
      if (
        currentColumn &&
        Math.abs(currentColumn.left - rect.left) <= WINDOW_RECT_EPSILON &&
        Math.abs(currentColumn.right - rect.right) <= WINDOW_RECT_EPSILON
      ) {
        currentColumn.rects.push(rect);
      } else {
        groupedColumns.push({
          left: rect.left,
          right: rect.right,
          rects: [rect],
        });
      }
    }

    const averageWidth =
      groupedColumns.reduce((sum, column) => sum + (column.right - column.left), 0) /
        groupedColumns.length || 1;

    return buildPaperDocumentFromColumns(
      document,
      groupedColumns.map((column) => ({
        width: Math.max(
          (column.right - column.left) / averageWidth,
          WORKSPACE_MIN_PAPER_COLUMN_WIDTH,
        ),
        windowIds: column.rects
          .toSorted((left, right) => left.top - right.top)
          .map((rect) => rect.windowId),
        sizes: column.rects
          .toSorted((left, right) => left.top - right.top)
          .map((rect) => rect.bottom - rect.top),
      })),
    );
  }

  const paperRoot = getPaperRootNode(document);
  if (!paperRoot) {
    return createEmptyWorkspaceDocument("split");
  }

  const nodesById: Record<string, WorkspaceNode> = {};
  const rootChildIds: string[] = [];

  for (const columnId of paperRoot.node.childIds) {
    const column = document.nodesById[columnId];
    if (!column || column.kind !== "paper-column") {
      continue;
    }

    const windowNodeIds = column.childIds
      .map((childId) => {
        const child = document.nodesById[childId];
        if (!child || child.kind !== "window" || !document.windowsById[child.windowId]) {
          return null;
        }
        const nextNodeId = nextWorkspaceId("node");
        nodesById[nextNodeId] = {
          id: nextNodeId,
          kind: "window",
          windowId: child.windowId,
        };
        return nextNodeId;
      })
      .filter((nodeId): nodeId is string => nodeId !== null);

    if (windowNodeIds.length === 0) {
      continue;
    }

    if (windowNodeIds.length === 1) {
      rootChildIds.push(windowNodeIds[0]!);
      continue;
    }

    const splitNodeId = nextWorkspaceId("node");
    nodesById[splitNodeId] = {
      id: splitNodeId,
      kind: "split",
      axis: "y",
      childIds: windowNodeIds,
      sizes: normalizeWorkspaceSplitSizes(column.sizes, windowNodeIds.length),
      sizingMode: column.sizingMode,
    };
    rootChildIds.push(splitNodeId);
  }

  if (rootChildIds.length === 0) {
    return createEmptyWorkspaceDocument("split");
  }

  const rootNodeId =
    rootChildIds.length === 1
      ? rootChildIds[0]!
      : (() => {
          const splitNodeId = nextWorkspaceId("node");
          nodesById[splitNodeId] = {
            id: splitNodeId,
            kind: "split",
            axis: "x",
            childIds: rootChildIds,
            sizes: normalizeWorkspaceSplitSizes(paperRoot.node.widths, rootChildIds.length),
            sizingMode: paperRoot.node.sizingMode,
          };
          return splitNodeId;
        })();

  const focusedWindowId =
    document.focusedWindowId && document.windowsById[document.focusedWindowId]
      ? document.focusedWindowId
      : (Object.keys(document.windowsById)[0] ?? null);

  return {
    ...document,
    layoutEngine: "split",
    rootNodeId,
    nodesById,
    focusedWindowId,
    mobileActiveWindowId: focusedWindowId,
  };
}

function normalizePersistedWorkspaceDocument(document: WorkspaceDocument): WorkspaceDocument {
  if (!document.rootNodeId || !document.nodesById[document.rootNodeId]) {
    return createEmptyWorkspaceDocument(document.layoutEngine);
  }

  const persistedWindowsById = document.windowsById as Record<
    string,
    WorkspaceWindow & {
      activeTabId?: string | null;
      tabIds?: string[] | null;
    }
  >;
  const normalizedWindowsById = Object.fromEntries(
    Object.entries(persistedWindowsById).map(([windowId, window]) => {
      const fallbackTabId = Array.isArray(window.tabIds)
        ? window.tabIds.find((surfaceId) => typeof surfaceId === "string" && surfaceId.length > 0)
        : null;
      const surfaceId =
        typeof window.surfaceId === "string" && window.surfaceId.length > 0
          ? window.surfaceId
          : typeof window.activeTabId === "string" && window.activeTabId.length > 0
            ? window.activeTabId
            : (fallbackTabId ?? null);

      return [
        windowId,
        {
          id: typeof window.id === "string" && window.id.length > 0 ? window.id : windowId,
          surfaceId,
        } satisfies WorkspaceWindow,
      ];
    }),
  ) as Record<string, WorkspaceWindow>;

  const normalizedTerminalCountsByThreadKey = new Map<string, number>();
  const normalizedSurfacesById = Object.fromEntries(
    Object.entries(document.surfacesById).map(([surfaceId, surface]) => {
      if (surface.kind !== "terminal") {
        return [surfaceId, surface];
      }

      const terminalThreadKey = `${surface.input.threadRef.environmentId}:${surface.input.threadRef.threadId}`;
      const normalizedTerminalCount =
        normalizedTerminalCountsByThreadKey.get(terminalThreadKey) ?? 0;
      normalizedTerminalCountsByThreadKey.set(terminalThreadKey, normalizedTerminalCount + 1);
      const fallbackTerminalId =
        normalizedTerminalCount === 0 ? DEFAULT_THREAD_TERMINAL_ID : `terminal-${surfaceId}`;

      return [
        surfaceId,
        {
          ...surface,
          input: {
            ...surface.input,
            terminalId:
              typeof surface.input.terminalId === "string" && surface.input.terminalId.length > 0
                ? surface.input.terminalId
                : fallbackTerminalId,
          },
        } satisfies WorkspaceSurfaceInstance,
      ];
    }),
  ) as Record<string, WorkspaceSurfaceInstance>;

  const normalizedNodesById = Object.fromEntries(
    Object.entries(document.nodesById).map(([nodeId, node]) => {
      if (node.kind === "split" || node.kind === "paper-column") {
        return [
          nodeId,
          {
            ...node,
            sizes: normalizeWorkspaceSplitSizes(node.sizes, node.childIds.length),
            sizingMode: node.sizingMode === "manual" ? "manual" : "auto",
          } satisfies WorkspaceNode,
        ];
      }

      if (node.kind === "paper-root") {
        return [
          nodeId,
          {
            ...node,
            widths: normalizeWorkspacePaperColumnWidths(node.widths, node.childIds.length),
            sizingMode: node.sizingMode === "manual" ? "manual" : "auto",
          } satisfies WorkspaceNode,
        ];
      }

      return [
        nodeId,
        {
          ...node,
        } satisfies WorkspaceNode,
      ];
    }),
  ) as Record<string, WorkspaceNode>;

  return {
    ...document,
    nodesById: normalizedNodesById,
    windowsById: normalizedWindowsById,
    surfacesById: normalizedSurfacesById,
  };
}

function readInitialWorkspaceDocument(): WorkspaceDocument {
  const persisted = readBrowserWorkspaceDocument<WorkspaceDocument>();
  if (!persisted || !isWorkspaceDocument(persisted)) {
    return createEmptyWorkspaceDocument();
  }
  return normalizePersistedWorkspaceDocument(persisted);
}

export interface WorkspaceStoreState {
  document: WorkspaceDocument;
  zoomedWindowId: string | null;
  openRouteTarget: (target: ThreadRouteTarget) => void;
  openThreadSurface: (input: ThreadSurfaceInput, disposition?: OpenThreadDisposition) => void;
  openThreadInSplit: (input: ThreadSurfaceInput, axis: WorkspaceAxis) => void;
  placeSurface: (surfaceId: string, target: WorkspacePlacementTarget) => void;
  placeThreadSurface: (input: ThreadSurfaceInput, target: WorkspacePlacementTarget) => void;
  openTerminalSurfaceForThread: (
    threadRef: TerminalSurfaceInput["threadRef"],
    disposition?: OpenTerminalDisposition,
  ) => void;
  splitWindowSurface: (windowId: string, axis: WorkspaceAxis) => void;
  setSplitNodeSizes: (nodeId: string, sizes: number[]) => void;
  closeSurface: (surfaceId: string) => void;
  closeFocusedWindow: () => void;
  focusWindow: (windowId: string) => void;
  focusWindowByStep: (step: -1 | 1) => void;
  focusAdjacentWindow: (direction: WorkspaceDirection) => void;
  focusThreadSurface: (input: ThreadSurfaceInput) => void;
  resizeFocusedWindow: (direction: WorkspaceDirection) => void;
  equalizeSplits: () => void;
  toggleFocusedWindowZoom: () => void;
  moveFocusedWindow: (direction: WorkspaceDirection) => void;
  toggleTerminalSurfaceForThread: (threadRef: TerminalSurfaceInput["threadRef"]) => void;
  ensureTerminalSurfaceForThread: (threadRef: TerminalSurfaceInput["threadRef"]) => void;
  closeTerminalSurfacesForThread: (threadRef: TerminalSurfaceInput["threadRef"]) => void;
  focusTerminalSurfaceForThread: (threadRef: TerminalSurfaceInput["threadRef"]) => void;
  setMobileActiveWindow: (windowId: string) => void;
  setLayoutEngine: (layoutEngine: WorkspaceLayoutEngine) => void;
  resetWorkspace: () => void;
}

function setDocumentState(nextDocument: WorkspaceDocument): Partial<WorkspaceStoreState> {
  scheduleWorkspacePersistence(nextDocument);
  return { document: nextDocument };
}

export const useWorkspaceStore = create<WorkspaceStoreState>()((set, get) => ({
  document: readInitialWorkspaceDocument(),
  zoomedWindowId: null,
  openRouteTarget: (target) => {
    if (target.kind !== "server") {
      return;
    }
    get().openThreadSurface({ scope: "server", threadRef: target.threadRef }, "focus-or-replace");
  },
  openThreadSurface: (input, disposition = "focus-or-replace") => {
    const current = get().document;
    const existingSurfaceId =
      disposition === "focus-or-replace" ? findMatchingThreadSurfaceId(current, input) : null;
    if (existingSurfaceId) {
      set(setDocumentState(focusSurfaceById(current, existingSurfaceId)));
      return;
    }

    const nextSurface = createThreadSurface(input);
    const nextDocument =
      disposition === "split-right"
        ? splitWindowWithSurface(current, firstWindowId(current), "x", nextSurface)
        : disposition === "split-down"
          ? splitWindowWithSurface(current, firstWindowId(current), "y", nextSurface)
          : insertSurfaceIntoWindow(current, firstWindowId(current), nextSurface);
    set(setDocumentState(nextDocument));
  },
  openThreadInSplit: (input, axis) => {
    const current = get().document;
    const nextDocument = splitWindowWithSurface(
      current,
      firstWindowId(current),
      axis,
      createThreadSurface(input),
    );
    set(setDocumentState(nextDocument));
  },
  placeSurface: (surfaceId, target) => {
    const current = get().document;
    const nextDocument =
      target.placement === "center"
        ? (() => {
            const source = getWindowBySurfaceId(current, surfaceId);
            if (!source || !current.windowsById[target.windowId]) {
              return current;
            }
            return swapWindowSurfaces(current, source.windowId, target.windowId);
          })()
        : moveSurfaceToEdge(current, surfaceId, target.windowId, target.placement);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  placeThreadSurface: (input, target) => {
    const current = get().document;
    const existingSurfaceId = findMatchingThreadSurfaceId(current, input);
    if (existingSurfaceId) {
      get().placeSurface(existingSurfaceId, target);
      return;
    }

    const nextSurface = createThreadSurface(input);
    const nextDocument =
      target.placement === "center"
        ? (() => {
            const window = current.windowsById[target.windowId];
            if (!window) {
              return current;
            }
            return replaceWindowSurfaceWithNewSurface(current, target.windowId, nextSurface);
          })()
        : splitWindowWithSurfaceAtEdge(current, target.windowId, target.placement, nextSurface);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  openTerminalSurfaceForThread: (threadRef, disposition = "focus-or-replace") => {
    const current = get().document;
    const threadSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (disposition === "focus-or-replace" && threadSurfaceIds.length > 0) {
      set(setDocumentState(focusSurfaceById(current, threadSurfaceIds[0]!)));
      return;
    }

    const input = terminalSurfaceInputForThread({ disposition, threadRef });
    const matchingSurfaceIds = findMatchingTerminalSurfaceIds(current, input);
    if (matchingSurfaceIds.length > 0) {
      set(setDocumentState(focusSurfaceById(current, matchingSurfaceIds[0]!)));
      return;
    }

    const nextSurface = createTerminalSurface(input);
    const targetWindowId = firstWindowId(current);
    const nextDocument =
      disposition === "split-right"
        ? splitWindowWithSurface(current, targetWindowId, "x", nextSurface)
        : disposition === "split-down"
          ? splitWindowWithSurface(current, targetWindowId, "y", nextSurface)
          : insertSurfaceIntoWindow(current, targetWindowId, nextSurface);
    set(setDocumentState(nextDocument));
  },
  splitWindowSurface: (windowId, axis) => {
    const current = get().document;
    const window = current.windowsById[windowId];
    const activeSurface = window?.surfaceId ? current.surfacesById[window.surfaceId] : null;
    if (!window || !activeSurface) {
      return;
    }

    const nextDocument = splitWindowWithSurface(
      current,
      windowId,
      axis,
      duplicateSurface(activeSurface),
    );
    set(setDocumentState(nextDocument));
  },
  setSplitNodeSizes: (nodeId, sizes) => {
    const current = get().document;
    const nextDocument = setWorkspaceSplitNodeSizes(current, nodeId, sizes);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  closeSurface: (surfaceId) => {
    const current = get().document;
    const nextDocument = closeSurfaceById(current, surfaceId);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  closeFocusedWindow: () => {
    const current = get().document;
    const windowId = firstWindowId(current);
    if (!windowId) {
      return;
    }
    const nextDocument = closeWindowById(current, windowId);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  focusWindow: (windowId) => {
    const current = get().document;
    if (!current.windowsById[windowId]) {
      return;
    }
    set(setDocumentState(setFocusedWindow(current, windowId)));
  },
  focusWindowByStep: (step) => {
    const current = get().document;
    const nextDocument = focusWindowByStep(current, step);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  focusAdjacentWindow: (direction) => {
    const current = get().document;
    const sourceWindowId = firstWindowId(current);
    const targetWindowId = findAdjacentWindowId(current, sourceWindowId, direction);
    if (!targetWindowId) {
      return;
    }
    set(setDocumentState(setFocusedWindow(current, targetWindowId)));
  },
  focusThreadSurface: (input) => {
    const current = get().document;
    const existingSurfaceId = findMatchingThreadSurfaceId(current, input);
    if (!existingSurfaceId) {
      return;
    }
    set(setDocumentState(focusSurfaceById(current, existingSurfaceId)));
  },
  resizeFocusedWindow: (direction) => {
    const current = get().document;
    const nextDocument = resizeFocusedWindow(current, direction);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  equalizeSplits: () => {
    const current = get().document;
    const nextDocument = equalizeWorkspaceSplits(current);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  toggleFocusedWindowZoom: () => {
    const current = get();
    const focusedWindowId = firstWindowId(current.document);
    if (!focusedWindowId) {
      return;
    }
    set({
      zoomedWindowId: current.zoomedWindowId === focusedWindowId ? null : focusedWindowId,
    });
  },
  moveFocusedWindow: (direction) => {
    const current = get().document;
    const sourceWindowId = firstWindowId(current);
    if (!sourceWindowId) {
      return;
    }
    const targetWindowId = findAdjacentWindowId(current, sourceWindowId, direction);
    if (!targetWindowId) {
      return;
    }
    const nextDocument = swapWindowNodePositions(current, sourceWindowId, targetWindowId);
    if (nextDocument === current) {
      return;
    }
    set(setDocumentState(nextDocument));
  },
  toggleTerminalSurfaceForThread: (threadRef) => {
    const current = get().document;
    const matchingSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (matchingSurfaceIds.length > 0) {
      let nextDocument = current;
      for (const surfaceId of matchingSurfaceIds) {
        nextDocument = closeSurfaceById(nextDocument, surfaceId);
      }
      set(setDocumentState(nextDocument));
      return;
    }

    const nextDocument = splitWindowWithSurface(
      current,
      firstWindowId(current),
      "y",
      createTerminalSurface({
        scope: "thread",
        threadRef,
        terminalId: preferredTerminalIdForThread(threadRef),
      }),
    );
    set(setDocumentState(nextDocument));
  },
  ensureTerminalSurfaceForThread: (threadRef) => {
    const current = get().document;
    const matchingSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (matchingSurfaceIds.length > 0) {
      set(setDocumentState(focusSurfaceById(current, matchingSurfaceIds[0]!)));
      return;
    }

    const nextDocument = splitWindowWithSurface(
      current,
      firstWindowId(current),
      "y",
      createTerminalSurface({
        scope: "thread",
        threadRef,
        terminalId: preferredTerminalIdForThread(threadRef),
      }),
    );
    set(setDocumentState(nextDocument));
  },
  closeTerminalSurfacesForThread: (threadRef) => {
    const current = get().document;
    const matchingSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (matchingSurfaceIds.length === 0) {
      return;
    }

    let nextDocument = current;
    for (const surfaceId of matchingSurfaceIds) {
      nextDocument = closeSurfaceById(nextDocument, surfaceId);
    }
    set(setDocumentState(nextDocument));
  },
  focusTerminalSurfaceForThread: (threadRef) => {
    const current = get().document;
    const matchingSurfaceIds = findTerminalSurfaceIdsForThread(current, threadRef);
    if (matchingSurfaceIds.length === 0) {
      return;
    }
    set(setDocumentState(focusSurfaceById(current, matchingSurfaceIds[0]!)));
  },
  setMobileActiveWindow: (windowId) => {
    const current = get().document;
    if (!current.windowsById[windowId]) {
      return;
    }
    set(
      setDocumentState({
        ...current,
        focusedWindowId: windowId,
        mobileActiveWindowId: windowId,
      }),
    );
  },
  setLayoutEngine: (layoutEngine) => {
    const current = get();
    const nextDocument = convertWorkspaceLayoutEngine(current.document, layoutEngine);
    if (nextDocument === current.document) {
      return;
    }
    set({
      ...setDocumentState(nextDocument),
      zoomedWindowId:
        current.zoomedWindowId && nextDocument.windowsById[current.zoomedWindowId]
          ? current.zoomedWindowId
          : null,
    });
  },
  resetWorkspace: () => {
    const nextDocument = createEmptyWorkspaceDocument(get().document.layoutEngine);
    set({
      ...setDocumentState(nextDocument),
      zoomedWindowId: null,
    });
  },
}));

export function useWorkspaceDocument(): WorkspaceDocument {
  return useWorkspaceStore((state) => state.document);
}

export function useWorkspaceLayoutEngine(): WorkspaceLayoutEngine {
  return useWorkspaceStore((state) => state.document.layoutEngine);
}

export function useWorkspaceRootNodeId(): string | null {
  return useWorkspaceStore((state) => state.document.rootNodeId);
}

export function useWorkspaceWindowIds(): string[] {
  return useWorkspaceStore(
    useShallow((state) =>
      Object.keys(state.document.windowsById).filter(
        (windowId) => state.document.windowsById[windowId],
      ),
    ),
  );
}

export function useWorkspaceFocusedWindowId(): string | null {
  return useWorkspaceStore((state) => state.document.focusedWindowId);
}

export function useWorkspaceMobileActiveWindowId(): string | null {
  return useWorkspaceStore((state) => state.document.mobileActiveWindowId);
}

export function useWorkspaceZoomedWindowId(): string | null {
  return useWorkspaceStore((state) =>
    state.zoomedWindowId && state.document.windowsById[state.zoomedWindowId]
      ? state.zoomedWindowId
      : null,
  );
}

export function useWorkspaceNode(nodeId: string | null): WorkspaceNode | null {
  return useWorkspaceStore((state) => (nodeId ? (state.document.nodesById[nodeId] ?? null) : null));
}

export function useWorkspaceWindow(windowId: string | null): WorkspaceWindow | null {
  return useWorkspaceStore((state) =>
    windowId ? (state.document.windowsById[windowId] ?? null) : null,
  );
}

export function useWorkspaceSurface(surfaceId: string | null): WorkspaceSurfaceInstance | null {
  return useWorkspaceStore((state) =>
    surfaceId ? (state.document.surfacesById[surfaceId] ?? null) : null,
  );
}

export function useFocusedWorkspaceSurface(): WorkspaceSurfaceInstance | null {
  const document = useWorkspaceDocument();
  return useMemo(() => getFocusedSurface(document), [document]);
}

export function useFocusedWorkspaceRouteTarget(): ThreadRouteTarget | null {
  const document = useWorkspaceDocument();
  return useMemo(() => routeTargetForSurface(getFocusedSurface(document)), [document]);
}
