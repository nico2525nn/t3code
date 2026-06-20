import type { ScopedProjectRef } from "@t3tools/contracts";
import { createContext, use, type ReactNode } from "react";
import type { SidebarProjectRevealRequest } from "./sidebarProjectReveal";

const OpenAddProjectCommandPaletteContext = createContext<(() => void) | null>(null);
const SidebarProjectRevealRequestContext = createContext<
  SidebarProjectRevealRequest | null | undefined
>(undefined);
const RequestSidebarProjectRevealContext = createContext<
  ((projectRef: ScopedProjectRef) => void) | null
>(null);
const CompleteSidebarProjectRevealContext = createContext<((requestId: number) => void) | null>(
  null,
);

export function OpenAddProjectCommandPaletteProvider(props: {
  readonly children: ReactNode;
  readonly openAddProject: () => void;
  readonly sidebarProjectRevealRequest: SidebarProjectRevealRequest | null;
  readonly requestSidebarProjectReveal: (projectRef: ScopedProjectRef) => void;
  readonly completeSidebarProjectReveal: (requestId: number) => void;
}) {
  return (
    <OpenAddProjectCommandPaletteContext value={props.openAddProject}>
      <SidebarProjectRevealRequestContext value={props.sidebarProjectRevealRequest}>
        <RequestSidebarProjectRevealContext value={props.requestSidebarProjectReveal}>
          <CompleteSidebarProjectRevealContext value={props.completeSidebarProjectReveal}>
            {props.children}
          </CompleteSidebarProjectRevealContext>
        </RequestSidebarProjectRevealContext>
      </SidebarProjectRevealRequestContext>
    </OpenAddProjectCommandPaletteContext>
  );
}

export function useOpenAddProjectCommandPalette(): () => void {
  const openAddProject = use(OpenAddProjectCommandPaletteContext);
  if (!openAddProject) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return openAddProject;
}

export function useSidebarProjectRevealRequest(): SidebarProjectRevealRequest | null {
  const request = use(SidebarProjectRevealRequestContext);
  if (request === undefined) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return request;
}

export function useRequestSidebarProjectReveal(): (projectRef: ScopedProjectRef) => void {
  const requestSidebarProjectReveal = use(RequestSidebarProjectRevealContext);
  if (!requestSidebarProjectReveal) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return requestSidebarProjectReveal;
}

export function useCompleteSidebarProjectReveal(): (requestId: number) => void {
  const completeSidebarProjectReveal = use(CompleteSidebarProjectRevealContext);
  if (!completeSidebarProjectReveal) {
    throw new Error("Command palette actions must be used inside CommandPalette");
  }
  return completeSidebarProjectReveal;
}

/** Read at event time so the chat tree does not subscribe to transient dialog state. */
export function isCommandPaletteOpen(): boolean {
  return (
    typeof document !== "undefined" && document.querySelector("[data-command-palette]") !== null
  );
}
