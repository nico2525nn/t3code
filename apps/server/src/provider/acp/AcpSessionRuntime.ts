import { Effect, Exit, Queue, Ref, Scope, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  extractModelConfigId,
  mergeToolCallState,
  parseSessionModeState,
  parseSessionUpdateEvent,
  type AcpParsedSessionEvent,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";

export interface AcpSpawnInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
}

export interface AcpSessionRuntimeOptions {
  readonly spawn: AcpSpawnInput;
  readonly cwd: string;
  readonly resumeSessionId?: string;
  readonly clientInfo: {
    readonly name: string;
    readonly version: string;
  };
  readonly authMethodId?: string;
  readonly handlers?: Omit<EffectAcpClient.AcpClientHandlers, "sessionUpdate">;
}

export interface AcpSessionRuntime {
  readonly sessionId: string;
  readonly initializeResult: EffectAcpSchema.InitializeResponse;
  readonly sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse;
  readonly modelConfigId: string | undefined;
  readonly events: Stream.Stream<AcpParsedSessionEvent, never>;
  readonly getModeState: Effect.Effect<AcpSessionModeState | undefined>;
  readonly prompt: (
    payload: Omit<EffectAcpSchema.PromptRequest, "sessionId">,
  ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>;
  readonly cancel: Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly setMode: (
    modeId: string,
  ) => Effect.Effect<EffectAcpSchema.SetSessionModeResponse, EffectAcpErrors.AcpError>;
  readonly setConfigOption: (
    configId: string,
    value: string | boolean,
  ) => Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError>;
  readonly setModel: (model: string) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly request: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<unknown, EffectAcpErrors.AcpError>;
  readonly notify: (
    method: string,
    payload: unknown,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly close: Effect.Effect<void>;
}

export const makeAcpSessionRuntime = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntime,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner
> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.make("sequential");
    const eventQueue = yield* Queue.unbounded<AcpParsedSessionEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallState>());

    const child = yield* spawner
      .spawn(
        ChildProcess.make(options.spawn.command, [...options.spawn.args], {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: { ...process.env, ...options.spawn.env } } : {}),
          shell: process.platform === "win32",
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    const client = yield* EffectAcpClient.fromChildProcess(child, {
      handlers: {
        ...options.handlers,
        sessionUpdate: (notification) =>
          handleSessionUpdate({
            queue: eventQueue,
            modeStateRef,
            toolCallsRef,
            params: notification,
          }),
      },
    }).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const initializeResult = yield* client.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: options.clientInfo,
    });

    yield* client.authenticate({
      methodId: options.authMethodId ?? "cursor_login",
    });

    let sessionId: string;
    let sessionSetupResult:
      | EffectAcpSchema.LoadSessionResponse
      | EffectAcpSchema.NewSessionResponse
      | EffectAcpSchema.ResumeSessionResponse;
    if (options.resumeSessionId) {
      const resumed = yield* client
        .loadSession({
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers: [],
        })
        .pipe(Effect.exit);
      if (Exit.isSuccess(resumed)) {
        sessionId = options.resumeSessionId;
        sessionSetupResult = resumed.value;
      } else {
        const created = yield* client.createSession({
          cwd: options.cwd,
          mcpServers: [],
        });
        sessionId = created.sessionId;
        sessionSetupResult = created;
      }
    } else {
      const created = yield* client.createSession({
        cwd: options.cwd,
        mcpServers: [],
      });
      sessionId = created.sessionId;
      sessionSetupResult = created;
    }

    yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));

    const close = Scope.close(runtimeScope, Exit.void).pipe(Effect.asVoid);

    return {
      sessionId,
      initializeResult,
      sessionSetupResult,
      modelConfigId: extractModelConfigId(sessionSetupResult),
      events: Stream.fromQueue(eventQueue),
      getModeState: Ref.get(modeStateRef),
      prompt: (payload) =>
        client.prompt({
          sessionId,
          ...payload,
        }),
      cancel: client.cancel({ sessionId }),
      setMode: (modeId) =>
        client.setSessionMode({
          sessionId,
          modeId,
        }),
      setConfigOption: (configId, value) =>
        client.setSessionConfigOption(
          typeof value === "boolean"
            ? ({
                sessionId,
                configId,
                type: "boolean",
                value,
              } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
            : ({
                sessionId,
                configId,
                value: String(value),
              } satisfies EffectAcpSchema.SetSessionConfigOptionRequest),
        ),
      setModel: (model) =>
        client
          .setSessionConfigOption({
            sessionId,
            configId: extractModelConfigId(sessionSetupResult) ?? "model",
            value: model,
          })
          .pipe(Effect.asVoid),
      request: client.extRequest,
      notify: client.extNotification,
      close,
    } satisfies AcpSessionRuntime;
  });

const handleSessionUpdate = ({
  queue,
  modeStateRef,
  toolCallsRef,
  params,
}: {
  readonly queue: Queue.Queue<AcpParsedSessionEvent>;
  readonly modeStateRef: Ref.Ref<AcpSessionModeState | undefined>;
  readonly toolCallsRef: Ref.Ref<Map<string, AcpToolCallState>>;
  readonly params: EffectAcpSchema.SessionNotification;
}): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const parsed = parseSessionUpdateEvent(params);
    if (parsed.modeId) {
      yield* Ref.update(modeStateRef, (current) =>
        current === undefined ? current : updateModeState(current, parsed.modeId!),
      );
    }
    for (const event of parsed.events) {
      if (event._tag === "ToolCallUpdated") {
        const merged = yield* Ref.modify(toolCallsRef, (current) => {
          const previous = current.get(event.toolCall.toolCallId);
          const nextToolCall = mergeToolCallState(previous, event.toolCall);
          const next = new Map(current);
          if (nextToolCall.status === "completed" || nextToolCall.status === "failed") {
            next.delete(nextToolCall.toolCallId);
          } else {
            next.set(nextToolCall.toolCallId, nextToolCall);
          }
          return [nextToolCall, next] as const;
        });
        yield* Queue.offer(queue, {
          _tag: "ToolCallUpdated",
          toolCall: merged,
          rawPayload: event.rawPayload,
        });
        continue;
      }
      yield* Queue.offer(queue, event);
    }
  }).pipe(Effect.mapError(EffectAcpErrors.normalizeAcpError));

function updateModeState(modeState: AcpSessionModeState, nextModeId: string): AcpSessionModeState {
  const normalized = nextModeId.trim();
  if (!normalized) {
    return modeState;
  }
  return modeState.availableModes.some((mode) => mode.id === normalized)
    ? {
        ...modeState,
        currentModeId: normalized,
      }
    : modeState;
}
