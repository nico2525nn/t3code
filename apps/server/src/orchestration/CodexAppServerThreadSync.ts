import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProviderDriverKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ServerSettings as ServerSettingsValue,
  type ModelSelection,
  type RuntimeMode,
} from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Equal from "effect/Equal";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import * as ProviderInstanceRegistry from "../provider/Services/ProviderInstanceRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";

interface ProjectSyncState {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

/** The reconciler only needs shell settings; Codex owns the transcript. */
interface ThreadSyncState {
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly archivedAt: string | null;
  readonly settledOverride: "active" | "settled" | null;
}

const PROVIDER = ProviderDriverKind.make("codex");
/**
 * Codex owns the transcript. T3 only reconciles the shell/session bridge; the
 * transcript is read through from App Server when a client requests a thread
 * snapshot. A catalog pass never reads or copies history.
 */
const THREAD_SYNC_INTERVAL = "5 seconds" as const;

export const CODEX_APP_SERVER_THREAD_SYNC_INTERVAL = THREAD_SYNC_INTERVAL;

const canonicalThreadIdFor = (nativeThreadId: string): ThreadId =>
  ThreadId.make(`codex:${nativeThreadId}`);

function readRuntimePayload(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNativeThreadId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const threadId = (value as Record<string, unknown>).threadId;
  return typeof threadId === "string" && threadId.trim() ? threadId.trim() : undefined;
}

function commandId(nativeThreadId: string, kind: string, value: unknown): CommandId {
  const encoded = JSON.stringify(value) ?? "";
  const bytes = new TextEncoder().encode(`${nativeThreadId}\u0000${kind}\u0000${encoded}`);
  let hash = 2166136261;
  for (const byte of bytes) hash = Math.imul(hash ^ byte, 16777619);
  return CommandId.make(`server:codex-history:${(hash >>> 0).toString(16)}`);
}

const workspaceKey = normalizeProjectPathForComparison;

function chooseModel(
  settings: ServerSettingsValue,
  instanceId: ProviderInstanceId,
): ModelSelection {
  return settings.defaultModelSelection?.instanceId === instanceId
    ? settings.defaultModelSelection
    : { instanceId, model: DEFAULT_MODEL };
}

export const syncCodexAppServerThreads = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const providerService = yield* ProviderService.ProviderService;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const query = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const readModel = yield* query.getCommandReadModel();
  const serverSettings = yield* settings.getSettings;
  const liveThreadIds = new Set(
    (yield* providerService.listSessions()).map((session) => String(session.threadId)),
  );
  const threads = new Map<string, ThreadSyncState>(
    readModel.threads
      .filter((thread) => thread.deletedAt === null)
      .map((thread) => [
        String(thread.id),
        {
          title: thread.title,
          modelSelection: thread.modelSelection,
          runtimeMode: thread.runtimeMode,
          archivedAt: thread.archivedAt,
          settledOverride: thread.settledOverride,
        },
      ]),
  );
  const deletedThreadIds = new Set(
    readModel.threads.filter((thread) => thread.deletedAt !== null).map((thread) => thread.id),
  );
  const projects = new Map<string, ProjectSyncState>(
    readModel.projects
      .filter((project) => project.deletedAt === null)
      .map((project) => [
        workspaceKey(project.workspaceRoot),
        {
          id: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
        },
      ]),
  );
  const bindings = new Map<string, ProviderSessionDirectory.ProviderRuntimeBindingWithMetadata>();
  const providerBindings = yield* directory
    .listBindings()
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("could not list Codex provider bindings", { cause }).pipe(
              Effect.as([]),
            ),
      ),
    );
  for (const binding of providerBindings) {
    if (binding.provider !== PROVIDER) continue;
    const nativeThreadId = readNativeThreadId(binding.resumeCursor);
    if (nativeThreadId !== undefined) bindings.set(nativeThreadId, binding);
  }

  const newId = (purpose: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((value) => CommandId.make(`${purpose}:${value}`)));
  const now = Effect.map(DateTime.now, DateTime.formatIso);

  const ensureProject = (cwd: string) =>
    Effect.gen(function* () {
      const key = workspaceKey(cwd);
      const existing = projects.get(key);
      if (existing) return existing;
      const project = {
        id: ProjectId.make(yield* crypto.randomUUIDv4),
        title: path.basename(cwd) || "Codex",
        workspaceRoot: cwd,
      };
      yield* engine.dispatch({
        type: "project.create",
        commandId: yield* newId("server:codex-project"),
        projectId: project.id,
        title: project.title,
        workspaceRoot: cwd,
        createdAt: yield* now,
      });
      projects.set(key, project);
      return project;
    });

  const claimed = new Set<string>();
  for (const instance of yield* instances.listInstances) {
    if (instance.driverKind !== PROVIDER || !instance.enabled) continue;
    const catalog = instance.adapter.storedThreadCatalog;
    if (!catalog) continue;

    const listedThreads = yield* catalog.listStoredThreads().pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("could not list Codex App Server threads", {
              providerInstanceId: instance.instanceId,
              cause,
            }).pipe(Effect.as([])),
      ),
    );

    for (const listed of listedThreads) {
      const nativeThreadId = listed.nativeThreadId.trim();
      if (!nativeThreadId || listed.ephemeral || listed.subAgent || claimed.has(nativeThreadId)) {
        continue;
      }
      const persisted = bindings.get(nativeThreadId);
      if (
        persisted?.providerInstanceId !== undefined &&
        persisted.providerInstanceId !== instance.instanceId
      ) {
        continue;
      }
      const persistedThreadId = persisted?.threadId;
      if (
        deletedThreadIds.has(canonicalThreadIdFor(nativeThreadId)) ||
        (persistedThreadId !== undefined && deletedThreadIds.has(persistedThreadId))
      ) {
        continue;
      }
      claimed.add(nativeThreadId);

      yield* Effect.gen(function* () {
        const boundThread = persisted ? threads.get(String(persisted.threadId)) : undefined;
        let threadId = boundThread ? persisted!.threadId : canonicalThreadIdFor(nativeThreadId);
        let thread = threads.get(String(threadId));

        const payload = readRuntimePayload(persisted?.runtimePayload);
        let archivedAt = thread?.archivedAt ?? null;
        let title = thread?.title ?? listed.title;
        if (thread === undefined) {
          const project = yield* ensureProject(listed.cwd);
          yield* engine.dispatch({
            type: "thread.create",
            commandId: yield* newId("server:codex-thread"),
            threadId,
            projectId: project.id,
            title: listed.title,
            modelSelection: chooseModel(serverSettings, instance.instanceId),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: listed.createdAt,
          });
          thread = {
            title: listed.title,
            modelSelection: chooseModel(serverSettings, instance.instanceId),
            runtimeMode: DEFAULT_RUNTIME_MODE,
            archivedAt: null,
            settledOverride: null,
          };
          threads.set(String(threadId), thread);
          archivedAt = null;
          title = listed.title;
        }

        // App Server is authoritative for whether a native turn is active.
        // Correct a stale T3 shell without importing the transcript or
        // manufacturing one event per historical item.
        if (
          !listed.archived &&
          archivedAt === null &&
          thread.settledOverride === null &&
          !listed.active &&
          !liveThreadIds.has(String(threadId))
        ) {
          yield* engine.dispatch({
            type: "thread.settle",
            commandId: commandId(nativeThreadId, "settle", listed.updatedAt),
            threadId,
          });
        }

        const shouldArchive = listed.archived && archivedAt === null;
        const shouldUnarchive = !listed.archived && archivedAt !== null;
        if (shouldArchive || shouldUnarchive) {
          yield* engine.dispatch({
            type: shouldArchive ? "thread.archive" : "thread.unarchive",
            commandId: yield* newId("server:codex-archive"),
            threadId,
          });
          archivedAt = shouldArchive ? listed.updatedAt : null;
        }

        if (title !== listed.title) {
          yield* engine.dispatch({
            type: "thread.meta.update",
            commandId: yield* newId("server:codex-title"),
            threadId,
            title: listed.title,
          });
          title = listed.title;
        }

        const nextRuntimePayload = {
          ...payload,
          cwd: listed.cwd,
          modelSelection: thread.modelSelection,
          preserveProviderSettingsOnResume: true,
        };
        if (
          persisted === undefined ||
          persisted.threadId !== threadId ||
          persisted.providerInstanceId !== instance.instanceId ||
          payload.cwd !== listed.cwd ||
          payload.preserveProviderSettingsOnResume !== true ||
          !Equal.equals(payload.modelSelection, thread.modelSelection)
        ) {
          yield* directory.upsert({
            threadId,
            provider: PROVIDER,
            providerInstanceId: instance.instanceId,
            status: persisted?.status ?? "stopped",
            runtimeMode: persisted?.runtimeMode ?? thread.runtimeMode,
            resumeCursor: { threadId: nativeThreadId },
            runtimePayload: nextRuntimePayload,
          });
        }

        if (
          listed.active &&
          !listed.archived &&
          archivedAt === null &&
          !liveThreadIds.has(String(threadId))
        ) {
          yield* providerService
            .startSession(threadId, {
              threadId,
              provider: PROVIDER,
              providerInstanceId: instance.instanceId,
              cwd: listed.cwd,
              title: listed.title,
              modelSelection: thread.modelSelection,
              resumeCursor: { threadId: nativeThreadId },
              runtimeMode: thread.runtimeMode,
              preserveProviderSettingsOnResume: true,
              ...(listed.activeTurnId ? { activeTurnId: listed.activeTurnId } : {}),
            })
            .pipe(Effect.tap(() => Effect.sync(() => liveThreadIds.add(String(threadId)))));
        }
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("could not reconcile one Codex App Server thread", {
                providerInstanceId: instance.instanceId,
                nativeThreadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
  }
});

export const syncCodexAppServerThreadsRecurring = syncCodexAppServerThreads;
