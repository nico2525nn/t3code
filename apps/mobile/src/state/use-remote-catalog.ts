import { useMemo } from "react";

import type { ServerConfig as T3ServerConfig } from "@t3tools/contracts";

import { sortCopy } from "../lib/arrayCompat";
import type { ScopedMobileProject, ScopedMobileThread } from "../lib/scopedEntities";
import {
  deriveOverallConnectionState,
  type RemoteClientConnectionState,
} from "./remote-runtime-types";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentState,
} from "./use-remote-environment-registry";

export function useRemoteCatalog() {
  const { connectedEnvironments, connectionState } = useRemoteConnectionStatus();
  const { environmentStateById, savedConnectionsById } = useRemoteEnvironmentState();

  const projects = useMemo<ReadonlyArray<ScopedMobileProject>>(
    () =>
      sortCopy(
        Object.values(savedConnectionsById).flatMap((connection) =>
          (environmentStateById[connection.environmentId]?.snapshot?.projects ?? [])
            .filter((project) => project.deletedAt === null)
            .map((project) =>
              Object.assign({}, project, {
                environmentId: connection.environmentId,
                environmentLabel: connection.environmentLabel,
              }),
            ),
        ),
        (left, right) =>
          left.title.localeCompare(right.title) ||
          left.environmentLabel.localeCompare(right.environmentLabel),
      ),
    [environmentStateById, savedConnectionsById],
  );

  const threads = useMemo<ReadonlyArray<ScopedMobileThread>>(
    () =>
      sortCopy(
        Object.values(savedConnectionsById).flatMap((connection) =>
          (environmentStateById[connection.environmentId]?.snapshot?.threads ?? [])
            .filter((thread) => thread.deletedAt === null)
            .map((thread) =>
              Object.assign({}, thread, {
                environmentId: connection.environmentId,
                environmentLabel: connection.environmentLabel,
              }),
            ),
        ),
        (left, right) =>
          new Date(right.updatedAt ?? right.createdAt).getTime() -
            new Date(left.updatedAt ?? left.createdAt).getTime() ||
          right.environmentLabel.localeCompare(left.environmentLabel),
      ),
    [environmentStateById, savedConnectionsById],
  );

  const serverConfigByEnvironmentId = useMemo<Readonly<Record<string, T3ServerConfig | null>>>(
    () =>
      Object.fromEntries(
        Object.entries(environmentStateById).map(([environmentId, runtime]) => [
          environmentId,
          runtime.serverConfig ?? null,
        ]),
      ),
    [environmentStateById],
  );

  const overallConnectionState = useMemo<RemoteClientConnectionState>(
    () => deriveOverallConnectionState(connectedEnvironments),
    [connectedEnvironments],
  );

  const hasRemoteActivity = useMemo(
    () =>
      threads.some(
        (thread) => thread.session?.status === "running" || thread.session?.status === "starting",
      ),
    [threads],
  );

  return {
    projects,
    threads,
    serverConfigByEnvironmentId,
    connectionState: connectionState ?? overallConnectionState,
    hasRemoteActivity,
  };
}
