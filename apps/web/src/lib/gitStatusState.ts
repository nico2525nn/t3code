import { useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  type GitManagerServiceError,
  type VcsStatusResult,
} from "@t3tools/contracts";
import { Cause } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { useEffect } from "react";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import type { WsRpcClient } from "~/rpc/wsRpcClient";

interface VcsStatusState {
  readonly data: VcsStatusResult | null;
  readonly error: GitManagerServiceError | null;
  readonly cause: Cause.Cause<GitManagerServiceError> | null;
  readonly isPending: boolean;
}

type VcsStatusClient = Pick<WsRpcClient["vcs"], "onStatus" | "refreshStatus">;
interface ResolvedVcsStatusClient {
  readonly clientIdentity: string;
  readonly client: VcsStatusClient;
}

interface WatchedVcsStatus {
  refCount: number;
  unsubscribe: () => void;
}

interface VcsStatusTarget {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
}

const EMPTY_VCS_STATUS_STATE = Object.freeze<VcsStatusState>({
  data: null,
  error: null,
  cause: null,
  isPending: false,
});
const INITIAL_VCS_STATUS_STATE = Object.freeze<VcsStatusState>({
  ...EMPTY_VCS_STATUS_STATE,
  isPending: true,
});
const EMPTY_VCS_STATUS_ATOM = Atom.make(EMPTY_VCS_STATUS_STATE).pipe(
  Atom.keepAlive,
  Atom.withLabel("vcs-status:null"),
);

const NOOP: () => void = () => undefined;
const watchedVcsStatuses = new Map<string, WatchedVcsStatus>();
const knownVcsStatusKeys = new Set<string>();
const vcsStatusRefreshInFlight = new Map<string, Promise<VcsStatusResult>>();
const vcsStatusLastRefreshAtByKey = new Map<string, number>();

const VCS_STATUS_REFRESH_DEBOUNCE_MS = 1_000;

const vcsStatusStateAtom = Atom.family((key: string) => {
  knownVcsStatusKeys.add(key);
  return Atom.make(INITIAL_VCS_STATUS_STATE).pipe(
    Atom.keepAlive,
    Atom.withLabel(`vcs-status:${key}`),
  );
});

function getVcsStatusTargetKey(target: VcsStatusTarget): string | null {
  if (target.environmentId === null || target.cwd === null) {
    return null;
  }

  return `${target.environmentId}:${target.cwd}`;
}

function readResolvedVcsStatusClient(target: VcsStatusTarget): ResolvedVcsStatusClient | null {
  if (target.environmentId === null) {
    return null;
  }
  const connection = readEnvironmentConnection(target.environmentId);
  return connection
    ? { clientIdentity: connection.environmentId, client: connection.client.vcs }
    : null;
}

export function getVcsStatusSnapshot(target: VcsStatusTarget): VcsStatusState {
  const targetKey = getVcsStatusTargetKey(target);
  if (targetKey === null) {
    return EMPTY_VCS_STATUS_STATE;
  }

  return appAtomRegistry.get(vcsStatusStateAtom(targetKey));
}

export function watchVcsStatus(target: VcsStatusTarget, client?: VcsStatusClient): () => void {
  const targetKey = getVcsStatusTargetKey(target);
  if (targetKey === null) {
    return NOOP;
  }

  const watched = watchedVcsStatuses.get(targetKey);
  if (watched) {
    watched.refCount += 1;
    return () => unwatchVcsStatus(targetKey);
  }

  watchedVcsStatuses.set(targetKey, {
    refCount: 1,
    unsubscribe: subscribeToVcsStatusTarget(targetKey, target, client),
  });

  return () => unwatchVcsStatus(targetKey);
}

export function refreshVcsStatus(
  target: VcsStatusTarget,
  client?: VcsStatusClient,
): Promise<VcsStatusResult | null> {
  const targetKey = getVcsStatusTargetKey(target);
  if (targetKey === null || target.cwd === null) {
    return Promise.resolve(null);
  }

  const resolvedClient = client ?? readResolvedVcsStatusClient(target)?.client;
  if (!resolvedClient) {
    return Promise.resolve(getVcsStatusSnapshot(target).data);
  }

  const currentInFlight = vcsStatusRefreshInFlight.get(targetKey);
  if (currentInFlight) {
    return currentInFlight;
  }

  const lastRequestedAt = vcsStatusLastRefreshAtByKey.get(targetKey) ?? 0;
  if (Date.now() - lastRequestedAt < VCS_STATUS_REFRESH_DEBOUNCE_MS) {
    return Promise.resolve(getVcsStatusSnapshot(target).data);
  }

  vcsStatusLastRefreshAtByKey.set(targetKey, Date.now());
  const refreshPromise = resolvedClient.refreshStatus({ cwd: target.cwd }).finally(() => {
    vcsStatusRefreshInFlight.delete(targetKey);
  });
  vcsStatusRefreshInFlight.set(targetKey, refreshPromise);
  return refreshPromise;
}

export function resetVcsStatusStateForTests(): void {
  for (const watched of watchedVcsStatuses.values()) {
    watched.unsubscribe();
  }
  watchedVcsStatuses.clear();
  vcsStatusRefreshInFlight.clear();
  vcsStatusLastRefreshAtByKey.clear();

  for (const key of knownVcsStatusKeys) {
    appAtomRegistry.set(vcsStatusStateAtom(key), INITIAL_VCS_STATUS_STATE);
  }
  knownVcsStatusKeys.clear();
}

export function useVcsStatus(target: VcsStatusTarget): VcsStatusState {
  const targetKey = getVcsStatusTargetKey(target);
  useEffect(
    () => watchVcsStatus({ environmentId: target.environmentId, cwd: target.cwd }),
    [target.environmentId, target.cwd],
  );

  const state = useAtomValue(
    targetKey !== null ? vcsStatusStateAtom(targetKey) : EMPTY_VCS_STATUS_ATOM,
  );
  return targetKey === null ? EMPTY_VCS_STATUS_STATE : state;
}

function unwatchVcsStatus(targetKey: string): void {
  const watched = watchedVcsStatuses.get(targetKey);
  if (!watched) {
    return;
  }

  watched.refCount -= 1;
  if (watched.refCount > 0) {
    return;
  }

  watched.unsubscribe();
  watchedVcsStatuses.delete(targetKey);
}

function subscribeToVcsStatusTarget(
  targetKey: string,
  target: VcsStatusTarget,
  providedClient?: VcsStatusClient,
): () => void {
  if (target.cwd === null) {
    return NOOP;
  }

  const cwd = target.cwd;
  let currentClientIdentity: string | null = null;
  let currentUnsubscribe = NOOP;

  const syncClientSubscription = () => {
    const resolved = providedClient
      ? {
          clientIdentity: `provided:${targetKey}`,
          client: providedClient,
        }
      : readResolvedVcsStatusClient(target);

    if (!resolved) {
      if (currentClientIdentity !== null) {
        currentUnsubscribe();
        currentUnsubscribe = NOOP;
        currentClientIdentity = null;
      }
      markVcsStatusPending(targetKey);
      return;
    }

    if (currentClientIdentity === resolved.clientIdentity) {
      return;
    }

    currentUnsubscribe();
    currentClientIdentity = resolved.clientIdentity;
    currentUnsubscribe = subscribeToVcsStatus(targetKey, cwd, resolved.client);
  };

  const unsubscribeRegistry = providedClient
    ? NOOP
    : subscribeEnvironmentConnections(syncClientSubscription);
  syncClientSubscription();

  return () => {
    unsubscribeRegistry();
    currentUnsubscribe();
  };
}

function subscribeToVcsStatus(targetKey: string, cwd: string, client: VcsStatusClient): () => void {
  markVcsStatusPending(targetKey);
  return client.onStatus(
    { cwd },
    (status: VcsStatusResult) => {
      appAtomRegistry.set(vcsStatusStateAtom(targetKey), {
        data: status,
        error: null,
        cause: null,
        isPending: false,
      });
    },
    {
      onResubscribe: () => {
        markVcsStatusPending(targetKey);
      },
    },
  );
}

function markVcsStatusPending(targetKey: string): void {
  const atom = vcsStatusStateAtom(targetKey);
  const current = appAtomRegistry.get(atom);
  const next =
    current.data === null
      ? INITIAL_VCS_STATUS_STATE
      : {
          ...current,
          error: null,
          cause: null,
          isPending: true,
        };

  if (
    current.data === next.data &&
    current.error === next.error &&
    current.cause === next.cause &&
    current.isPending === next.isPending
  ) {
    return;
  }

  appAtomRegistry.set(atom, next);
}

export const getGitStatusSnapshot = getVcsStatusSnapshot;
export const watchGitStatus = watchVcsStatus;
export const refreshGitStatus = refreshVcsStatus;
export const resetGitStatusStateForTests = resetVcsStatusStateForTests;
export const useGitStatus = useVcsStatus;
