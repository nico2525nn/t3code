import {
  serverSettingsAtom,
  updateServerSettingsArg,
  updateServerSettingsMutation,
  type T3RpcAtomRuntime,
} from "@t3tools/client-runtime";
import {
  ServerSettingsError,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { Data, Effect } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getPrimaryKnownEnvironment } from "../environments/primary";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";

export class RpcAtomRuntimeUnavailableError extends Data.TaggedError(
  "RpcAtomRuntimeUnavailableError",
)<{
  readonly environmentId: string | null;
}> {}

export type ServerSettingsRpcAtomError =
  | ServerSettingsError
  | RpcClientError
  | RpcAtomRuntimeUnavailableError;

export type UpdatePrimaryServerSettingsRpc = (
  patch: ServerSettingsPatch,
) => Effect.Effect<ServerSettings, ServerSettingsRpcAtomError>;

const missingServerSettingsAtom = Atom.make(
  AsyncResult.initial<ServerSettings, ServerSettingsRpcAtomError>(true),
).pipe(Atom.keepAlive, Atom.withLabel("rpc:server-settings:missing-runtime"));

export function usePrimaryEnvironmentRpcAtomRuntime(): T3RpcAtomRuntime | null {
  const [, forceSync] = useState(0);

  useEffect(() => subscribeEnvironmentConnections(() => forceSync((version) => version + 1)), []);

  const environmentId = getPrimaryKnownEnvironment()?.environmentId ?? null;
  return environmentId ? (readEnvironmentConnection(environmentId)?.atomRpc ?? null) : null;
}

export function usePrimaryServerSettingsRpcResult() {
  const runtime = usePrimaryEnvironmentRpcAtomRuntime();
  const atom = useMemo(
    () =>
      (runtime ? serverSettingsAtom(runtime) : missingServerSettingsAtom) as Atom.Atom<
        AsyncResult.AsyncResult<ServerSettings, ServerSettingsRpcAtomError>
      >,
    [runtime],
  );

  return useAtomValue(atom);
}

export function useUpdatePrimaryServerSettingsRpc(): UpdatePrimaryServerSettingsRpc {
  const runtime = usePrimaryEnvironmentRpcAtomRuntime();
  const mutation = useMemo(
    () => (runtime ? updateServerSettingsMutation(runtime) : null),
    [runtime],
  );

  return useCallback<UpdatePrimaryServerSettingsRpc>(
    (patch: ServerSettingsPatch) => {
      if (!runtime || !mutation) {
        return Effect.fail(
          new RpcAtomRuntimeUnavailableError({
            environmentId: getPrimaryKnownEnvironment()?.environmentId ?? null,
          }),
        );
      }

      return runtime.runMutation(mutation, updateServerSettingsArg(patch), {
        suspendOnWaiting: true,
      });
    },
    [mutation, runtime],
  );
}
