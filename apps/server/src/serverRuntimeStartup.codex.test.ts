import { expect, it } from "@effect/vitest";
import {
  DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderSessionStartInput,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import * as CheckpointDiffBlobRepository from "./persistence/Services/CheckpointDiffBlobs.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as ProviderInstanceRegistry from "./provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderService from "./provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "./provider/Services/ProviderSessionDirectory.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import type { ProviderStoredThread } from "./provider/Services/ProviderAdapter.ts";

const codex = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");

const makeStoredThread = (input: {
  readonly nativeThreadId: string;
  readonly active: boolean;
  readonly activeTurnId?: string;
  readonly archived: boolean;
  readonly messages: ReadonlyArray<ProviderStoredThread["messages"][number]>;
  readonly turnDiffs?: ProviderStoredThread["turnDiffs"];
}): ProviderStoredThread => ({
  nativeThreadId: input.nativeThreadId,
  cwd: "/tmp/codex-project",
  title: `${input.nativeThreadId} title`,
  preview: `${input.nativeThreadId} preview`,
  createdAt: "2026-09-01T10:00:00.000Z",
  updatedAt: "2026-09-01T10:05:00.000Z",
  archived: input.archived,
  ephemeral: false,
  subAgent: false,
  active: input.active,
  ...(input.activeTurnId ? { activeTurnId: TurnId.make(input.activeTurnId) } : {}),
  messages: input.messages,
  ...(input.turnDiffs ? { turnDiffs: input.turnDiffs } : {}),
});

const makeQuery = (readModel: OrchestrationReadModel) =>
  ({
    getCommandReadModel: () => Effect.succeed(readModel),
    getThreadMessageIds: () => Effect.succeed([]),
  }) as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];

const makeEngine = (commands: OrchestrationCommand[]) =>
  ({
    dispatch: (command: OrchestrationCommand) =>
      Effect.sync(() => {
        commands.push(command);
        return { sequence: commands.length };
      }),
    latestSequence: Effect.sync(() => commands.length),
  }) as unknown as OrchestrationEngine.OrchestrationEngineService["Service"];

const makeProviderService = (starts: ProviderSessionStartInput[]) =>
  ({
    listSessions: () => Effect.succeed([]),
    startSession: (_threadId: never, input: ProviderSessionStartInput) =>
      Effect.sync(() => {
        starts.push(input);
        return {
          provider: codex,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          createdAt: "2026-09-01T10:00:00.000Z",
          updatedAt: "2026-09-01T10:00:00.000Z",
          resumeCursor: input.resumeCursor,
        };
      }),
  }) as unknown as ProviderService.ProviderService["Service"];

const makeDirectory = (
  upserts: ProviderSessionDirectory.ProviderRuntimeBinding[],
  deletedBindings: string[] = [],
  bindings: ReadonlyArray<ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata> = [],
) =>
  ({
    listBindings: () => Effect.succeed(bindings),
    upsert: (binding: ProviderSessionDirectory.ProviderRuntimeBinding) =>
      Effect.sync(() => {
        upserts.push(binding);
      }),
    deleteBinding: (threadId: string) =>
      Effect.sync(() => {
        deletedBindings.push(threadId);
      }),
  }) as unknown as ProviderSessionDirectory.ProviderSessionDirectory["Service"];

it.effect(
  "projects Codex catalog threads, persists idle bindings, and resumes active threads",
  () =>
    Effect.gen(function* () {
      const idle = makeStoredThread({
        nativeThreadId: "native-idle",
        active: false,
        archived: true,
        messages: [],
      });
      const active = makeStoredThread({
        nativeThreadId: "native-active",
        active: true,
        activeTurnId: "turn-native-active",
        archived: false,
        messages: [
          {
            messageId: "import:codex:native-active:turn-1:user-1",
            role: "user",
            text: "Continue the existing work",
            createdAt: "2026-09-01T10:01:00.000Z",
          },
        ],
      });
      const storedThreads = [idle, active];
      const commands: OrchestrationCommand[] = [];
      const starts: ProviderSessionStartInput[] = [];
      const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
      const readCalls: string[] = [];
      const catalog = {
        listStoredThreads: () => Effect.succeed(storedThreads),
        readStoredThread: (input: { readonly nativeThreadId: string }) =>
          Effect.sync(() => {
            readCalls.push(input.nativeThreadId);
            return storedThreads.find(
              (thread) => thread.nativeThreadId === input.nativeThreadId,
            ) as ProviderStoredThread;
          }),
      };
      const instance = {
        instanceId,
        driverKind: codex,
        enabled: true,
        adapter: { storedThreadCatalog: catalog },
      };
      const readModel = {
        snapshotSequence: 0,
        projects: [],
        threads: [],
        updatedAt: "2026-09-01T10:00:00.000Z",
      } as unknown as OrchestrationReadModel;

      yield* ServerRuntimeStartup.syncCodexAppServerThreads.pipe(
        Effect.provideService(
          ProjectionSnapshotQuery.ProjectionSnapshotQuery,
          makeQuery(readModel),
        ),
        Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          listInstances: Effect.succeed([instance]),
        } as never),
        Effect.provideService(ProviderService.ProviderService, makeProviderService(starts)),
        Effect.provideService(
          ProviderSessionDirectory.ProviderSessionDirectory,
          makeDirectory(upserts),
        ),
        Effect.provideService(OrchestrationEngine.OrchestrationEngineService, makeEngine(commands)),
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              defaultModelSelection: { instanceId, model: DEFAULT_MODEL },
            }),
            NodeServices.layer,
          ),
        ),
      );

      expect(readCalls).toEqual(["native-idle", "native-active"]);
      expect(commands.map((command) => command.type)).toEqual([
        "project.create",
        "thread.create",
        "thread.archive",
        "thread.create",
        "thread.session.set",
        "thread.history.import",
      ]);
      const createdThreads = commands.filter(
        (command): command is Extract<OrchestrationCommand, { type: "thread.create" }> =>
          command.type === "thread.create",
      );
      expect(createdThreads.map((command) => command.threadId)).toEqual([
        "codex:native-idle",
        "codex:native-active",
      ]);
      expect(upserts).toMatchObject([
        {
          provider: codex,
          providerInstanceId: instanceId,
          status: "stopped",
          resumeCursor: { threadId: "native-idle" },
          runtimePayload: { preserveProviderSettingsOnResume: true },
        },
        {
          provider: codex,
          providerInstanceId: instanceId,
          status: "stopped",
          resumeCursor: { threadId: "native-active" },
          runtimePayload: { preserveProviderSettingsOnResume: true },
        },
      ]);
      expect(starts).toHaveLength(1);
      expect(starts[0]).toMatchObject({
        threadId: "codex:native-active",
        provider: codex,
        providerInstanceId: instanceId,
        cwd: "/tmp/codex-project",
        resumeCursor: { threadId: "native-active" },
        preserveProviderSettingsOnResume: true,
        activeTurnId: "turn-native-active",
      });
    }),
);

it.effect("backfills missing Codex checkpoint refs from native turn diffs", () =>
  Effect.gen(function* () {
    const nativeThreadId = "native-provider-diff";
    const projectionThreadId = `codex:${nativeThreadId}`;
    const projectId = "project-provider-diff";
    const turnId = "turn-provider-diff";
    const readyTurnId = "turn-native-ready";
    const storedThread = makeStoredThread({
      nativeThreadId,
      active: false,
      archived: false,
      messages: [],
      turnDiffs: [
        {
          turnId: TurnId.make(readyTurnId),
          completedAt: "2026-09-01T10:03:00.000Z",
          diff: "diff --git a/ready.ts b/ready.ts",
          files: [
            {
              path: "ready.ts",
              kind: "modified",
              additions: 1,
              deletions: 0,
            },
          ],
        },
        {
          turnId: TurnId.make(turnId),
          completedAt: "2026-09-01T10:05:00.000Z",
          diff: "diff --git a/example.ts b/example.ts",
          files: [
            {
              path: "example.ts",
              kind: "modified",
              additions: 1,
              deletions: 0,
            },
          ],
        },
      ],
    });
    const commands: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const blobs: CheckpointDiffBlobRepository.CheckpointDiffBlob[] = [];
    const instance = {
      instanceId,
      driverKind: codex,
      enabled: true,
      adapter: {
        storedThreadCatalog: {
          listStoredThreads: () => Effect.succeed([storedThread]),
          readStoredThread: () => Effect.succeed(storedThread),
        },
      },
    };
    const readModel = {
      snapshotSequence: 0,
      projects: [
        {
          id: projectId,
          title: "provider-diff",
          workspaceRoot: "/tmp/codex-project",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: projectionThreadId,
          projectId,
          title: storedThread.title,
          modelSelection: { instanceId, model: DEFAULT_MODEL },
          runtimeMode: "full-access",
          interactionMode: "default",
          latestTurn: null,
          session: null,
          archivedAt: null,
          deletedAt: null,
          messages: [],
        },
      ],
      updatedAt: "2026-09-01T10:00:00.000Z",
    } as unknown as OrchestrationReadModel;
    const checkpointContext = {
      threadId: projectionThreadId,
      projectId,
      workspaceRoot: "/tmp/codex-project",
      worktreePath: null,
      checkpoints: [
        {
          turnId: TurnId.make("legacy-ready-turn"),
          checkpointTurnCount: 1,
          checkpointRef: "git:ready-checkpoint",
          status: "ready",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-09-01T10:03:00.000Z",
        },
        {
          turnId: TurnId.make(turnId),
          checkpointTurnCount: 2,
          checkpointRef: "provider-diff:old-placeholder",
          status: "missing",
          files: [],
          assistantMessageId: null,
          completedAt: "2026-09-01T10:04:00.000Z",
        },
      ],
    } as unknown as ProjectionSnapshotQuery.ProjectionThreadCheckpointContext;
    const binding: ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata = {
      threadId: ThreadId.make(projectionThreadId),
      provider: codex,
      providerInstanceId: instanceId,
      status: "stopped",
      resumeCursor: { threadId: nativeThreadId },
      runtimePayload: {},
      lastSeenAt: "2026-09-01T10:00:00.000Z",
    };

    yield* ServerRuntimeStartup.syncCodexAppServerThreads.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...makeQuery(readModel),
        getThreadCheckpointContext: () => Effect.succeed(Option.some(checkpointContext)),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        listInstances: Effect.succeed([instance]),
      } as never),
      Effect.provideService(ProviderService.ProviderService, makeProviderService([])),
      Effect.provideService(
        ProviderSessionDirectory.ProviderSessionDirectory,
        makeDirectory(upserts, [], [binding]),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, makeEngine(commands)),
      Effect.provideService(CheckpointDiffBlobRepository.CheckpointDiffBlobRepository, {
        upsert: (row) =>
          Effect.sync(() => {
            blobs.push(row);
          }),
        get: () => Effect.succeed(Option.none()),
        listByThreadId: () => Effect.succeed(blobs),
        deleteAfterTurnCount: () => Effect.void,
      }),
      Effect.provideService(CheckpointStore.CheckpointStore, {
        isGitRepository: () => Effect.succeed(true),
      } as never),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            defaultModelSelection: { instanceId, model: DEFAULT_MODEL },
          }),
          NodeServices.layer,
        ),
      ),
    );

    expect(blobs).toEqual([
      {
        threadId: projectionThreadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: "diff --git a/ready.ts b/ready.ts",
        createdAt: "2026-09-01T10:03:00.000Z",
        status: "final",
      },
      {
        threadId: projectionThreadId,
        fromTurnCount: 1,
        toTurnCount: 2,
        diff: "diff --git a/example.ts b/example.ts",
        createdAt: "2026-09-01T10:05:00.000Z",
        status: "final",
      },
    ]);
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "thread.turn.diff.complete",
        threadId: projectionThreadId,
        turnId,
        checkpointTurnCount: 2,
        status: "ready",
        checkpointRef: `provider-diff:${projectionThreadId}:${turnId}`,
      }),
    );
  }),
);

it.effect("does not re-import history hidden by the lightweight command read model", () =>
  Effect.gen(function* () {
    const nativeThreadId = "native-existing";
    const projectionThreadId = `codex:${nativeThreadId}`;
    const persistedMessageId = `import:codex:${nativeThreadId}:turn-1:user-1`;
    const messageIdLookups: string[] = [];
    const readCalls: string[] = [];
    const commands: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const catalog = {
      listStoredThreads: () =>
        Effect.succeed([
          makeStoredThread({
            nativeThreadId,
            active: false,
            archived: false,
            messages: [],
          }),
        ]),
      readStoredThread: (input: { readonly nativeThreadId: string }) =>
        Effect.sync(() => {
          readCalls.push(input.nativeThreadId);
          throw new Error("existing projection history should avoid a native history read");
        }),
    };
    const instance = {
      instanceId,
      driverKind: codex,
      enabled: true,
      adapter: { storedThreadCatalog: catalog },
    };
    const readModel = {
      snapshotSequence: 0,
      projects: [
        {
          id: "project-existing",
          title: "codex-project",
          workspaceRoot: "/tmp/codex-project",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: projectionThreadId,
          projectId: "project-existing",
          title: `${nativeThreadId} title`,
          modelSelection: { instanceId, model: DEFAULT_MODEL },
          runtimeMode: "worktree",
          interactionMode: "default",
          latestTurn: null,
          session: null,
          archivedAt: null,
          deletedAt: null,
          messages: [],
        },
      ],
      updatedAt: "2026-09-01T10:00:00.000Z",
    } as unknown as OrchestrationReadModel;
    const binding: ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata = {
      threadId: ThreadId.make(projectionThreadId),
      provider: codex,
      providerInstanceId: instanceId,
      status: "stopped",
      resumeCursor: { threadId: nativeThreadId },
      runtimePayload: {
        nativeUpdatedAt: "2026-09-01T10:05:00.000Z",
        nativeHistorySyncVersion: "paginated-v8-native-item-repair",
        preserveProviderSettingsOnResume: true,
      },
      lastSeenAt: "2026-09-01T10:00:00.000Z",
    };

    yield* ServerRuntimeStartup.syncCodexAppServerThreads.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...makeQuery(readModel),
        getThreadMessageIds: (threadId: string) =>
          Effect.sync(() => {
            messageIdLookups.push(threadId);
            return [persistedMessageId];
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        listInstances: Effect.succeed([instance]),
      } as never),
      Effect.provideService(ProviderService.ProviderService, makeProviderService([])),
      Effect.provideService(
        ProviderSessionDirectory.ProviderSessionDirectory,
        makeDirectory(upserts, [], [binding]),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, makeEngine(commands)),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            defaultModelSelection: { instanceId, model: DEFAULT_MODEL },
          }),
          NodeServices.layer,
        ),
      ),
    );

    expect(messageIdLookups).toEqual([projectionThreadId]);
    expect(readCalls).toEqual([]);
    expect(commands).toEqual([]);
    expect(upserts).toMatchObject([
      {
        threadId: projectionThreadId,
        runtimePayload: {
          nativeHistorySyncVersion: "paginated-v8-native-item-repair",
          nativeHistorySyncSequence: 0,
        },
      },
    ]);
  }),
);

it.effect("does not re-import a Codex history copy of a live T3 message", () =>
  Effect.gen(function* () {
    const nativeThreadId = "native-live-message";
    const projectionThreadId = `codex:${nativeThreadId}`;
    const directMessageId = "user-live-1";
    const readCalls: string[] = [];
    const messageSummaryCalls: string[] = [];
    const commands: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const storedThread = makeStoredThread({
      nativeThreadId,
      active: false,
      archived: false,
      messages: [
        {
          messageId: `import:codex:${nativeThreadId}:turn-1:user-1`,
          role: "user",
          text: "same prompt",
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-09-01T10:01:00.000Z",
        },
      ],
    });
    const instance = {
      instanceId,
      driverKind: codex,
      enabled: true,
      adapter: {
        storedThreadCatalog: {
          listStoredThreads: () => Effect.succeed([storedThread]),
          readStoredThread: (input: { readonly nativeThreadId: string }) =>
            Effect.sync(() => {
              readCalls.push(input.nativeThreadId);
              return storedThread;
            }),
        },
      },
    };
    const readModel = {
      snapshotSequence: 0,
      projects: [
        {
          id: "project-live-message",
          title: "codex-project",
          workspaceRoot: "/tmp/codex-project",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: projectionThreadId,
          projectId: "project-live-message",
          title: storedThread.title,
          modelSelection: { instanceId, model: DEFAULT_MODEL },
          runtimeMode: "full-access",
          interactionMode: "default",
          latestTurn: null,
          session: null,
          archivedAt: null,
          deletedAt: null,
          messages: [],
        },
      ],
      updatedAt: "2026-09-01T10:00:00.000Z",
    } as unknown as OrchestrationReadModel;
    const binding: ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata = {
      threadId: ThreadId.make(projectionThreadId),
      provider: codex,
      providerInstanceId: instanceId,
      status: "stopped",
      resumeCursor: { threadId: nativeThreadId },
      runtimePayload: { nativeUpdatedAt: "2026-09-01T10:00:00.000Z" },
      lastSeenAt: "2026-09-01T10:00:00.000Z",
    };

    yield* ServerRuntimeStartup.syncCodexAppServerThreads.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...makeQuery(readModel),
        getThreadMessageIds: () => Effect.succeed([directMessageId]),
        getThreadMessageSummaries: (threadId: string) =>
          Effect.sync(() => {
            messageSummaryCalls.push(threadId);
            return [
              {
                id: directMessageId,
                role: "user" as const,
                text: "same prompt",
                turnId: "turn-1",
                createdAt: "2026-09-01T10:01:00.200Z",
              },
            ];
          }),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        listInstances: Effect.succeed([instance]),
      } as never),
      Effect.provideService(ProviderService.ProviderService, makeProviderService([])),
      Effect.provideService(
        ProviderSessionDirectory.ProviderSessionDirectory,
        makeDirectory(upserts, [], [binding]),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, makeEngine(commands)),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            defaultModelSelection: { instanceId, model: DEFAULT_MODEL },
          }),
          NodeServices.layer,
        ),
      ),
    );

    expect(readCalls).toEqual([nativeThreadId]);
    expect(messageSummaryCalls).toEqual([projectionThreadId]);
    expect(commands).toEqual([]);
  }),
);

it.effect("re-hydrates an existing Codex projection after the history bridge changes", () =>
  Effect.gen(function* () {
    const nativeThreadId = "native-history-migration";
    const projectionThreadId = `codex:${nativeThreadId}`;
    const commands: OrchestrationCommand[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const readCalls: string[] = [];
    const storedThread = makeStoredThread({
      nativeThreadId,
      active: false,
      archived: false,
      messages: [
        {
          messageId: `import:codex:${nativeThreadId}:turn-1:user-1`,
          role: "user",
          text: "recover the complete native history",
          createdAt: "2026-09-01T10:01:00.000Z",
        },
      ],
    });
    const instance = {
      instanceId,
      driverKind: codex,
      enabled: true,
      adapter: {
        storedThreadCatalog: {
          listStoredThreads: () =>
            Effect.succeed([
              makeStoredThread({
                nativeThreadId,
                active: false,
                archived: false,
                messages: [],
              }),
            ]),
          readStoredThread: (input: { readonly nativeThreadId: string }) =>
            Effect.sync(() => {
              readCalls.push(input.nativeThreadId);
              return storedThread;
            }),
        },
      },
    };
    const readModel = {
      snapshotSequence: 0,
      projects: [
        {
          id: "project-history-migration",
          title: "codex-project",
          workspaceRoot: "/tmp/codex-project",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: projectionThreadId,
          projectId: "project-history-migration",
          title: storedThread.title,
          modelSelection: { instanceId, model: DEFAULT_MODEL },
          runtimeMode: "full-access",
          interactionMode: "default",
          latestTurn: null,
          session: null,
          archivedAt: null,
          deletedAt: null,
          messages: [],
        },
      ],
      updatedAt: "2026-09-01T10:00:00.000Z",
    } as unknown as OrchestrationReadModel;
    const binding: ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata = {
      threadId: ThreadId.make(projectionThreadId),
      provider: codex,
      providerInstanceId: instanceId,
      status: "stopped",
      resumeCursor: { threadId: nativeThreadId },
      runtimePayload: {
        nativeUpdatedAt: storedThread.updatedAt,
        preserveProviderSettingsOnResume: true,
      },
      lastSeenAt: "2026-09-01T10:00:00.000Z",
    };

    yield* ServerRuntimeStartup.syncCodexAppServerThreads.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, makeQuery(readModel)),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        listInstances: Effect.succeed([instance]),
      } as never),
      Effect.provideService(ProviderService.ProviderService, makeProviderService([])),
      Effect.provideService(
        ProviderSessionDirectory.ProviderSessionDirectory,
        makeDirectory(upserts, [], [binding]),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, makeEngine(commands)),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            defaultModelSelection: { instanceId, model: DEFAULT_MODEL },
          }),
          NodeServices.layer,
        ),
      ),
    );

    expect(readCalls).toEqual([nativeThreadId]);
    expect(commands).toMatchObject([
      {
        type: "thread.history.import",
        threadId: projectionThreadId,
        reconcile: true,
        messages: storedThread.messages,
      },
    ]);
    expect(upserts).toMatchObject([
      {
        threadId: projectionThreadId,
        runtimePayload: {
          nativeHistorySyncVersion: "paginated-v8-native-item-repair",
        },
      },
    ]);
  }),
);

it.effect("moves a legacy Codex binding to the native-id projection thread", () =>
  Effect.gen(function* () {
    const nativeThreadId = "native-cpp-fabricmc";
    const legacyThreadId = "a66ee57d-4176-4e13-938d-305843d43f82";
    const canonicalThreadId = `codex:${nativeThreadId}`;
    const commands: OrchestrationCommand[] = [];
    const starts: ProviderSessionStartInput[] = [];
    const upserts: ProviderSessionDirectory.ProviderRuntimeBinding[] = [];
    const deletedBindings: string[] = [];
    const readCalls: string[] = [];
    const storedThread = makeStoredThread({
      nativeThreadId,
      active: true,
      archived: false,
      messages: [
        {
          messageId: `import:codex:${nativeThreadId}:turn-1:user-1`,
          role: "user",
          text: "Continue the canonical Codex session",
          createdAt: "2026-09-01T10:01:00.000Z",
        },
      ],
    });
    const catalog = {
      listStoredThreads: () =>
        Effect.succeed([
          makeStoredThread({
            nativeThreadId,
            active: true,
            archived: false,
            messages: [],
          }),
        ]),
      readStoredThread: (input: { readonly nativeThreadId: string }) =>
        Effect.sync(() => {
          readCalls.push(input.nativeThreadId);
          return storedThread;
        }),
    };
    const instance = {
      instanceId,
      driverKind: codex,
      enabled: true,
      adapter: { storedThreadCatalog: catalog },
    };
    const oldBinding: ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata = {
      threadId: ThreadId.make(legacyThreadId),
      provider: codex,
      providerInstanceId: instanceId,
      status: "stopped",
      resumeCursor: { threadId: nativeThreadId },
      runtimePayload: { preserveProviderSettingsOnResume: true },
      lastSeenAt: "2026-09-01T10:00:00.000Z",
    };
    const readModel = {
      snapshotSequence: 0,
      projects: [
        {
          id: "project-cpp-fabricmc",
          title: "cpp-fabricmc",
          workspaceRoot: "/tmp/codex-project",
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: legacyThreadId,
          projectId: "project-cpp-fabricmc",
          title: "cpp-fabricmc 7th",
          modelSelection: { instanceId, model: DEFAULT_MODEL },
          runtimeMode: "full-access",
          interactionMode: "default",
          latestTurn: null,
          session: null,
          archivedAt: null,
          deletedAt: null,
          messages: [],
        },
      ],
      updatedAt: "2026-09-01T10:00:00.000Z",
    } as unknown as OrchestrationReadModel;

    yield* ServerRuntimeStartup.syncCodexAppServerThreads.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
        ...makeQuery(readModel),
      } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        listInstances: Effect.succeed([instance]),
      } as never),
      Effect.provideService(ProviderService.ProviderService, makeProviderService(starts)),
      Effect.provideService(
        ProviderSessionDirectory.ProviderSessionDirectory,
        makeDirectory(upserts, deletedBindings, [oldBinding]),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, makeEngine(commands)),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            defaultModelSelection: { instanceId, model: DEFAULT_MODEL },
          }),
          NodeServices.layer,
        ),
      ),
    );

    expect(readCalls).toEqual([nativeThreadId]);
    expect(commands.map((command) => command.type)).toEqual([
      "thread.create",
      "thread.history.import",
      "thread.archive",
    ]);
    expect(upserts).toMatchObject([
      {
        threadId: canonicalThreadId,
        provider: codex,
        providerInstanceId: instanceId,
        resumeCursor: { threadId: nativeThreadId },
      },
    ]);
    expect(deletedBindings).toEqual([legacyThreadId]);
    expect(starts).toMatchObject([{ threadId: canonicalThreadId }]);
  }),
);

it.effect("clears an orphaned Codex session when the native thread is idle", () =>
  Effect.gen(function* () {
    const nativeThreadId = "native-idle-session";
    const projectionThreadId = `codex:${nativeThreadId}`;
    const commands: OrchestrationCommand[] = [];
    const storedThread = makeStoredThread({
      nativeThreadId,
      active: false,
      archived: false,
      messages: [],
    });
    const instance = {
      instanceId,
      driverKind: codex,
      enabled: true,
      adapter: {
        storedThreadCatalog: {
          listStoredThreads: () => Effect.succeed([storedThread]),
          readStoredThread: () => Effect.succeed(storedThread),
        },
      },
    };
    const binding: ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata = {
      threadId: ThreadId.make(projectionThreadId),
      provider: codex,
      providerInstanceId: instanceId,
      status: "stopped",
      resumeCursor: { threadId: nativeThreadId },
      runtimePayload: {
        nativeUpdatedAt: storedThread.updatedAt,
        nativeHistorySyncVersion: "paginated-v8-native-item-repair",
        preserveProviderSettingsOnResume: true,
      },
      lastSeenAt: storedThread.updatedAt,
    };
    const readModel = {
      snapshotSequence: 0,
      projects: [
        {
          id: "project-idle-session",
          title: "idle-session",
          workspaceRoot: storedThread.cwd,
          deletedAt: null,
        },
      ],
      threads: [
        {
          id: projectionThreadId,
          projectId: "project-idle-session",
          title: storedThread.title,
          modelSelection: { instanceId, model: DEFAULT_MODEL },
          runtimeMode: "full-access",
          interactionMode: "default",
          latestTurn: null,
          session: {
            threadId: projectionThreadId,
            status: "stopped",
            providerName: "codex",
            providerInstanceId: instanceId,
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Provider session did not survive a server restart.",
            updatedAt: storedThread.updatedAt,
          },
          archivedAt: null,
          deletedAt: null,
          messages: [],
        },
      ],
      updatedAt: storedThread.updatedAt,
    } as unknown as OrchestrationReadModel;

    yield* ServerRuntimeStartup.syncCodexAppServerThreads.pipe(
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, makeQuery(readModel)),
      Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        listInstances: Effect.succeed([instance]),
      } as never),
      Effect.provideService(ProviderService.ProviderService, makeProviderService([])),
      Effect.provideService(
        ProviderSessionDirectory.ProviderSessionDirectory,
        makeDirectory([], [], [binding]),
      ),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, makeEngine(commands)),
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({
            defaultModelSelection: { instanceId, model: DEFAULT_MODEL },
          }),
          NodeServices.layer,
        ),
      ),
    );

    expect(commands).toContainEqual(
      expect.objectContaining({
        type: "thread.session.set",
        threadId: projectionThreadId,
        session: expect.objectContaining({
          status: "stopped",
          activeTurnId: null,
          lastError: null,
        }),
      }),
    );
  }),
);
