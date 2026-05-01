import { Context, Effect } from "effect";
import type {
  ChangeRequest,
  ChangeRequestState,
  SourceControlProviderError,
  SourceControlProviderKind,
  SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";

export interface SourceControlProviderShape {
  readonly kind: SourceControlProviderKind;
  readonly listChangeRequests: (input: {
    readonly cwd: string;
    readonly headSelector: string;
    readonly state: ChangeRequestState | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError>;
  readonly getChangeRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
  }) => Effect.Effect<ChangeRequest, SourceControlProviderError>;
  readonly createChangeRequest: (input: {
    readonly cwd: string;
    readonly baseRefName: string;
    readonly headSelector: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<void, SourceControlProviderError>;
  readonly getRepositoryCloneUrls: (input: {
    readonly cwd: string;
    readonly repository: string;
  }) => Effect.Effect<SourceControlRepositoryCloneUrls, SourceControlProviderError>;
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, SourceControlProviderError>;
  readonly checkoutChangeRequest: (input: {
    readonly cwd: string;
    readonly reference: string;
    readonly force?: boolean;
  }) => Effect.Effect<void, SourceControlProviderError>;
}

export class SourceControlProvider extends Context.Service<
  SourceControlProvider,
  SourceControlProviderShape
>()("t3/source-control/SourceControlProvider") {}
