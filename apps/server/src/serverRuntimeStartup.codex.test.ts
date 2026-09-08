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
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
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

    expect(messageIdLookups).toEqual([projectionThreadId]);
    expect(readCalls).toEqual([]);
    expect(commands).toEqual([]);
    expect(upserts).toMatchObject([
      {
        provider: codex,
        providerInstanceId: instanceId,
        resumeCursor: { threadId: nativeThreadId },
        runtimePayload: { preserveProviderSettingsOnResume: true },
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
