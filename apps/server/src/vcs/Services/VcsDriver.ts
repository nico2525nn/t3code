import { Context, type Effect } from "effect";

import type {
  VcsDriverCapabilities,
  VcsError,
  VcsListWorkspaceFilesResult,
  VcsRepositoryIdentity,
} from "@t3tools/contracts";
import type { GitCoreShape } from "../../git/Services/GitCore.ts";
import type { VcsProcessInput, VcsProcessOutput } from "./VcsProcess.ts";

export interface VcsDriverShape extends Omit<GitCoreShape, "execute"> {
  readonly capabilities: VcsDriverCapabilities;
  readonly execute: (
    input: Omit<VcsProcessInput, "command">,
  ) => Effect.Effect<VcsProcessOutput, VcsError>;
  readonly detectRepository: (cwd: string) => Effect.Effect<VcsRepositoryIdentity | null, VcsError>;
  readonly isInsideWorkTree: (cwd: string) => Effect.Effect<boolean, VcsError>;
  readonly listWorkspaceFiles: (
    cwd: string,
  ) => Effect.Effect<VcsListWorkspaceFilesResult, VcsError>;
  readonly filterIgnoredPaths: (
    cwd: string,
    relativePaths: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyArray<string>, VcsError>;
}

export class VcsDriver extends Context.Service<VcsDriver, VcsDriverShape>()(
  "t3/vcs/Services/VcsDriver",
) {}
