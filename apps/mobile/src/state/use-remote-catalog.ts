import { useMemo } from "react";

import type { ServerConfig as T3ServerConfig } from "@t3tools/contracts";
import * as Order from "effect/Order";
import * as Arr from "effect/Array";
import type { ScopedMobileProject, ScopedMobileThread } from "../lib/scopedEntities";
import {
  deriveOverallConnectionState,
  type RemoteClientConnectionState,
} from "./remote-runtime-types";
import {
  useRemoteConnectionStatus,
  useRemoteEnvironmentState,
} from "./use-remote-environment-registry";

const projectsSortOrder = Order.make<ScopedMobileProject>(
  (left, right) =>
    (left.title.localeCompare(right.title) as -1 | 0 | 1) ||
    (left.environmentLabel.localeCompare(right.environmentLabel) as -1 | 0 | 1),
);

const threadsSortOrder = Order.make<ScopedMobileThread>(
  (left, right) =>
    ((new Date(right.updatedAt ?? right.createdAt).getTime() -
      new Date(left.updatedAt ?? left.createdAt).getTime()) as -1 | 0 | 1) ||
    (left.environmentLabel.localeCompare(right.environmentLabel) as -1 | 0 | 1),
);

export function useRemoteCatalog() {
  const { connectedEnvironments, connectionState } = useRemoteConnectionStatus();
  const { environmentStateById, savedConnectionsById } = useRemoteEnvironmentState();

  const projects = useMemo<ReadonlyArray<ScopedMobileProject>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).flatMap((connection) =>
          (environmentStateById[connection.environmentId]?.snapshot?.projects ?? []).map(
            (project) =>
              Object.assign({}, project, {
                environmentId: connection.environmentId,
                environmentLabel: connection.environmentLabel,
              }),
          ),
        ),
        projectsSortOrder,
      ),
    [environmentStateById, savedConnectionsById],
  );

  const threads = useMemo<ReadonlyArray<ScopedMobileThread>>(
    () =>
      Arr.sort(
        Object.values(savedConnectionsById).flatMap((connection) =>
          (environmentStateById[connection.environmentId]?.snapshot?.threads ?? []).map((thread) =>
            Object.assign({}, thread, {
              environmentId: connection.environmentId,
              environmentLabel: connection.environmentLabel,
              deletedAt: null,
              messages: [],
              proposedPlans: [],
              activities: [],
              checkpoints: [],
            }),
          ),
        ),
        threadsSortOrder,
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
