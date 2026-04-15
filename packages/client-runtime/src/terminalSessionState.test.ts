import { AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it } from "vitest";

import type { TerminalSessionSnapshot } from "@t3tools/contracts";

import { createTerminalSessionManager } from "./terminalSessionState";

let atomRegistry = AtomRegistry.make();

function resetAtomRegistry() {
  atomRegistry.dispose();
  atomRegistry = AtomRegistry.make();
}

const TARGET = {
  environmentId: "env-local",
  threadId: "thread-1",
  terminalId: "default",
} as const;

const BASE_SNAPSHOT: TerminalSessionSnapshot = {
  threadId: TARGET.threadId,
  terminalId: TARGET.terminalId,
  cwd: "/repo",
  worktreePath: null,
  status: "running",
  pid: 123,
  history: "hello",
  exitCode: null,
  exitSignal: null,
  updatedAt: "2026-04-01T00:00:00.000Z",
};

describe("createTerminalSessionManager", () => {
  afterEach(() => {
    resetAtomRegistry();
  });

  it("hydrates from started snapshots and appends output events", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });

    manager.applyEvent(TARGET, {
      type: "started",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: BASE_SNAPSHOT.updatedAt,
      snapshot: BASE_SNAPSHOT,
    });
    manager.applyEvent(TARGET, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:01.000Z",
      data: " world",
    });

    expect(manager.getSnapshot(TARGET)).toMatchObject({
      snapshot: BASE_SNAPSHOT,
      buffer: "hello world",
      status: "running",
      error: null,
      updatedAt: "2026-04-01T00:00:01.000Z",
    });
  });

  it("caps retained output", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
      maxBufferBytes: 5,
    });

    manager.applyEvent(TARGET, {
      type: "output",
      threadId: TARGET.threadId,
      terminalId: TARGET.terminalId,
      createdAt: "2026-04-01T00:00:01.000Z",
      data: "abcdef",
    });

    expect(manager.getSnapshot(TARGET).buffer).toBe("bcdef");
  });

  it("invalidates one environment without clearing others", () => {
    const manager = createTerminalSessionManager({
      getRegistry: () => atomRegistry,
    });
    const otherTarget = {
      environmentId: "env-remote",
      threadId: "thread-1",
      terminalId: "default",
    } as const;

    for (const target of [TARGET, otherTarget]) {
      manager.applyEvent(target, {
        type: "output",
        threadId: target.threadId,
        terminalId: target.terminalId,
        createdAt: "2026-04-01T00:00:01.000Z",
        data: target.environmentId,
      });
    }

    manager.invalidateEnvironment(TARGET.environmentId);

    expect(manager.getSnapshot(TARGET).buffer).toBe("");
    expect(manager.getSnapshot(otherTarget).buffer).toBe("env-remote");
  });
});
