import { useParams } from "@tanstack/react-router";
import { Columns2Icon, Rows2Icon, TerminalSquareIcon, XIcon } from "lucide-react";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createThreadSelectorByRef } from "../../storeSelectors";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { SidebarInset } from "../ui/sidebar";
import ChatView from "../ChatView";
import { useComposerDraftStore } from "../../composerDraftStore";
import { resolveThreadRouteTarget } from "../../threadRoutes";
import { ThreadTerminalSurface } from "./ThreadTerminalSurface";
import { useWorkspaceDragStore } from "../../workspace/dragStore";
import {
  useWorkspaceFocusedWindowId,
  useWorkspaceLayoutEngine,
  useWorkspaceMobileActiveWindowId,
  useWorkspaceNode,
  useWorkspaceRootNodeId,
  useWorkspaceStore,
  useWorkspaceSurface,
  useWorkspaceWindow,
  useWorkspaceWindowIds,
  useWorkspaceZoomedWindowId,
} from "../../workspace/store";
import {
  normalizeWorkspacePaperColumnWidths,
  normalizeWorkspaceSplitSizes,
  type WorkspaceNode,
  type WorkspaceDropPlacement,
  type WorkspacePlacementTarget,
  type WorkspaceSurfaceInstance,
} from "../../workspace/types";

const WORKSPACE_MIN_PANE_SIZE_PX = 220;
const WORKSPACE_DROP_EDGE_THRESHOLD = 0.22;
const WORKSPACE_PAPER_COLUMN_BASE_WIDTH_PX = 560;
const WORKSPACE_PAPER_SCROLL_PADDING = 12;

function scrollPaperColumnIntoView(columnEl: Element, scrollContainer: Element): void {
  const scrollRect = scrollContainer.getBoundingClientRect();
  const columnRect = columnEl.getBoundingClientRect();

  if (columnRect.left < scrollRect.left + WORKSPACE_PAPER_SCROLL_PADDING) {
    scrollContainer.scrollTo({
      left:
        scrollContainer.scrollLeft +
        (columnRect.left - scrollRect.left) -
        WORKSPACE_PAPER_SCROLL_PADDING,
      behavior: "smooth",
    });
  } else if (columnRect.right > scrollRect.right - WORKSPACE_PAPER_SCROLL_PADDING) {
    scrollContainer.scrollTo({
      left:
        scrollContainer.scrollLeft +
        (columnRect.right - scrollRect.right) +
        WORKSPACE_PAPER_SCROLL_PADDING,
      behavior: "smooth",
    });
  }
}
const INTERACTIVE_PANE_TARGET_SELECTOR = [
  "button",
  "a[href]",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[contenteditable='']",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[draggable='true']",
  "[data-pane-autofocus-prevent='true']",
].join(", ");

function isWorkspaceDropTarget(
  value: WorkspaceDropPlacement | string | null,
  target: WorkspaceDropPlacement | string,
): boolean {
  return value === target;
}

function resolveWorkspaceDropPlacementFromPoint(
  rect: DOMRect,
  clientX: number,
  clientY: number,
): WorkspaceDropPlacement {
  if (rect.width <= 0 || rect.height <= 0) {
    return "center";
  }

  const normalizedX = (clientX - rect.left) / rect.width;
  const normalizedY = (clientY - rect.top) / rect.height;
  const distanceLeft = normalizedX;
  const distanceRight = 1 - normalizedX;
  const distanceTop = normalizedY;
  const distanceBottom = 1 - normalizedY;
  const minEdgeDistance = Math.min(distanceLeft, distanceRight, distanceTop, distanceBottom);

  if (minEdgeDistance > WORKSPACE_DROP_EDGE_THRESHOLD) {
    return "center";
  }

  if (minEdgeDistance === distanceLeft) {
    return "left";
  }
  if (minEdgeDistance === distanceRight) {
    return "right";
  }
  if (minEdgeDistance === distanceTop) {
    return "top";
  }
  return "bottom";
}

function workspaceDropPreviewClass(target: WorkspaceDropPlacement | string | null): string {
  switch (target) {
    case "left":
      return "left-2 top-2 bottom-2 w-1/2";
    case "right":
      return "right-2 top-2 bottom-2 w-1/2";
    case "top":
      return "left-2 right-2 top-2 h-1/2";
    case "bottom":
      return "left-2 right-2 bottom-2 h-1/2";
    case "center":
      return "inset-2";
    default:
      return "hidden";
  }
}

function shouldSuppressPaneActivationAutoFocus(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  if (target.closest("[data-pane-autofocus-allow='true']")) {
    return false;
  }

  return target.closest(INTERACTIVE_PANE_TARGET_SELECTOR) !== null;
}

function applyWorkspaceDrop(params: {
  clearDragItem: () => void;
  dragItem:
    | {
        kind: "surface";
        surfaceId: string;
      }
    | {
        kind: "thread";
        input: Parameters<ReturnType<typeof useWorkspaceStore.getState>["placeThreadSurface"]>[0];
      };
  placeSurface: ReturnType<typeof useWorkspaceStore.getState>["placeSurface"];
  placeThreadSurface: ReturnType<typeof useWorkspaceStore.getState>["placeThreadSurface"];
  target: WorkspacePlacementTarget;
}) {
  if (params.dragItem.kind === "surface") {
    params.placeSurface(params.dragItem.surfaceId, params.target);
  } else {
    params.placeThreadSurface(params.dragItem.input, params.target);
  }
  params.clearDragItem();
}

function WorkspaceEmptyState() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-6">
      <div className="w-full max-w-lg rounded-xl border border-border/55 bg-card/20 px-8 py-12 shadow-sm/5">
        <p className="text-xl text-foreground">Pick a thread to continue</p>
        <p className="mt-2 text-sm text-muted-foreground/78">
          Select an existing thread or create a new one to get started.
        </p>
      </div>
    </div>
  );
}

export function WorkspaceShell() {
  const rootNodeId = useWorkspaceRootNodeId();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
        {rootNodeId ? <WorkspaceLayoutRoot /> : <WorkspaceRouteFallback />}
      </div>
    </SidebarInset>
  );
}

function WorkspaceRouteFallback() {
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const openThreadSurface = useWorkspaceStore((state) => state.openThreadSurface);
  const draftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  useEffect(() => {
    if (!routeTarget) {
      return;
    }

    if (routeTarget.kind === "server") {
      openThreadSurface(
        {
          scope: "server",
          threadRef: routeTarget.threadRef,
        },
        "focus-or-replace",
      );
      return;
    }

    if (!draftSession) {
      return;
    }

    openThreadSurface(
      {
        scope: "draft",
        draftId: routeTarget.draftId,
        environmentId: draftSession.environmentId,
        threadId: draftSession.threadId,
      },
      "focus-or-replace",
    );
  }, [draftSession, openThreadSurface, routeTarget]);

  if (!routeTarget) {
    return <WorkspaceEmptyState />;
  }

  if (routeTarget.kind === "server") {
    return (
      <ChatView
        environmentId={routeTarget.threadRef.environmentId}
        threadId={routeTarget.threadRef.threadId}
        routeKind="server"
      />
    );
  }

  if (!draftSession) {
    return <WorkspaceEmptyState />;
  }

  return (
    <ChatView
      draftId={routeTarget.draftId}
      environmentId={draftSession.environmentId}
      threadId={draftSession.threadId}
      routeKind="draft"
    />
  );
}

function WorkspaceLayoutRoot() {
  const rootNodeId = useWorkspaceRootNodeId();
  const focusedWindowId = useWorkspaceFocusedWindowId();
  const mobileActiveWindowId = useWorkspaceMobileActiveWindowId();
  const windowIds = useWorkspaceWindowIds();
  const zoomedWindowId = useWorkspaceZoomedWindowId();
  const setMobileActiveWindow = useWorkspaceStore((state) => state.setMobileActiveWindow);
  const isDesktopViewport = useMediaQuery("md");
  const activeWindowId =
    zoomedWindowId ?? mobileActiveWindowId ?? focusedWindowId ?? windowIds[0] ?? null;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {windowIds.length > 1 ? (
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          {windowIds.map((windowId, index) => {
            const isActive = (mobileActiveWindowId ?? focusedWindowId ?? windowIds[0]) === windowId;
            return (
              <button
                key={windowId}
                type="button"
                className={cn(
                  "rounded-md border px-2 py-1 text-xs",
                  isActive
                    ? "border-border bg-accent text-foreground"
                    : "border-border/60 text-muted-foreground",
                )}
                onClick={() => setMobileActiveWindow(windowId)}
              >
                Window {index + 1}
              </button>
            );
          })}
        </div>
      ) : null}
      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
        {isDesktopViewport ? (
          zoomedWindowId ? (
            <WorkspaceWindowView windowId={zoomedWindowId} scrollIntoViewOnFocus />
          ) : (
            <WorkspaceNodeView nodeId={rootNodeId} />
          )
        ) : (
          <MobileWorkspaceWindow windowId={activeWindowId} />
        )}
      </div>
    </div>
  );
}

const MobileWorkspaceWindow = memo(function MobileWorkspaceWindow(props: {
  windowId: string | null;
}) {
  const window = useWorkspaceWindow(props.windowId);

  if (!props.windowId) {
    return <WorkspaceEmptyState />;
  }

  if (!window) {
    return <WorkspaceEmptyState />;
  }

  return <WorkspaceWindowView windowId={window.id} />;
});

const WorkspaceNodeView = memo(function WorkspaceNodeView(props: { nodeId: string | null }) {
  const node = useWorkspaceNode(props.nodeId);

  if (!props.nodeId) {
    return null;
  }

  if (!node) {
    return null;
  }

  if (node.kind === "window") {
    return <WorkspaceWindowView windowId={node.windowId} scrollIntoViewOnFocus />;
  }

  if (node.kind === "paper-root") {
    return <WorkspacePaperRootView node={node} />;
  }

  if (node.kind === "paper-column") {
    return <WorkspacePaperColumnView node={node} />;
  }

  return <WorkspaceSplitNodeView node={node} />;
});

const WorkspacePaperRootView = memo(function WorkspacePaperRootView(props: {
  node: Extract<WorkspaceNode, { kind: "paper-root" }>;
}) {
  const widths = useMemo(
    () => normalizeWorkspacePaperColumnWidths(props.node.widths, props.node.childIds.length),
    [props.node.childIds.length, props.node.widths],
  );

  const dragItem = useWorkspaceDragStore((state) => state.item);
  const clearDragItem = useWorkspaceDragStore((state) => state.clearItem);
  const placeSurface = useWorkspaceStore((state) => state.placeSurface);
  const placeThreadSurface = useWorkspaceStore((state) => state.placeThreadSurface);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!dragItem) {
      setDropIndex(null);
    }
  }, [dragItem]);

  // Auto-scroll to keep the focused window's column fully visible.
  // Uses a store subscription so it fires on EVERY state change (including
  // re-focusing the same window from the sidebar), not just when
  // focusedWindowId value changes.
  useEffect(() => {
    let rafId: number | null = null;

    function scrollFocusedColumnIntoView(): void {
      const scrollContainer = scrollContainerRef.current;
      const container = containerRef.current;
      if (!scrollContainer || !container) return;

      const doc = useWorkspaceStore.getState().document;
      const focusedWinId = doc.focusedWindowId;
      if (!focusedWinId) return;

      const rootNode = doc.nodesById[doc.rootNodeId ?? ""];
      if (!rootNode || rootNode.kind !== "paper-root") return;

      // Find which column contains the focused window
      let columnIndex = -1;
      for (let i = 0; i < rootNode.childIds.length; i++) {
        const columnId = rootNode.childIds[i]!;
        const column = doc.nodesById[columnId];
        if (!column || column.kind !== "paper-column") continue;
        for (const childNodeId of column.childIds) {
          const childNode = doc.nodesById[childNodeId];
          if (childNode?.kind === "window" && childNode.windowId === focusedWinId) {
            columnIndex = i;
            break;
          }
        }
        if (columnIndex >= 0) break;
      }
      if (columnIndex < 0) return;

      // Get the column DOM element (skip drop indicators)
      const columnEls: HTMLElement[] = [];
      for (const child of container.children) {
        if (!(child as HTMLElement).dataset.dropIndicator) {
          columnEls.push(child as HTMLElement);
        }
      }
      const columnEl = columnEls[columnIndex];
      if (!columnEl) return;

      scrollPaperColumnIntoView(columnEl, scrollContainer);
    }

    function scheduleScroll(): void {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
      rafId = requestAnimationFrame(() => {
        rafId = null;
        scrollFocusedColumnIntoView();
      });
    }

    // Scroll on mount
    scheduleScroll();

    // Scroll on every store change
    const unsubscribe = useWorkspaceStore.subscribe(scheduleScroll);

    return () => {
      unsubscribe();
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, []);

  const resolveDropIndex = useCallback((clientX: number): number => {
    const container = containerRef.current;
    if (!container) {
      return 0;
    }

    const columnEls: HTMLElement[] = [];
    for (const child of container.children) {
      if (!(child as HTMLElement).dataset.dropIndicator) {
        columnEls.push(child as HTMLElement);
      }
    }

    for (let i = 0; i < columnEls.length; i++) {
      const rect = columnEls[i]!.getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) {
        return i;
      }
    }

    return columnEls.length;
  }, []);

  const handleDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropIndex(resolveDropIndex(event.clientX));
    },
    [dragItem, resolveDropIndex],
  );

  const handleDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const currentDropIndex = resolveDropIndex(event.clientX);
      const doc = useWorkspaceStore.getState().document;
      const rootNode = doc.nodesById[doc.rootNodeId ?? ""];
      if (!rootNode || rootNode.kind !== "paper-root") {
        return;
      }

      let targetWindowId: string | null = null;
      let placement: "left" | "right" = "left";

      if (currentDropIndex >= rootNode.childIds.length) {
        placement = "right";
        const columnId = rootNode.childIds[rootNode.childIds.length - 1];
        if (columnId) {
          const column = doc.nodesById[columnId];
          if (column?.kind === "paper-column" && column.childIds.length > 0) {
            const windowNode = doc.nodesById[column.childIds[0]!];
            if (windowNode?.kind === "window") {
              targetWindowId = windowNode.windowId;
            }
          }
        }
      } else {
        placement = "left";
        const columnId = rootNode.childIds[currentDropIndex];
        if (columnId) {
          const column = doc.nodesById[columnId];
          if (column?.kind === "paper-column" && column.childIds.length > 0) {
            const windowNode = doc.nodesById[column.childIds[0]!];
            if (windowNode?.kind === "window") {
              targetWindowId = windowNode.windowId;
            }
          }
        }
      }

      if (targetWindowId) {
        applyWorkspaceDrop({
          clearDragItem,
          dragItem,
          placeSurface,
          placeThreadSurface,
          target: {
            kind: "window",
            windowId: targetWindowId,
            placement,
          },
        });
      }

      setDropIndex(null);
    },
    [dragItem, resolveDropIndex, clearDragItem, placeSurface, placeThreadSurface],
  );

  const handleDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget as Node)) {
      setDropIndex(null);
    }
  }, []);

  return (
    <div ref={scrollContainerRef} data-paper-scroll className="h-full min-h-0 overflow-x-auto overflow-y-hidden">
      <div
        ref={containerRef}
        className="flex h-full min-h-0 min-w-full items-stretch gap-3 px-3 py-3"
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        onDragLeave={handleDragLeave}
      >
        {props.node.childIds.map((childId, index) => (
          <Fragment key={childId}>
            {dropIndex === index && dragItem ? (
              <div
                data-drop-indicator="true"
                className="h-full w-0.5 shrink-0 rounded-full bg-primary"
              />
            ) : null}
            <div
              data-paper-column
              className="h-full min-h-0 overflow-hidden"
              style={{
                flex: `${widths[index] ?? 1} 0 ${(widths[index] ?? 1) * WORKSPACE_PAPER_COLUMN_BASE_WIDTH_PX}px`,
              }}
            >
              <WorkspaceNodeView nodeId={childId} />
            </div>
          </Fragment>
        ))}
        {dropIndex === props.node.childIds.length && dragItem ? (
          <div
            data-drop-indicator="true"
            className="h-full w-0.5 shrink-0 rounded-full bg-primary"
          />
        ) : null}
      </div>
    </div>
  );
});

const WorkspacePaperColumnView = memo(function WorkspacePaperColumnView(props: {
  node: Extract<WorkspaceNode, { kind: "paper-column" }>;
}) {
  return (
    <WorkspaceLinearNodeView
      axis="y"
      childIds={props.node.childIds}
      nodeId={props.node.id}
      sizes={props.node.sizes}
    />
  );
});

const WorkspaceSplitNodeView = memo(function WorkspaceSplitNodeView(props: {
  node: Extract<WorkspaceNode, { kind: "split" }>;
}) {
  return (
    <WorkspaceLinearNodeView
      axis={props.node.axis}
      childIds={props.node.childIds}
      nodeId={props.node.id}
      sizes={props.node.sizes}
    />
  );
});

const WorkspaceLinearNodeView = memo(function WorkspaceLinearNodeView(props: {
  axis: "x" | "y";
  childIds: string[];
  nodeId: string;
  sizes: number[];
}) {
  const setSplitNodeSizes = useWorkspaceStore((state) => state.setSplitNodeSizes);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{
    handle: HTMLButtonElement;
    handleIndex: number;
    pendingSizes: number[];
    pointerId: number;
    rafId: number | null;
    startCoordinate: number;
    startSizes: number[];
    totalPx: number;
  } | null>(null);
  const sizes = useMemo(
    () => normalizeWorkspaceSplitSizes(props.sizes, props.childIds.length),
    [props.childIds.length, props.sizes],
  );

  const stopResize = useCallback(
    (pointerId: number) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState) {
        return;
      }
      if (resizeState.rafId !== null) {
        window.cancelAnimationFrame(resizeState.rafId);
        setSplitNodeSizes(props.nodeId, resizeState.pendingSizes);
      }
      resizeStateRef.current = null;
      if (resizeState.handle.hasPointerCapture(pointerId)) {
        resizeState.handle.releasePointerCapture(pointerId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    },
    [props.nodeId, setSplitNodeSizes],
  );

  useEffect(() => {
    return () => {
      const resizeState = resizeStateRef.current;
      if (resizeState && resizeState.rafId !== null) {
        window.cancelAnimationFrame(resizeState.rafId);
      }
      document.body.style.removeProperty("cursor");
      document.body.style.removeProperty("user-select");
    };
  }, []);

  const handleResizePointerDown = useCallback(
    (handleIndex: number, event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) {
        return;
      }

      const container = containerRef.current;
      if (!container) {
        return;
      }

      const rect = container.getBoundingClientRect();
      const totalPx = props.axis === "x" ? rect.width : rect.height;
      if (totalPx <= 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      resizeStateRef.current = {
        handle: event.currentTarget,
        handleIndex,
        pendingSizes: sizes,
        pointerId: event.pointerId,
        rafId: null,
        startCoordinate: props.axis === "x" ? event.clientX : event.clientY,
        startSizes: sizes,
        totalPx,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.style.cursor = props.axis === "x" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [props.axis, sizes],
  );

  const handleResizePointerMove = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      const deltaPx =
        (props.axis === "x" ? event.clientX : event.clientY) - resizeState.startCoordinate;
      const deltaFraction = deltaPx / resizeState.totalPx;
      const pairTotal =
        resizeState.startSizes[resizeState.handleIndex]! +
        resizeState.startSizes[resizeState.handleIndex + 1]!;
      const requestedMinFraction = WORKSPACE_MIN_PANE_SIZE_PX / resizeState.totalPx;
      const minFraction = Math.min(requestedMinFraction, Math.max(pairTotal / 2 - 0.001, 0));

      const nextBefore = Math.min(
        pairTotal - minFraction,
        Math.max(minFraction, resizeState.startSizes[resizeState.handleIndex]! + deltaFraction),
      );
      const nextAfter = pairTotal - nextBefore;
      const nextSizes = [...resizeState.startSizes];
      nextSizes[resizeState.handleIndex] = nextBefore;
      nextSizes[resizeState.handleIndex + 1] = nextAfter;
      resizeState.pendingSizes = nextSizes;
      if (resizeState.rafId !== null) {
        return;
      }

      resizeState.rafId = window.requestAnimationFrame(() => {
        const activeResizeState = resizeStateRef.current;
        if (!activeResizeState) {
          return;
        }
        activeResizeState.rafId = null;
        setSplitNodeSizes(props.nodeId, activeResizeState.pendingSizes);
      });
    },
    [props.axis, props.nodeId, setSplitNodeSizes],
  );

  const endResizeInteraction = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      const resizeState = resizeStateRef.current;
      if (!resizeState || resizeState.pointerId !== event.pointerId) {
        return;
      }

      event.preventDefault();
      stopResize(event.pointerId);
    },
    [stopResize],
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex h-full min-h-0 min-w-0 flex-1 overflow-hidden",
        props.axis === "x" ? "flex-row" : "flex-col",
      )}
    >
      {props.childIds.map((childId, index) => (
        <Fragment key={childId}>
          <div
            className="h-full min-h-0 min-w-0 overflow-hidden"
            style={{
              flexBasis: 0,
              flexGrow: sizes[index] ?? 1,
              flexShrink: 1,
            }}
          >
            <WorkspaceNodeView nodeId={childId} />
          </div>
          {index < props.childIds.length - 1 ? (
            <button
              type="button"
              className={cn(
                "relative z-10 shrink-0 bg-border/80 transition hover:bg-foreground/40",
                props.axis === "x"
                  ? "h-full w-1 cursor-col-resize touch-none"
                  : "h-1 w-full cursor-row-resize touch-none",
              )}
              aria-label={
                props.axis === "x" ? "Resize panes horizontally" : "Resize panes vertically"
              }
              title="Drag to resize panes"
              onPointerCancel={endResizeInteraction}
              onPointerDown={(event) => handleResizePointerDown(index, event)}
              onPointerMove={handleResizePointerMove}
              onPointerUp={endResizeInteraction}
            >
              <span
                className={cn(
                  "pointer-events-none absolute rounded-full bg-background/90",
                  props.axis === "x"
                    ? "top-1/2 left-1/2 h-10 w-px -translate-x-1/2 -translate-y-1/2"
                    : "top-1/2 left-1/2 h-px w-10 -translate-x-1/2 -translate-y-1/2",
                )}
              />
            </button>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
});

const WorkspaceWindowView = memo(function WorkspaceWindowView(props: {
  scrollIntoViewOnFocus?: boolean;
  windowId: string;
}) {
  const layoutEngine = useWorkspaceLayoutEngine();
  const isPaperLayout = layoutEngine === "paper";
  const dragItem = useWorkspaceDragStore((state) => state.item);
  const clearDragItem = useWorkspaceDragStore((state) => state.clearItem);
  const focusWindow = useWorkspaceStore((state) => state.focusWindow);
  const closeSurface = useWorkspaceStore((state) => state.closeSurface);
  const placeSurface = useWorkspaceStore((state) => state.placeSurface);
  const placeThreadSurface = useWorkspaceStore((state) => state.placeThreadSurface);
  const splitWindowSurface = useWorkspaceStore((state) => state.splitWindowSurface);
  const window = useWorkspaceWindow(props.windowId);
  const activeSurface = useWorkspaceSurface(window?.surfaceId ?? null);
  const focusedWindowId = useWorkspaceFocusedWindowId();
  const [isWindowDragActive, setIsWindowDragActive] = useState(false);
  const [threadActivationFocusRequestId, setThreadActivationFocusRequestId] = useState(0);
  const [terminalActivationFocusRequestId, setTerminalActivationFocusRequestId] = useState(0);
  const [hoveredDropTarget, setHoveredDropTarget] = useState<
    WorkspaceDropPlacement | string | null
  >(null);
  const shouldAutoFocusOnActivationRef = useRef(true);
  const wasFocusedRef = useRef(focusedWindowId === props.windowId);
  const windowElementRef = useRef<HTMLElement | null>(null);
  const pendingFocusWindowFrameRef = useRef<number | null>(null);

  const resetHoveredDropTarget = useCallback(() => {
    setHoveredDropTarget(null);
  }, []);

  useEffect(() => {
    if (!dragItem) {
      setIsWindowDragActive(false);
      setHoveredDropTarget(null);
    }
  }, [dragItem]);

  useEffect(() => {
    return () => {
      if (pendingFocusWindowFrameRef.current !== null) {
        globalThis.cancelAnimationFrame(pendingFocusWindowFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const isFocused = focusedWindowId === props.windowId;
    const wasFocused = wasFocusedRef.current;
    wasFocusedRef.current = isFocused;

    if (!isFocused || wasFocused || !activeSurface) {
      return;
    }

    const shouldAutoFocus = shouldAutoFocusOnActivationRef.current;
    shouldAutoFocusOnActivationRef.current = true;
    if (!shouldAutoFocus) {
      return;
    }

    const activeElement = document.activeElement;
    const windowElement = windowElementRef.current;
    if (
      activeElement instanceof HTMLElement &&
      windowElement &&
      !windowElement.contains(activeElement)
    ) {
      activeElement.blur();
    }

    if (activeSurface.kind === "thread") {
      setThreadActivationFocusRequestId((current) => current + 1);
      return;
    }

    setTerminalActivationFocusRequestId((current) => current + 1);
  }, [activeSurface, focusedWindowId, props.windowId]);

  useEffect(() => {
    if (isPaperLayout || !props.scrollIntoViewOnFocus || focusedWindowId !== props.windowId) {
      return;
    }

    windowElementRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "nearest",
      inline: "nearest",
    });
  }, [focusedWindowId, isPaperLayout, props.scrollIntoViewOnFocus, props.windowId]);

  const handleWindowDragOver = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setIsWindowDragActive(true);
      setHoveredDropTarget(
        resolveWorkspaceDropPlacementFromPoint(
          event.currentTarget.getBoundingClientRect(),
          event.clientX,
          event.clientY,
        ),
      );
    },
    [dragItem],
  );

  const handleWindowDragLeave = useCallback((event: React.DragEvent<HTMLElement>) => {
    const relatedTarget = event.relatedTarget;
    if (relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget)) {
      return;
    }
    setIsWindowDragActive(false);
    setHoveredDropTarget(null);
  }, []);

  const handleDropTarget = useCallback(
    (target: WorkspacePlacementTarget) => (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      applyWorkspaceDrop({
        clearDragItem,
        dragItem,
        placeSurface,
        placeThreadSurface,
        target,
      });
      setIsWindowDragActive(false);
      setHoveredDropTarget(null);
    },
    [clearDragItem, dragItem, placeSurface, placeThreadSurface],
  );

  const handleDragOverTarget = useCallback(
    (hoverTarget: WorkspaceDropPlacement | string) => (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setHoveredDropTarget(hoverTarget);
    },
    [dragItem],
  );

  const handleWindowDrop = useCallback(
    (event: React.DragEvent<HTMLElement>) => {
      if (!dragItem) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const targetPlacement = resolveWorkspaceDropPlacementFromPoint(
        event.currentTarget.getBoundingClientRect(),
        event.clientX,
        event.clientY,
      );
      applyWorkspaceDrop({
        clearDragItem,
        dragItem,
        placeSurface,
        placeThreadSurface,
        target: {
          kind: "window",
          windowId: props.windowId,
          placement: targetPlacement,
        },
      });
      setIsWindowDragActive(false);
      setHoveredDropTarget(null);
    },
    [clearDragItem, dragItem, placeSurface, placeThreadSurface, props.windowId],
  );

  const handlePaneDragStart = useCallback(
    (surfaceId: string) => (event: React.DragEvent<HTMLElement>) => {
      event.stopPropagation();
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", surfaceId);
      useWorkspaceDragStore.getState().setItem({
        kind: "surface",
        surfaceId,
      });
      focusWindow(props.windowId);
    },
    [focusWindow, props.windowId],
  );

  const handlePaneDragEnd = useCallback(() => {
    useWorkspaceDragStore.getState().clearItem();
    setHoveredDropTarget(null);
  }, []);

  if (!window) {
    return null;
  }

  return (
    <section
      ref={windowElementRef}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden border border-border/70 bg-background",
        focusedWindowId === props.windowId ? "ring-1 ring-border/80" : "",
      )}
      onPointerDownCapture={(event) => {
        if (event.button !== 0) {
          shouldAutoFocusOnActivationRef.current = true;
          return;
        }
        const shouldSuppressAutoFocus = shouldSuppressPaneActivationAutoFocus(event.target);
        shouldAutoFocusOnActivationRef.current = !shouldSuppressAutoFocus;
        if (pendingFocusWindowFrameRef.current !== null) {
          globalThis.cancelAnimationFrame(pendingFocusWindowFrameRef.current);
          pendingFocusWindowFrameRef.current = null;
        }
        if (!shouldSuppressAutoFocus) {
          focusWindow(props.windowId);
        } else {
          pendingFocusWindowFrameRef.current = globalThis.requestAnimationFrame(() => {
            pendingFocusWindowFrameRef.current = null;
            focusWindow(props.windowId);
          });
        }
        // In paper mode, scroll the column into view on every click
        if (isPaperLayout && windowElementRef.current) {
          const columnEl = windowElementRef.current.closest("[data-paper-column]");
          const scrollContainer = columnEl?.closest("[data-paper-scroll]");
          if (columnEl && scrollContainer) {
            requestAnimationFrame(() => {
              scrollPaperColumnIntoView(columnEl, scrollContainer);
            });
          }
        }
      }}
    >
      <div className="flex min-w-0 items-center gap-1 border-b border-border/70 bg-muted/20 px-2 py-1.5">
        <div
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 overflow-hidden rounded-md px-2 py-1 text-xs transition",
            isWorkspaceDropTarget(hoveredDropTarget, "center") ? "bg-accent/60" : "",
          )}
          data-pane-autofocus-allow="true"
          onDragLeave={resetHoveredDropTarget}
          onDragOver={handleDragOverTarget("center")}
          onDrop={handleDropTarget({
            kind: "window",
            windowId: props.windowId,
            placement: "center",
          })}
        >
          <button
            type="button"
            className="min-w-0 flex-1 truncate text-left text-foreground"
            draggable={activeSurface !== null}
            onClick={() => focusWindow(props.windowId)}
            onDragEnd={handlePaneDragEnd}
            onDragStart={activeSurface ? handlePaneDragStart(activeSurface.id) : undefined}
          >
            {activeSurface ? <WorkspaceSurfaceTitle surface={activeSurface} /> : "Empty pane"}
          </button>
        </div>
        <div className="hidden items-center gap-1 md:flex">
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={() => splitWindowSurface(props.windowId, "x")}
            aria-label="Split pane right"
            title="Split pane right"
          >
            <Columns2Icon className="size-3.5" />
          </button>
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={() => splitWindowSurface(props.windowId, "y")}
            aria-label="Split pane down"
            title="Split pane down"
          >
            <Rows2Icon className="size-3.5" />
          </button>
        </div>
        {activeSurface ? (
          <button
            type="button"
            className="rounded-sm p-1 text-muted-foreground transition hover:bg-accent hover:text-foreground"
            onClick={() => closeSurface(activeSurface.id)}
            aria-label="Close pane"
            title="Close pane"
          >
            <XIcon className="size-3.5" />
          </button>
        ) : null}
      </div>
      <div
        className={cn(
          "h-0.5 shrink-0 transition-colors",
          focusedWindowId === props.windowId ? "bg-primary" : "bg-transparent",
        )}
      />
      <div
        className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden"
        onDragLeave={isPaperLayout ? undefined : handleWindowDragLeave}
        onDrop={isPaperLayout ? undefined : handleWindowDrop}
        onDragOver={isPaperLayout ? undefined : handleWindowDragOver}
      >
        {activeSurface ? (
          <WorkspaceSurfaceView
            activationFocusRequestId={
              activeSurface.kind === "thread"
                ? threadActivationFocusRequestId
                : terminalActivationFocusRequestId
            }
            surface={activeSurface}
            bindSharedComposerHandle={focusedWindowId === props.windowId}
          />
        ) : null}
        {dragItem && isWindowDragActive && !isPaperLayout ? (
          <>
            <div className="pointer-events-none absolute inset-0 z-10 bg-background/10" />
            <div
              className={cn(
                "pointer-events-none absolute z-20 rounded-lg border-2 border-primary/70 bg-primary/10 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)] transition-all",
                workspaceDropPreviewClass(hoveredDropTarget),
              )}
            />
          </>
        ) : null}
      </div>
    </section>
  );
});

const WorkspaceSurfaceView = memo(function WorkspaceSurfaceView(props: {
  activationFocusRequestId?: number;
  bindSharedComposerHandle?: boolean;
  surface: WorkspaceSurfaceInstance;
}) {
  if (props.surface.kind === "thread") {
    if (props.surface.input.scope === "server") {
      return (
        <ChatView
          {...(props.activationFocusRequestId === undefined
            ? {}
            : { activationFocusRequestId: props.activationFocusRequestId })}
          environmentId={props.surface.input.threadRef.environmentId}
          threadId={props.surface.input.threadRef.threadId}
          routeKind="server"
          {...(props.bindSharedComposerHandle === undefined
            ? {}
            : { bindSharedComposerHandle: props.bindSharedComposerHandle })}
        />
      );
    }

    return (
      <ChatView
        {...(props.activationFocusRequestId === undefined
          ? {}
          : { activationFocusRequestId: props.activationFocusRequestId })}
        draftId={props.surface.input.draftId}
        environmentId={props.surface.input.environmentId}
        threadId={props.surface.input.threadId}
        routeKind="draft"
        {...(props.bindSharedComposerHandle === undefined
          ? {}
          : { bindSharedComposerHandle: props.bindSharedComposerHandle })}
      />
    );
  }

  return (
    <ThreadTerminalSurface
      surfaceId={props.surface.id}
      terminalId={props.surface.input.terminalId}
      threadRef={props.surface.input.threadRef}
      {...(props.activationFocusRequestId === undefined
        ? {}
        : { activationFocusRequestId: props.activationFocusRequestId })}
    />
  );
});

function WorkspaceSurfaceTitle(props: { surface: WorkspaceSurfaceInstance }) {
  if (props.surface.kind === "terminal") {
    return <TerminalSurfaceTitle threadRef={props.surface.input.threadRef} />;
  }

  return <ThreadSurfaceTitle surface={props.surface} />;
}

function ThreadSurfaceTitle(props: {
  surface: Extract<WorkspaceSurfaceInstance, { kind: "thread" }>;
}) {
  const thread = useStore(
    useMemo(
      () =>
        createThreadSelectorByRef(
          props.surface.input.scope === "server" ? props.surface.input.threadRef : null,
        ),
      [props.surface.input],
    ),
  );
  if (props.surface.input.scope === "server") {
    return <>{thread?.title ?? props.surface.input.threadRef.threadId}</>;
  }

  return <>{thread?.title ?? props.surface.input.threadId ?? "Draft thread"}</>;
}

function TerminalSurfaceTitle(props: {
  threadRef: Extract<WorkspaceSurfaceInstance, { kind: "terminal" }>["input"]["threadRef"];
}) {
  const thread = useStore(
    useMemo(() => createThreadSelectorByRef(props.threadRef), [props.threadRef]),
  );
  const label = thread?.title ?? props.threadRef.threadId;

  return (
    <span className="inline-flex items-center gap-1">
      <TerminalSquareIcon className="size-3 shrink-0" />
      <span className="truncate">{label}</span>
    </span>
  );
}
