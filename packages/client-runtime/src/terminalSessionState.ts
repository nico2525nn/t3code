import type { TerminalEvent, TerminalSessionSnapshot } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/unstable/reactivity";

export interface TerminalSessionState {
  readonly snapshot: TerminalSessionSnapshot | null;
  readonly buffer: string;
  readonly status: TerminalSessionSnapshot["status"] | "closed";
  readonly error: string | null;
  readonly hasRunningSubprocess: boolean;
  readonly updatedAt: string | null;
  readonly version: number;
}

export interface TerminalSessionTarget {
  readonly environmentId: string | null;
  readonly threadId: string | null;
  readonly terminalId: string | null;
}

export interface TerminalSessionManagerConfig {
  readonly getRegistry: () => AtomRegistry.AtomRegistry;
  readonly maxBufferBytes?: number;
}

export const EMPTY_TERMINAL_SESSION_STATE = Object.freeze<TerminalSessionState>({
  snapshot: null,
  buffer: "",
  status: "closed",
  error: null,
  hasRunningSubprocess: false,
  updatedAt: null,
  version: 0,
});

const DEFAULT_MAX_BUFFER_BYTES = 512 * 1024;
const knownTerminalSessionKeys = new Set<string>();

export const terminalSessionStateAtom = Atom.family((key: string) => {
  knownTerminalSessionKeys.add(key);
  return Atom.make(EMPTY_TERMINAL_SESSION_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`terminal-session:${key}`),
  );
});

export const EMPTY_TERMINAL_SESSION_ATOM = Atom.make(EMPTY_TERMINAL_SESSION_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("terminal-session:null"),
);

export function getTerminalSessionTargetKey(target: TerminalSessionTarget): string | null {
  if (target.environmentId === null || target.threadId === null || target.terminalId === null) {
    return null;
  }

  return `${target.environmentId}:${target.threadId}:${target.terminalId}`;
}

function trimBufferToBytes(buffer: string, maxBufferBytes: number): string {
  if (buffer.length <= maxBufferBytes) {
    return buffer;
  }

  return buffer.slice(buffer.length - maxBufferBytes);
}

function stateFromSnapshot(
  snapshot: TerminalSessionSnapshot,
  maxBufferBytes: number,
): TerminalSessionState {
  return {
    snapshot,
    buffer: trimBufferToBytes(snapshot.history, maxBufferBytes),
    status: snapshot.status,
    error: null,
    hasRunningSubprocess: false,
    updatedAt: snapshot.updatedAt,
    version: 1,
  };
}

export function createTerminalSessionManager(config: TerminalSessionManagerConfig) {
  const maxBufferBytes = config.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

  function getSnapshot(target: TerminalSessionTarget): TerminalSessionState {
    const targetKey = getTerminalSessionTargetKey(target);
    if (targetKey === null) {
      return EMPTY_TERMINAL_SESSION_STATE;
    }

    return config.getRegistry().get(terminalSessionStateAtom(targetKey));
  }

  function setState(targetKey: string, nextState: TerminalSessionState): void {
    config.getRegistry().set(terminalSessionStateAtom(targetKey), nextState);
  }

  function applyEvent(
    target: Pick<TerminalSessionTarget, "environmentId">,
    event: TerminalEvent,
  ): void {
    const targetKey = getTerminalSessionTargetKey({
      environmentId: target.environmentId,
      threadId: event.threadId,
      terminalId: event.terminalId,
    });
    if (targetKey === null) {
      return;
    }

    const current = config.getRegistry().get(terminalSessionStateAtom(targetKey));
    switch (event.type) {
      case "started":
      case "restarted":
        setState(targetKey, stateFromSnapshot(event.snapshot, maxBufferBytes));
        return;
      case "output":
        setState(targetKey, {
          ...current,
          buffer: trimBufferToBytes(`${current.buffer}${event.data}`, maxBufferBytes),
          status: current.status === "closed" ? "running" : current.status,
          error: null,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
      case "cleared":
        setState(targetKey, {
          ...current,
          buffer: "",
          error: null,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
      case "exited":
        setState(targetKey, {
          ...current,
          snapshot: current.snapshot
            ? {
                ...current.snapshot,
                status: "exited",
                exitCode: event.exitCode,
                exitSignal: event.exitSignal,
                updatedAt: event.createdAt,
              }
            : null,
          status: "exited",
          hasRunningSubprocess: false,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
      case "error":
        setState(targetKey, {
          ...current,
          status: "error",
          error: event.message,
          hasRunningSubprocess: false,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
      case "activity":
        setState(targetKey, {
          ...current,
          hasRunningSubprocess: event.hasRunningSubprocess,
          updatedAt: event.createdAt,
          version: current.version + 1,
        });
        return;
    }
  }

  function invalidate(target?: TerminalSessionTarget): void {
    if (target) {
      const targetKey = getTerminalSessionTargetKey(target);
      if (targetKey !== null) {
        setState(targetKey, EMPTY_TERMINAL_SESSION_STATE);
      }
      return;
    }

    for (const key of knownTerminalSessionKeys) {
      setState(key, EMPTY_TERMINAL_SESSION_STATE);
    }
  }

  function invalidateEnvironment(environmentId: string): void {
    const prefix = `${environmentId}:`;
    for (const key of knownTerminalSessionKeys) {
      if (key.startsWith(prefix)) {
        setState(key, EMPTY_TERMINAL_SESSION_STATE);
      }
    }
  }

  function reset(): void {
    invalidate();
  }

  return {
    applyEvent,
    getSnapshot,
    invalidate,
    invalidateEnvironment,
    reset,
  };
}
