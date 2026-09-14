import { expect, it } from "@effect/vitest";
import {
  DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProviderSession,
  type ProviderSessionStartInput,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import type { ProviderStoredThreadSummary } from "../provider/Services/ProviderAdapter.ts";
import * as ServerSettings from "../serverSettings.ts";
import { syncCodexAppServerThreads } from "./CodexAppServerThreadSync.ts";

const provider = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const now = "2026-09-14T00:00:00.000Z";

function listedThread(input: {
  readonly nativeThreadId: string;
  readonly active?: boolean;
  readonly activeTurnId?: string;
  readonly latestTurnId?: string;
  readonly archived?: boolean;
  readonly title?: string;
  readonly updatedAt?: string;
}): ProviderStoredThreadSummary {
  return {
    nativeThreadId: input.nativeThreadId,
    cwd: "/tmp/codex-project",
    title: input.title ?? `${input.nativeThreadId} title`,
    preview: `${input.nativeThreadId} preview`,
    createdAt: now,
    updatedAt: input.updatedAt ?? "2026-09-14T00:00:05.000Z",
    archived: input.archived ?? false,
    ephemeral: false,
    subAgent: false,
    active: input.active ?? false,
    ...(input.activeTurnId ? { activeTurnId: TurnId.make(input.activeTurnId) } : {}),
    ...(input.latestTurnId ? { latestTurnId: TurnId.make(input.latestTurnId) } : {}),
  };
}

function emptyReadModel(
  thread?: Partial<OrchestrationReadModel["threads"][number]>,
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: thread
      ? [
          {
            id: ThreadId.make("codex:native-thread"),
            projectId: "project-codex",
            title: "Codex thread",
            modelSelection: { instanceId, model: DEFAULT_MODEL },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            pullRequests: [],
            linkedPullRequest: null,
            branchPullRequest: null,
            latestTurn: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            deletedAt: null,
            messages: [],
            proposedPlans: [],
            activities: [],
            checkpoints: [],
            session: null,
            ...thread,
          },
        ]
      : [],
    updatedAt: now,
  } as unknown as OrchestrationReadModel;
}

function catalogOnly(summaries: ReadonlyArray<ProviderStoredThreadSummary>, readCalls: string[]) {
  return {
    listStoredThreads: () => Effect.succeed(summaries),
    // Startup synchronization must never turn a catalog pass into a transcript
    // import. A test failure here is more useful than silently doing the old
    // O(history) work again.
    readStoredThread: ({ nativeThreadId }: { readonly nativeThreadId: string }) =>
      Effect.sync(() => {
        readCalls.push(nativeThreadId);
        throw new Error("catalog synchronization must not read thread history");
      }),
  };
}

function runSync(
  catalog: ReturnType<typeof catalogOnly>,
  readModel: OrchestrationReadModel,
  bindings: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata> = [],
  commands: OrchestrationCommand[] = [],
  upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [],
  starts: ProviderSessionStartInput[] = [],
  liveSessions: ReadonlyArray<ProviderSession> = [],
  checkpointContext?: ProjectionSnapshotQuery.ProjectionThreadCheckpointContext,
) {
  const query = {
    getCommandReadModel: () => Effect.succeed(readModel),
    getThreadCheckpointContext: () =>
      Effect.succeed(
        checkpointContext === undefined ? Option.none() : Option.some(checkpointContext),
      ),
  } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    latestSequence: Effect.succeed(0),
  } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"];
  const directory = {
    listBindings: () => Effect.succeed(bindings),
    upsert: (binding: ProviderSessionDirectory.ProviderRuntimeBinding) =>
      Effect.sync(() => {
        upserts.push(binding);
      }),
  } as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"];
  const providerService = {
    listSessions: () => Effect.succeed(liveSessions),
    startSession: (_threadId: ThreadId, input: ProviderSessionStartInput) =>
      Effect.sync(() => {
        starts.push(input);
        return {};
      }),
  } as unknown as ProviderService.ProviderService["Service"];
  const instance = {
    instanceId,
    driverKind: provider,
    enabled: true,
    adapter: { storedThreadCatalog: catalog },
  };

  return syncCodexAppServerThreads.pipe(
    Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, query),
    Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      listInstances: Effect.succeed([instance]),
    } as never),
    Effect.provideService(ProviderService.ProviderService, providerService),
    Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directory),
    Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
    Effect.provide(
      Layer.mergeAll(
        ServerSettings.layerTest({ defaultModelSelection: { instanceId, model: DEFAULT_MODEL } }),
        NodeServices.layer,
      ),
    ),
  );
}

const bindingFor = (
  nativeThreadId: string,
): ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata => ({
  threadId: ThreadId.make(`codex:${nativeThreadId}`),
  provider,
  providerInstanceId: instanceId,
  status: "stopped",
  resumeCursor: { threadId: nativeThreadId },
  runtimePayload: {
    cwd: "/tmp/codex-project",
    modelSelection: { instanceId, model: DEFAULT_MODEL },
    preserveProviderSettingsOnResume: true,
  },
  lastSeenAt: now,
});

it.layer(NodeServices.layer)("Codex App Server thread catalog sync", (it) => {
  it.effect("creates only project/thread shells and starts an active native thread", () =>
    Effect.gen(function* () {
      const nativeThreadId = "native-active";
      const readCalls: string[] = [];
      const commands: OrchestrationCommand[] = [];
      const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
      const starts: ProviderSessionStartInput[] = [];
      yield* runSync(
        catalogOnly(
          [listedThread({ nativeThreadId, active: true, activeTurnId: "turn-1" })],
          readCalls,
        ),
        emptyReadModel(),
        [],
        commands,
        upserts,
        starts,
      );

      expect(readCalls).toEqual([]);
      expect(commands.map((command) => command.type)).toEqual(["project.create", "thread.create"]);
      expect(upserts).toMatchObject([
        {
          threadId: ThreadId.make(`codex:${nativeThreadId}`),
          resumeCursor: { threadId: nativeThreadId },
          runtimePayload: {
            cwd: "/tmp/codex-project",
            modelSelection: { instanceId, model: DEFAULT_MODEL },
            preserveProviderSettingsOnResume: true,
          },
        },
      ]);
      expect(starts).toMatchObject([
        {
          threadId: ThreadId.make(`codex:${nativeThreadId}`),
          resumeCursor: { threadId: nativeThreadId },
          activeTurnId: TurnId.make("turn-1"),
        },
      ]);
    }),
  );

  it.effect("does not reread or duplicate a settled native thread", () =>
    Effect.gen(function* () {
      const nativeThreadId = "native-idle";
      const readCalls: string[] = [];
      const commands: OrchestrationCommand[] = [];
      const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
      yield* runSync(
        catalogOnly([listedThread({ nativeThreadId })], readCalls),
        emptyReadModel({
          id: ThreadId.make(`codex:${nativeThreadId}`),
          title: `${nativeThreadId} title`,
          settledOverride: "settled",
        }),
        [bindingFor(nativeThreadId)],
        commands,
        upserts,
      );

      expect(readCalls).toEqual([]);
      expect(commands).toEqual([]);
      expect(upserts).toEqual([]);
    }),
  );

  it.effect("repairs shell metadata without tracking a native history cursor", () =>
    Effect.gen(function* () {
      const nativeThreadId = "native-stale-shell";
      const commands: OrchestrationCommand[] = [];
      const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
      const oldBinding = {
        ...bindingFor(nativeThreadId),
        runtimePayload: {
          cwd: "/tmp/codex-project",
          modelSelection: { instanceId, model: DEFAULT_MODEL },
          preserveProviderSettingsOnResume: true,
          // Obsolete fields from the previous importer are harmless payload
          // baggage; the reconciler must not use them as sync state.
          nativeUpdatedAt: "2026-09-14T00:00:05.000Z",
          nativeHistorySyncVersion: "app-server-canonical-v12-history-before-diff",
        },
      };
      yield* runSync(
        catalogOnly(
          [
            listedThread({
              nativeThreadId,
              archived: true,
              title: "Native title",
              updatedAt: "2026-09-14T00:00:06.000Z",
            }),
          ],
          [],
        ),
        emptyReadModel({
          id: ThreadId.make(`codex:${nativeThreadId}`),
          title: "Old title",
        }),
        [oldBinding],
        commands,
        upserts,
      );

      expect(commands.map((command) => command.type)).toEqual([
        "thread.archive",
        "thread.meta.update",
      ]);
      expect(upserts).toEqual([]);
    }),
  );

  it.effect("does not start a native session that is already live", () =>
    Effect.gen(function* () {
      const nativeThreadId = "native-live";
      const threadId = ThreadId.make(`codex:${nativeThreadId}`);
      const starts: ProviderSessionStartInput[] = [];
      const liveSession = {
        provider,
        providerInstanceId: instanceId,
        threadId,
        status: "running",
        runtimeMode: "full-access",
        cwd: "/tmp/codex-project",
        resumeCursor: { threadId: nativeThreadId },
        createdAt: now,
        updatedAt: now,
      } satisfies ProviderSession;

      yield* runSync(
        catalogOnly([listedThread({ nativeThreadId, active: true })], []),
        emptyReadModel({ id: threadId }),
        [bindingFor(nativeThreadId)],
        [],
        [],
        starts,
        [liveSession],
      );

      expect(starts).toEqual([]);
    }),
  );

  it.effect("settles an inactive shell without importing its transcript", () =>
    Effect.gen(function* () {
      const nativeThreadId = "native-detached";
      const commands: OrchestrationCommand[] = [];
      yield* runSync(
        catalogOnly([listedThread({ nativeThreadId })], []),
        emptyReadModel({
          id: ThreadId.make(`codex:${nativeThreadId}`),
          title: `${nativeThreadId} title`,
        }),
        [bindingFor(nativeThreadId)],
        commands,
      );

      expect(commands).toMatchObject([
        {
          type: "thread.settle",
          threadId: ThreadId.make(`codex:${nativeThreadId}`),
        },
      ]);
      expect(commands.some((command) => command.type === "thread.history.import")).toBe(false);
    }),
  );
});
