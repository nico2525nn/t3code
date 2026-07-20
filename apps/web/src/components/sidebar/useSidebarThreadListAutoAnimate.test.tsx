import type { AnimationController } from "@formkit/auto-animate";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  autoAnimate: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useCallback: <T,>(callback: T): T => callback,
    useRef: <T,>(initialValue: T): { current: T } => ({ current: initialValue }),
  };
});

vi.mock("@formkit/auto-animate", () => ({
  autoAnimate: testState.autoAnimate,
}));

import {
  MAX_ANIMATED_SIDEBAR_THREAD_ROWS,
  shouldAnimateSidebarThreadList,
  useSidebarThreadListAutoAnimateRef,
} from "./useSidebarThreadListAutoAnimate";

function makeController(): AnimationController {
  return {
    parent: {} as Element,
    enable: vi.fn(),
    disable: vi.fn(),
    isEnabled: vi.fn(() => true),
    destroy: vi.fn(),
  };
}

describe("useSidebarThreadListAutoAnimateRef", () => {
  beforeEach(() => {
    testState.autoAnimate.mockReset();
  });

  it("keeps animation enabled for ordinary sidebar thread lists", () => {
    const controller = makeController();
    testState.autoAnimate.mockReturnValue(controller);
    const attach = useSidebarThreadListAutoAnimateRef();
    const node = {} as HTMLElement;

    attach(node, MAX_ANIMATED_SIDEBAR_THREAD_ROWS);

    expect(testState.autoAnimate).toHaveBeenCalledOnce();
    expect(controller.enable).toHaveBeenCalledOnce();
    expect(controller.disable).not.toHaveBeenCalled();
  });

  it("bypasses animations when the list grows beyond the threshold", () => {
    const controller = makeController();
    testState.autoAnimate.mockReturnValue(controller);
    const attach = useSidebarThreadListAutoAnimateRef();
    const node = {} as HTMLElement;

    attach(node, MAX_ANIMATED_SIDEBAR_THREAD_ROWS);
    attach(node, MAX_ANIMATED_SIDEBAR_THREAD_ROWS + 1);

    expect(testState.autoAnimate).toHaveBeenCalledOnce();
    expect(controller.disable).toHaveBeenCalledOnce();
    expect(controller.enable).toHaveBeenCalledOnce();
  });

  it("keeps animation disabled through a bulk removal before restoring it", async () => {
    const controller = makeController();
    testState.autoAnimate.mockReturnValue(controller);
    const attach = useSidebarThreadListAutoAnimateRef();
    const node = {} as HTMLElement;

    attach(node, MAX_ANIMATED_SIDEBAR_THREAD_ROWS + 1);
    attach(node, MAX_ANIMATED_SIDEBAR_THREAD_ROWS - 1);

    expect(controller.disable).toHaveBeenCalledTimes(2);
    expect(controller.enable).not.toHaveBeenCalled();

    await Promise.resolve();

    expect(controller.enable).toHaveBeenCalledOnce();
  });

  it("uses the threshold as the exact animation boundary", () => {
    expect(shouldAnimateSidebarThreadList(MAX_ANIMATED_SIDEBAR_THREAD_ROWS)).toBe(true);
    expect(shouldAnimateSidebarThreadList(MAX_ANIMATED_SIDEBAR_THREAD_ROWS + 1)).toBe(false);
  });
});
