import { useAtomValue } from "@effect/atom-react";
import { type GitManagerServiceError, type GitStatusResult } from "@t3tools/contracts";
import { Cause } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { useEffect, useMemo, useState } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { getWsRpcClient, type WsRpcClient } from "../wsRpcClient";

export type GitStatusStreamError = GitManagerServiceError;

export interface GitStatusState {
  readonly data: GitStatusResult | null;
  readonly error: GitStatusStreamError | null;
  readonly cause: Cause.Cause<GitStatusStreamError> | null;
  readonly isPending: boolean;
}

type GitStatusClient = Pick<WsRpcClient["git"], "onStatus">;

interface GitStatusEntry {
  readonly atom: typeof EMPTY_GIT_STATUS_STATE_ATOM;
  client: GitStatusClient | null;
  retainCount: number;
  unsubscribe: () => void;
}

const EMPTY_GIT_STATUS_STATE = Object.freeze<GitStatusState>({
  data: null,
  error: null,
  cause: null,
  isPending: false,
});

const EMPTY_GIT_STATUS_STATE_ATOM = makeStateAtom("git-status-empty", EMPTY_GIT_STATUS_STATE);
const NOOP: () => void = () => undefined;
const gitStatusEntries = new Map<string, GitStatusEntry>();

function makeStateAtom<A>(label: string, initialValue: A) {
  return Atom.make(initialValue).pipe(Atom.keepAlive, Atom.withLabel(label));
}

function getGitStatusEntry(cwd: string): GitStatusEntry {
  const existing = gitStatusEntries.get(cwd);
  if (existing) {
    return existing;
  }

  const entry: GitStatusEntry = {
    atom: makeStateAtom(`git-status:${cwd}`, EMPTY_GIT_STATUS_STATE),
    client: null,
    retainCount: 0,
    unsubscribe: NOOP,
  };
  gitStatusEntries.set(cwd, entry);
  return entry;
}

function connectGitStatusEntry(cwd: string, entry: GitStatusEntry): void {
  if (!entry.client) {
    return;
  }

  markGitStatusPending(entry.atom);
  entry.unsubscribe = entry.client.onStatus(
    { cwd },
    (status) => {
      appAtomRegistry.set(entry.atom, {
        data: status,
        error: null,
        cause: null,
        isPending: false,
      });
    },
    {
      onResubscribe: () => {
        markGitStatusPending(entry.atom);
      },
    },
  );
}

function disconnectGitStatusEntry(entry: GitStatusEntry): void {
  entry.unsubscribe();
  entry.unsubscribe = NOOP;
}

function markGitStatusPending(atom: typeof EMPTY_GIT_STATUS_STATE_ATOM): void {
  const current = appAtomRegistry.get(atom);
  const nextState =
    current.data === null
      ? { ...EMPTY_GIT_STATUS_STATE, isPending: true }
      : {
          ...current,
          error: null,
          cause: null,
          isPending: true,
        };

  if (
    current.data === nextState.data &&
    current.error === nextState.error &&
    current.cause === nextState.cause &&
    current.isPending === nextState.isPending
  ) {
    return;
  }

  appAtomRegistry.set(atom, nextState);
}

export function getGitStatusSnapshot(cwd: string | null): GitStatusState {
  if (cwd === null) {
    return EMPTY_GIT_STATUS_STATE;
  }

  return appAtomRegistry.get(getGitStatusEntry(cwd).atom);
}

export function retainGitStatusSync(
  cwd: string | null,
  client: GitStatusClient = getWsRpcClient().git,
): () => void {
  if (cwd === null) {
    return NOOP;
  }

  const entry = getGitStatusEntry(cwd);
  entry.client = client;
  entry.retainCount += 1;

  if (entry.retainCount === 1) {
    connectGitStatusEntry(cwd, entry);
  }

  return () => {
    if (entry.retainCount === 0) {
      return;
    }

    entry.retainCount -= 1;
    if (entry.retainCount === 0) {
      disconnectGitStatusEntry(entry);
    }
  };
}

export function refreshGitStatus(cwd: string | null): void {
  if (cwd === null) {
    return;
  }

  const entry = gitStatusEntries.get(cwd);
  if (!entry || entry.retainCount === 0) {
    return;
  }

  disconnectGitStatusEntry(entry);
  connectGitStatusEntry(cwd, entry);
}

export function resetGitStatusStateForTests(): void {
  for (const entry of gitStatusEntries.values()) {
    disconnectGitStatusEntry(entry);
  }
  gitStatusEntries.clear();
}

export function useGitStatus(cwd: string | null): GitStatusState {
  useEffect(() => retainGitStatusSync(cwd), [cwd]);

  const atom = useMemo(
    () => (cwd === null ? EMPTY_GIT_STATUS_STATE_ATOM : getGitStatusEntry(cwd).atom),
    [cwd],
  );

  return useAtomValue(atom);
}

export function useGitStatuses(cwds: ReadonlyArray<string>): ReadonlyMap<string, GitStatusResult> {
  const [statusByCwd, setStatusByCwd] = useState<ReadonlyMap<string, GitStatusResult>>(
    () => new Map(),
  );
  const subscriptionKey = getGitStatusSubscriptionKey(cwds);
  const trackedCwds = useMemo<ReadonlyArray<string>>(
    () => (subscriptionKey.length === 0 ? [] : subscriptionKey.split("\u0000")),
    [subscriptionKey],
  );

  useEffect(() => {
    const releaseSubscriptions = trackedCwds.map((cwd) => retainGitStatusSync(cwd));
    setStatusByCwd((current) => pruneStatusByCwd(current, trackedCwds));

    const cleanups = trackedCwds.map((cwd) =>
      appAtomRegistry.subscribe(
        getGitStatusEntry(cwd).atom,
        (state) => {
          setStatusByCwd((current) => {
            const next = new Map(current);
            if (state.data) {
              next.set(cwd, state.data);
            } else {
              next.delete(cwd);
            }
            return next;
          });
        },
        { immediate: true },
      ),
    );

    return () => {
      for (const cleanup of cleanups) {
        cleanup();
      }
      for (const release of releaseSubscriptions) {
        release();
      }
    };
  }, [trackedCwds]);

  return statusByCwd;
}

export function getGitStatusSubscriptionKey(cwds: ReadonlyArray<string>): string {
  return normalizeTrackedGitStatusCwds(cwds).join("\u0000");
}

function normalizeTrackedGitStatusCwds(cwds: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(cwds)].toSorted();
}

export function pruneStatusByCwd(
  current: ReadonlyMap<string, GitStatusResult>,
  cwds: ReadonlyArray<string>,
): ReadonlyMap<string, GitStatusResult> {
  const cwdSet = new Set(cwds);
  let shouldPrune = false;
  for (const key of current.keys()) {
    if (!cwdSet.has(key)) {
      shouldPrune = true;
      break;
    }
  }

  if (!shouldPrune) {
    return current;
  }

  const next = new Map<string, GitStatusResult>();
  for (const [key, value] of current) {
    if (cwdSet.has(key)) {
      next.set(key, value);
    }
  }
  return next;
}
