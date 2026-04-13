import { useAtomValue } from "@effect/atom-react";
import {
  type GitActionState,
  type GitActionTarget,
  EMPTY_GIT_ACTION_ATOM,
  EMPTY_GIT_ACTION_STATE,
  createGitActionManager,
  getGitActionTargetKey,
  gitActionStateAtom,
} from "@t3tools/client-runtime";

import { uuidv4 } from "../lib/uuid";
import { appAtomRegistry } from "./atomRegistry";
import { getEnvironmentClient } from "./use-remote-environment-registry";

export const gitActionManager = createGitActionManager({
  getRegistry: () => appAtomRegistry,
  getClient: (environmentId) => {
    const client = getEnvironmentClient(environmentId);
    return client ? client.git : null;
  },
  getActionId: uuidv4,
});

export function useGitActionState(target: GitActionTarget): GitActionState {
  const targetKey = getGitActionTargetKey(target);
  const state = useAtomValue(
    targetKey !== null ? gitActionStateAtom(targetKey) : EMPTY_GIT_ACTION_ATOM,
  );
  return targetKey === null ? EMPTY_GIT_ACTION_STATE : state;
}
