import {
  autoAnimate,
  type AnimationController,
  type AutoAnimateOptions,
} from "@formkit/auto-animate";
import { useCallback, useRef } from "react";

export const MAX_ANIMATED_SIDEBAR_THREAD_ROWS = 20;

const SIDEBAR_THREAD_LIST_ANIMATION_OPTIONS = {
  duration: 180,
  easing: "ease-out",
} as const satisfies Partial<AutoAnimateOptions>;

export function shouldAnimateSidebarThreadList(visibleRowCount: number): boolean {
  return visibleRowCount <= MAX_ANIMATED_SIDEBAR_THREAD_ROWS;
}

export type SidebarThreadListAutoAnimateRef = (
  node: HTMLElement | null,
  visibleRowCount: number,
) => void;

interface SidebarThreadListAnimationState {
  controller: AnimationController;
  visibleRowCount: number;
}

export function useSidebarThreadListAutoAnimateRef(): SidebarThreadListAutoAnimateRef {
  const animationStateRef = useRef(new WeakMap<HTMLElement, SidebarThreadListAnimationState>());

  return useCallback((node: HTMLElement | null, visibleRowCount: number) => {
    if (!node) return;

    let animationState = animationStateRef.current.get(node);
    if (!animationState) {
      animationState = {
        controller: autoAnimate(node, SIDEBAR_THREAD_LIST_ANIMATION_OPTIONS),
        visibleRowCount,
      };
      animationStateRef.current.set(node, animationState);
    }

    const previousRowCount = animationState.visibleRowCount;
    animationState.visibleRowCount = visibleRowCount;
    if (
      shouldAnimateSidebarThreadList(previousRowCount) &&
      shouldAnimateSidebarThreadList(visibleRowCount)
    ) {
      animationState.controller.enable();
      return;
    }

    animationState.controller.disable();
    if (!shouldAnimateSidebarThreadList(visibleRowCount)) return;

    // Keep the controller disabled until the MutationObserver has processed the bulk removal,
    // then restore normal animation behavior for later changes to the now-small list.
    const stateForEnable = animationState;
    queueMicrotask(() => {
      const currentState = animationStateRef.current.get(node);
      if (
        currentState === stateForEnable &&
        shouldAnimateSidebarThreadList(currentState.visibleRowCount)
      ) {
        currentState.controller.enable();
      }
    });
  }, []);
}
