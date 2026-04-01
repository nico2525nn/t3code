import {
  type GitActionProgressEvent,
  type GitListBranchesResult,
  type GitResolvePullRequestResult,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusResult,
  WS_METHODS,
} from "@t3tools/contracts";
import { Duration, Effect, Stream } from "effect";
import { AsyncResult, Atom, Reactivity } from "effect/unstable/reactivity";

import { refreshIntervalSignalAtom, WsRpcAtomClient } from "./client";
import { REACTIVITY_KEYS } from "./client";
import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";

const GIT_ACTION_RESULT_MISSING_ERROR = {
  _tag: "GitActionResultMissing",
  message: "Git action stream completed without a final result.",
} as const;
export const gitRunStackedActionProgressAtom = Atom.make<GitActionProgressEvent | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("git-run-stacked-action-progress"),
);

const gitStatusQueryAtom = Atom.family((cwd: string) =>
  WsRpcAtomClient.query(
    WS_METHODS.gitStatus,
    { cwd },
    {
      timeToLive: "5 minutes",
      reactivityKeys: [REACTIVITY_KEYS.git(cwd)],
    },
  ),
);

export const gitStatusAtom = Atom.family((cwd: string | null) =>
  Atom.readable(
    (get): AsyncResult.AsyncResult<GitStatusResult, unknown> => {
      if (cwd === null) {
        return AsyncResult.initial();
      }
      return get(gitStatusQueryAtom(cwd));
    },
    (refresh) => {
      if (cwd !== null) {
        refresh(gitStatusQueryAtom(cwd));
      }
    },
  ),
);

const gitBranchesQueryAtom = Atom.family((cwd: string) =>
  WsRpcAtomClient.query(
    WS_METHODS.gitListBranches,
    { cwd },
    {
      timeToLive: "5 minutes",
      reactivityKeys: [REACTIVITY_KEYS.git(cwd)],
    },
  ),
);

export const gitBranchesAtom = Atom.family((cwd: string | null) =>
  Atom.readable(
    (get): AsyncResult.AsyncResult<GitListBranchesResult, unknown> => {
      if (cwd === null) {
        return AsyncResult.initial();
      }
      return get(gitBranchesQueryAtom(cwd));
    },
    (refresh) => {
      if (cwd !== null) {
        refresh(gitBranchesQueryAtom(cwd));
      }
    },
  ),
);

export const gitCheckoutMutationAtom = WsRpcAtomClient.mutation(WS_METHODS.gitCheckout);

export const gitCreateBranchMutationAtom = WsRpcAtomClient.mutation(WS_METHODS.gitCreateBranch);

export const gitCreateWorktreeMutationAtom = WsRpcAtomClient.mutation(WS_METHODS.gitCreateWorktree);

export const gitInitMutationAtom = WsRpcAtomClient.mutation(WS_METHODS.gitInit);

export const gitPreparePullRequestThreadMutationAtom = WsRpcAtomClient.mutation(
  WS_METHODS.gitPreparePullRequestThread,
);

export const gitPullMutationAtom = WsRpcAtomClient.mutation(WS_METHODS.gitPull);

export const gitRemoveWorktreeMutationAtom = WsRpcAtomClient.mutation(WS_METHODS.gitRemoveWorktree);

export const gitRunStackedActionMutationAtom = WsRpcAtomClient.runtime
  .fn<GitRunStackedActionInput>()(
    Effect.fn(
      function* (input, get) {
        get.set(gitRunStackedActionProgressAtom, null);
        const client = yield* WsRpcAtomClient;
        return yield* client(WS_METHODS.gitRunStackedAction, input).pipe(
          Stream.runFoldEffect(
            () => null as GitRunStackedActionResult | null,
            (result, event) =>
              Effect.sync(() => {
                get.set(gitRunStackedActionProgressAtom, event);
                return event.kind === "action_finished" ? event.result : result;
              }),
          ),
          Effect.flatMap((result) =>
            result !== null ? Effect.succeed(result) : Effect.fail(GIT_ACTION_RESULT_MISSING_ERROR),
          ),
        );
      },
      (effect, input) =>
        Effect.ensuring(effect, Reactivity.invalidate([REACTIVITY_KEYS.git(input.cwd)])),
    ),
  )
  .pipe(Atom.withLabel("git-run-stacked-action"));

const gitResolvePullRequestQueryAtom = Atom.family(
  (key: { readonly cwd: string; readonly reference: string }) =>
    WsRpcAtomClient.query(WS_METHODS.gitResolvePullRequest, key, {
      timeToLive: "30 minutes",
      reactivityKeys: [REACTIVITY_KEYS.git(key.cwd)],
    }),
);

export const gitResolvePullRequestAtom = Atom.family(
  (input: { readonly cwd: string | null; readonly reference: string | null }) =>
    Atom.readable(
      (get): AsyncResult.AsyncResult<GitResolvePullRequestResult, unknown> => {
        if (input.cwd === null || input.reference === null) {
          return AsyncResult.initial();
        }
        return get(
          gitResolvePullRequestQueryAtom({
            cwd: input.cwd,
            reference: input.reference,
          }),
        );
      },
      (refresh) => {
        if (input.cwd !== null && input.reference !== null) {
          refresh(
            gitResolvePullRequestQueryAtom({
              cwd: input.cwd,
              reference: input.reference,
            }),
          );
        }
      },
    ),
);

export function useGitStatuses(
  cwds: ReadonlyArray<string>,
): ReadonlyArray<AsyncResult.AsyncResult<GitStatusResult, unknown>> {
  const atoms = useMemo(() => {
    const refreshInterval = refreshIntervalSignalAtom(Duration.seconds(60));
    return cwds.map((cwd) => gitStatusAtom(cwd).pipe(Atom.makeRefreshOnSignal(refreshInterval)));
  }, [cwds]);
  const statusesAtom = useMemo(
    () => Atom.readable((get) => atoms.map((atom) => get(atom))),
    [atoms],
  );
  return useAtomValue(statusesAtom);
}
