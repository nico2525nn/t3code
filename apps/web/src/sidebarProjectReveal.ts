import { scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { ScopedProjectRef } from "@t3tools/contracts";

export interface SidebarProjectRevealRequest {
  readonly requestId: number;
  readonly projectRef: ScopedProjectRef;
}

export function scrollSidebarProjectIntoView(
  projectHeader: Pick<HTMLElement, "scrollIntoView">,
): void {
  projectHeader.scrollIntoView({
    behavior: "smooth",
    block: "center",
    inline: "nearest",
  });
}

export function resolveSidebarProjectRevealKey(input: {
  readonly projectRef: ScopedProjectRef;
  readonly physicalProjectKeyByScopedRef: ReadonlyMap<string, string>;
  readonly physicalToLogicalKey: ReadonlyMap<string, string>;
}): string | null {
  const physicalKey = input.physicalProjectKeyByScopedRef.get(scopedProjectKey(input.projectRef));
  if (!physicalKey) {
    return null;
  }

  return input.physicalToLogicalKey.get(physicalKey) ?? physicalKey;
}
