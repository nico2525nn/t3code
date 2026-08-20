/**
 * OpenCode2Runtime — spawned-server lifecycle and thin HTTP/SSE client for
 * the OpenCode 2 (`opencode2`) API.
 *
 * OpenCode 2 (preview) exposes an HTTP API from `opencode2 serve`. Unlike
 * the OpenCode v1 SDK integration, this runtime talks directly to the V2
 * endpoints (`/api/health`, `/api/model`, `/api/session/*`, `/api/event`,
 * `/api/permission/...`) with a tiny fetch-based client — no generated SDK
 * dependency. Two modes:
 *
 *   - **managed** — T3 Code spawns `opencode2 serve --port <free>` and reads
 *     the printed `server listening on <url>` / `server password <token>`
 *     lines from stdout. The child's lifetime is bound to the caller's
 *     `Scope.Scope`.
 *   - **external** — `serverUrl`/`serverPassword` settings point at a
 *     pre-existing server (the `opencode2 serve` or background service the
 *     user already runs). Basic auth (`opencode:<password>`) is used, as the
 *     V2 server requires it even on localhost.
 *
 * @module provider/opencode2Runtime
 */
import * as NodeURL from "node:url";

import type { ChatAttachment } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Filter from "effect/Filter";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as P from "effect/Predicate";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpBody, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import * as NetService from "@t3tools/shared/Net";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { isWindowsCommandNotFound } from "../processRunner.ts";
import { collectStreamAsString } from "./providerSnapshot.ts";

const OPENCODE2_SERVER_READY_PREFIX = "server listening on ";
const OPENCODE2_SERVER_PASSWORD_PREFIX = "server password ";
const DEFAULT_OPENCODE2_SERVER_TIMEOUT_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_HOSTNAME = "127.0.0.1";
const AUTH_USERNAME = "opencode";
const JSON_DECODE_EXIT = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

export interface OpenCode2ServerProcess {
  readonly url: string;
  readonly password: string;
  readonly exitCode: Effect.Effect<number, never>;
}

export interface OpenCode2ServerConnection {
  readonly url: string;
  readonly password: string;
  readonly external: boolean;
  readonly exitCode: Effect.Effect<number, never> | null;
}

export interface OpenCode2CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export function parseOpenCode2ModelSlug(
  slug: string | null | undefined,
): { readonly providerID: string; readonly modelID: string } | null {
  if (typeof slug !== "string") {
    return null;
  }
  const trimmed = slug.trim();
  const separator = trimmed.indexOf("/");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }
  return {
    providerID: trimmed.slice(0, separator),
    modelID: trimmed.slice(separator + 1),
  };
}

export function toOpenCode2FileParts(input: {
  readonly attachments: ReadonlyArray<ChatAttachment> | undefined;
  readonly resolveAttachmentPath: (attachment: ChatAttachment) => string | null;
}): ReadonlyArray<{ readonly uri: string; readonly name?: string }> {
  const parts: Array<{ uri: string; name?: string }> = [];
  for (const attachment of input.attachments ?? []) {
    const attachmentPath = input.resolveAttachmentPath(attachment);
    if (!attachmentPath) {
      continue;
    }
    parts.push({
      uri: NodeURL.pathToFileURL(attachmentPath).href,
      ...(attachment.name ? { name: attachment.name } : {}),
    });
  }
  return parts;
}

const OPENCODE2_RUNTIME_ERROR_TAG = "OpenCode2RuntimeError";
export class OpenCode2RuntimeError extends Data.TaggedError(OPENCODE2_RUNTIME_ERROR_TAG)<{
  readonly operation: string;
  readonly cause?: unknown;
  readonly detail: string;
}> {
  static readonly is = (u: unknown): u is OpenCode2RuntimeError =>
    P.isTagged(u, OPENCODE2_RUNTIME_ERROR_TAG);
}

export function openCode2RuntimeErrorDetail(cause: unknown): string {
  if (OpenCode2RuntimeError.is(cause)) return cause.detail;
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message.trim();
  if (cause && typeof cause === "object") {
    // fetch throws { cause: { code: "ECONNREFUSED" | "ENOTFOUND" | ... } } shapes
    const anyCause = cause as Record<string, unknown>;
    const inner = anyCause.cause as Record<string, unknown> | undefined;
    if (inner && typeof inner.code === "string") {
      return `${anyCause.message ?? "fetch failed"} (${inner.code})`;
    }
    const status = (anyCause as { response?: { status?: number } }).response?.status;
    const body = anyCause.data ?? anyCause.body;
    if (body !== undefined) {
      return `status=${status ?? "?"} body=${typeof body === "string" ? body : JSON.stringify(body)}`;
    }
  }
  return String(cause);
}

export interface OpenCode2RequestInput {
  readonly method: "GET" | "POST" | "DELETE";
  readonly path: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
  readonly timeoutMs?: number;
}

export interface OpenCode2HttpResult {
  readonly status: number;
  readonly json: unknown;
}

export interface OpenCode2HttpClient {
  readonly request: (
    input: OpenCode2RequestInput,
  ) => Effect.Effect<OpenCode2HttpResult, OpenCode2RuntimeError>;
}

export interface OpenCode2SseMessage {
  readonly event?: string;
  readonly data: unknown;
}

// ── Pure helpers (unit-testable without a live server) ──────────────────

/**
 * Decode the stdout emitted by `opencode2 serve --hostname --port`.
 * Returns the advertised base URL and password when present.
 */
export function parseOpenCode2ServeOutput(stdout: string): {
  readonly url?: string;
  readonly password?: string;
} {
  let url: string | undefined;
  let password: string | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith(OPENCODE2_SERVER_READY_PREFIX)) {
      const candidate = line.slice(OPENCODE2_SERVER_READY_PREFIX.length).trim();
      if (candidate.length > 0) {
        url = candidate;
      }
    } else if (line.startsWith(OPENCODE2_SERVER_PASSWORD_PREFIX)) {
      const candidate = line.slice(OPENCODE2_SERVER_PASSWORD_PREFIX.length).trim();
      if (candidate.length > 0) {
        password = candidate;
      }
    }
  }
  return {
    ...(url ? { url } : {}),
    ...(password ? { password } : {}),
  };
}

/**
 * Incrementally split a text buffer into complete SSE frames. Feed it with
 * text chunks; it returns frames and the unconsumed remainder. OpenCode 2
 * emits `data: <json>` frames separated by blank lines (with `: heartbeat`
 * comment frames in between), so we only care about `data:` lines.
 */
export function parseOpenCode2SseBuffer(
  accumulated: string,
  chunk: string,
): { readonly frames: Array<string>; readonly remainder: string } {
  const buffer = accumulated + chunk;
  const frames: Array<string> = [];
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf("\n\n", start);
    if (end === -1) {
      break;
    }
    const frame = buffer.slice(start, end);
    start = end + 2;
    const dataLines: Array<string> = [];
    for (const line of frame.split("\n")) {
      if (line.startsWith("data:")) {
        const payload = line.slice("data:".length).trimStart();
        if (payload.length > 0) {
          dataLines.push(payload);
        }
      }
    }
    if (dataLines.length > 0) {
      frames.push(dataLines.join("\n"));
    }
  }
  return { frames, remainder: buffer.slice(start) };
}

/**
 * Convert an assembled SSE `data:` payload (possibly multi-line JSON) into a
 * parsed message. Returns `undefined` when the payload isn't valid JSON.
 */
export function decodeOpenCode2SseMessage(payload: string): OpenCode2SseMessage | undefined {
  const exit = JSON_DECODE_EXIT(payload);
  if (Exit.isSuccess(exit) && exit.value !== null && typeof exit.value === "object") {
    return { data: exit.value };
  }
  return undefined;
}

export function buildAuthorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`${AUTH_USERNAME}:${password}`, "utf8").toString("base64")}`;
}

export function buildOpenCode2Url(
  baseUrl: string,
  path: string,
  query?: Readonly<Record<string, string | undefined>>,
): string {
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}${path}`);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) {
      url.searchParams.set(key, value);
    }
  }
  return url.href;
}

// ── V2 API response shapes (structural, minimal) ────────────────────────

export interface OpenCode2ModelVariant {
  readonly id: string;
  readonly settings?: Record<string, unknown>;
}

export interface OpenCode2Model {
  readonly id: string;
  readonly modelID: string;
  readonly providerID: string;
  readonly family?: string;
  readonly name?: string;
  readonly compatibility?: Record<string, unknown>;
  readonly capabilities?: {
    readonly tools?: boolean;
    readonly input?: ReadonlyArray<string>;
    readonly output?: ReadonlyArray<string>;
  };
  readonly variants?: ReadonlyArray<OpenCode2ModelVariant>;
  readonly status?: string;
  readonly enabled?: boolean;
}

export interface OpenCode2ProviderSummary {
  readonly id: string;
  readonly integrationID?: string;
  readonly name?: string;
  readonly activation?: string;
}

export interface OpenCode2Agent {
  readonly id: string;
  readonly name?: string;
  readonly description?: string;
  readonly mode?: "subagent" | "primary" | "all";
  readonly hidden?: boolean;
}

export interface OpenCode2SessionInfo {
  readonly id: string;
  readonly title?: string;
  readonly model?: {
    readonly id?: string;
    readonly providerID?: string;
    readonly variant?: string;
  };
  readonly location?: { readonly directory?: string; readonly subpath?: string };
  readonly time?: { readonly created?: number; readonly updated?: number };
}

export interface OpenCode2InboxUser {
  readonly id: string;
  readonly sessionID?: string;
  readonly payload?: { readonly text?: string };
}

export interface OpenCode2MessageUser {
  readonly id: string;
  readonly type: "user";
  readonly text?: string;
  readonly time?: { readonly created?: number };
}

export interface OpenCode2StructuredError {
  readonly message?: string;
  readonly name?: string;
}

export interface OpenCode2MessageAssistant {
  readonly id: string;
  readonly type: "assistant";
  readonly agent?: string;
  readonly model?: {
    readonly id?: string;
    readonly providerID?: string;
    readonly variant?: string;
  };
  readonly time?: { readonly created?: number; readonly completed?: number };
  readonly content?: ReadonlyArray<{
    readonly type: "text" | "reasoning" | "tool";
    readonly text?: string;
    readonly id?: string;
    readonly name?: string;
  }>;
  readonly finish?: string;
  readonly error?: OpenCode2StructuredError;
}

export type OpenCode2Message = OpenCode2MessageUser | OpenCode2MessageAssistant;

export interface OpenCode2ServiceHealth {
  readonly healthy: true;
  readonly version: string;
  readonly pid: number;
}

// ── High-level API client ───────────────────────────────────────────────

export interface OpenCode2ApiClient {
  readonly health: () => Effect.Effect<OpenCode2ServiceHealth, OpenCode2RuntimeError>;
  readonly listModels: () => Effect.Effect<ReadonlyArray<OpenCode2Model>, OpenCode2RuntimeError>;
  readonly defaultModel: () => Effect.Effect<OpenCode2Model | null, OpenCode2RuntimeError>;
  readonly listProviders: () => Effect.Effect<
    ReadonlyArray<OpenCode2ProviderSummary>,
    OpenCode2RuntimeError
  >;
  readonly listAgents: () => Effect.Effect<ReadonlyArray<OpenCode2Agent>, OpenCode2RuntimeError>;
  readonly createSession: (
    directory: string,
    title?: string,
  ) => Effect.Effect<OpenCode2SessionInfo, OpenCode2RuntimeError>;
  readonly getSession: (
    sessionID: string,
  ) => Effect.Effect<OpenCode2SessionInfo | null, OpenCode2RuntimeError>;
  readonly promptSession: (
    sessionID: string,
    text: string,
    files?: ReadonlyArray<{ readonly uri: string; readonly name?: string }>,
    delivery?: "steer" | "queue",
  ) => Effect.Effect<OpenCode2InboxUser, OpenCode2RuntimeError>;
  readonly waitSession: (sessionID: string) => Effect.Effect<void, OpenCode2RuntimeError>;
  readonly interruptSession: (sessionID: string) => Effect.Effect<void, OpenCode2RuntimeError>;
  readonly switchModel: (
    sessionID: string,
    model: { readonly id: string; readonly providerID: string; readonly variant?: string },
  ) => Effect.Effect<void, OpenCode2RuntimeError>;
  readonly listMessages: (
    sessionID: string,
  ) => Effect.Effect<ReadonlyArray<OpenCode2Message>, OpenCode2RuntimeError>;
  readonly replyPermission: (
    sessionID: string,
    requestID: string,
    reply: "once" | "always" | "reject",
  ) => Effect.Effect<void, OpenCode2RuntimeError>;
}

function apiRequest(
  request: OpenCode2HttpClient["request"],
  method: OpenCode2RequestInput["method"],
  path: string,
  body?: unknown,
  query?: Readonly<Record<string, string | undefined>>,
): Effect.Effect<unknown, OpenCode2RuntimeError> {
  return request({
    method,
    path,
    ...(query ? { query } : {}),
    ...(body !== undefined ? { body } : {}),
  }).pipe(
    Effect.flatMap((result) => {
      if (result.status === 204) {
        return Effect.succeed(undefined);
      }
      if (result.status >= 200 && result.status < 300) {
        return Effect.succeed(result.json);
      }
      return Effect.fail(
        new OpenCode2RuntimeError({
          operation: `${method} ${path}`,
          detail: `OpenCode2 API returned status ${result.status} for ${method} ${path}.`,
        }),
      );
    }),
  );
}

function isOpenCode2NotFound(cause: unknown): boolean {
  if (OpenCode2RuntimeError.is(cause)) {
    return /status 404/.test(cause.detail);
  }
  return false;
}

export const makeOpenCode2ApiClient = (input: {
  readonly connection: OpenCode2ServerConnection;
  readonly request: OpenCode2RuntimeShape["request"];
}): OpenCode2ApiClient => {
  // Bind the connection into the transport so API methods only see the
  // per-request input (mirrors the v1 runtime's createOpenCodeSdkClient).
  const request: OpenCode2HttpClient["request"] = (reqInput) =>
    input.request({ ...reqInput, connection: input.connection });
  return {
    health: () =>
      apiRequest(request, "GET", "/api/health").pipe(
        Effect.map((json) => json as OpenCode2ServiceHealth),
      ),
    listModels: () =>
      apiRequest(request, "GET", "/api/model").pipe(
        Effect.map((json) => {
          const data = (json as { readonly data?: ReadonlyArray<OpenCode2Model> }).data;
          return data ?? [];
        }),
      ),
    defaultModel: () =>
      apiRequest(request, "GET", "/api/model/default").pipe(
        Effect.map((json) => (json as { readonly data?: OpenCode2Model | null }).data ?? null),
        Effect.orElseSucceed(() => null),
      ),
    listProviders: () =>
      apiRequest(request, "GET", "/api/provider").pipe(
        Effect.map((json) => {
          const data = (json as { readonly data?: ReadonlyArray<OpenCode2ProviderSummary> }).data;
          return data ?? [];
        }),
      ),
    listAgents: () =>
      apiRequest(request, "GET", "/api/agent").pipe(
        Effect.map((json) => {
          const data = (json as { readonly data?: ReadonlyArray<OpenCode2Agent> }).data;
          return data ?? [];
        }),
      ),
    createSession: (directory, title) =>
      apiRequest(request, "POST", "/api/session", {
        location: { directory },
        ...(title ? { title } : {}),
      }).pipe(Effect.map((json) => (json as { readonly data: OpenCode2SessionInfo }).data)),
    getSession: (sessionID) =>
      apiRequest(request, "GET", `/api/session/${encodeURIComponent(sessionID)}`).pipe(
        Effect.map((json) => (json as { readonly data: OpenCode2SessionInfo }).data),
        Effect.catchIf(
          (cause) => isOpenCode2NotFound(cause),
          () => Effect.succeed(null),
        ),
      ),
    promptSession: (sessionID, text, files, delivery = "steer") =>
      apiRequest(request, "POST", `/api/session/${encodeURIComponent(sessionID)}/prompt`, {
        text,
        ...(files && files.length > 0 ? { files } : {}),
        delivery,
        resume: true,
      }).pipe(Effect.map((json) => (json as { readonly data: OpenCode2InboxUser }).data)),
    waitSession: (sessionID) =>
      apiRequest(request, "POST", `/api/session/${encodeURIComponent(sessionID)}/wait`).pipe(
        Effect.asVoid,
      ),
    interruptSession: (sessionID) =>
      apiRequest(request, "POST", `/api/session/${encodeURIComponent(sessionID)}/interrupt`).pipe(
        Effect.asVoid,
      ),
    switchModel: (sessionID, model) =>
      apiRequest(request, "POST", `/api/session/${encodeURIComponent(sessionID)}/model`, {
        model,
        ...(model.variant ? { variant: model.variant } : {}),
      }).pipe(Effect.asVoid),
    listMessages: (sessionID) =>
      apiRequest(request, "GET", `/api/session/${encodeURIComponent(sessionID)}/message`).pipe(
        Effect.map((json) => {
          const data = (json as { readonly data?: ReadonlyArray<OpenCode2Message> }).data;
          return data ?? [];
        }),
      ),
    replyPermission: (sessionID, requestID, reply) =>
      apiRequest(
        request,
        "POST",
        `/api/session/${encodeURIComponent(sessionID)}/permission/${encodeURIComponent(requestID)}/reply`,
        { reply },
      ).pipe(Effect.asVoid),
  };
};

export interface OpenCode2RuntimeShape {
  /** Run a short-lived `opencode2` CLI command (e.g. `--version`). */
  readonly runOpenCode2Command: (input: {
    readonly binaryPath: string;
    readonly args: ReadonlyArray<string>;
    readonly environment?: NodeJS.ProcessEnv;
  }) => Effect.Effect<OpenCode2CommandResult, OpenCode2RuntimeError>;
  /**
   * Spawn a managed `opencode2 serve` child process whose lifetime is bound
   * to the caller's `Scope.Scope`.
   */
  readonly startOpenCode2ServerProcess: (input: {
    readonly binaryPath: string;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCode2ServerProcess, OpenCode2RuntimeError, Scope.Scope>;
  readonly connectToOpenCode2Server: (input: {
    readonly binaryPath: string;
    readonly serverUrl?: string | null;
    readonly serverPassword?: string | null;
    readonly environment?: NodeJS.ProcessEnv;
    readonly port?: number;
    readonly hostname?: string;
    readonly timeoutMs?: number;
  }) => Effect.Effect<OpenCode2ServerConnection, OpenCode2RuntimeError, Scope.Scope>;
  /** Make a JSON request against a connection with Basic auth. */
  readonly request: (
    input: {
      readonly connection: OpenCode2ServerConnection;
    } & OpenCode2RequestInput,
  ) => Effect.Effect<OpenCode2HttpResult, OpenCode2RuntimeError>;
  /** Open the `/api/event` SSE stream for a connection (aborted on scope close). */
  readonly streamOpenCode2Events: (input: {
    readonly connection: OpenCode2ServerConnection;
  }) => Effect.Effect<
    Stream.Stream<OpenCode2SseMessage, OpenCode2RuntimeError>,
    OpenCode2RuntimeError
  >;
}

const makeOpenCode2Runtime = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const netService = yield* NetService.NetService;
  const hostPlatform = yield* HostProcessPlatform;
  const httpClient = yield* HttpClient.HttpClient;
  const resolveCommand = (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    resolveSpawnCommand(command, args, env ? { env } : {});

  const runOpenCode2Command: OpenCode2RuntimeShape["runOpenCode2Command"] = (input) =>
    Effect.gen(function* () {
      const spawnCommand = yield* resolveCommand(input.binaryPath, input.args, input.environment);
      const child = yield* spawner.spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          shell: spawnCommand.shell,
          ...(input.environment ? { env: input.environment } : { extendEnv: true }),
        }),
      );
      const [stdout, stderr, code] = yield* Effect.all(
        [collectStreamAsString(child.stdout), collectStreamAsString(child.stderr), child.exitCode],
        { concurrency: "unbounded" },
      );
      const exitCode = Number(code);
      if (yield* isWindowsCommandNotFound(exitCode, stderr)) {
        return yield* new OpenCode2RuntimeError({
          operation: "runOpenCode2Command",
          detail: `spawn ${input.binaryPath} ENOENT`,
        });
      }
      return { stdout, stderr, code: exitCode };
    }).pipe(
      Effect.scoped,
      Effect.mapError((cause) =>
        OpenCode2RuntimeError.is(cause)
          ? cause
          : new OpenCode2RuntimeError({
              operation: "runOpenCode2Command",
              detail: `Failed to execute '${input.binaryPath} ${input.args.join(" ")}': ${openCode2RuntimeErrorDetail(cause)}`,
              cause,
            }),
      ),
    );

  const startOpenCode2ServerProcess: OpenCode2RuntimeShape["startOpenCode2ServerProcess"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const runtimeScope = yield* Scope.Scope;
      const hostname = input.hostname ?? DEFAULT_HOSTNAME;
      const port =
        input.port ??
        (yield* netService.findAvailablePort(0).pipe(
          Effect.mapError(
            (cause) =>
              new OpenCode2RuntimeError({
                operation: "startOpenCode2ServerProcess",
                detail: `Failed to find available port: ${openCode2RuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        ));
      const timeoutMs = input.timeoutMs ?? DEFAULT_OPENCODE2_SERVER_TIMEOUT_MS;
      const args = ["serve", `--hostname=${hostname}`, `--port=${port}`];
      const spawnCommand = yield* resolveCommand(input.binaryPath, args, input.environment);

      const child = yield* spawner
        .spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            detached: hostPlatform !== "win32",
            shell: spawnCommand.shell,
            env: input.environment,
            extendEnv: input.environment === undefined,
          }),
        )
        .pipe(
          Effect.provideService(Scope.Scope, runtimeScope),
          Effect.mapError(
            (cause) =>
              new OpenCode2RuntimeError({
                operation: "startOpenCode2ServerProcess",
                detail: `Failed to spawn OpenCode2 server process: ${openCode2RuntimeErrorDetail(cause)}`,
                cause,
              }),
          ),
        );

      const killOpenCode2ProcessGroup = (signal: NodeJS.Signals) =>
        hostPlatform === "win32"
          ? child.kill({ killSignal: signal, forceKillAfter: "1 second" }).pipe(Effect.asVoid)
          : Effect.sync(() => {
              try {
                process.kill(-Number(child.pid), signal);
              } catch {
                // best-effort cleanup
              }
            });
      const terminateChild = killOpenCode2ProcessGroup("SIGTERM").pipe(
        Effect.andThen(Effect.sleep("1 second")),
        Effect.andThen(killOpenCode2ProcessGroup("SIGKILL")),
        Effect.ignore,
      );
      yield* Scope.addFinalizer(runtimeScope, terminateChild);

      const stdoutRef = yield* Ref.make("");
      const stderrRef = yield* Ref.make("");
      const readyDeferred = yield* Deferred.make<
        { readonly url: string; readonly password: string },
        OpenCode2RuntimeError
      >();

      const processChunk = (chunk: string) =>
        Ref.updateAndGet(stdoutRef, (stdout) => `${stdout}${chunk}`).pipe(
          Effect.flatMap((nextStdout) => {
            const parsed = parseOpenCode2ServeOutput(nextStdout);
            if (parsed.url && parsed.password) {
              return Deferred.succeed(readyDeferred, {
                url: parsed.url,
                password: parsed.password,
              }).pipe(Effect.ignore);
            }
            return Effect.void;
          }),
        );

      const stdoutFiber = yield* child.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach(processChunk),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const stderrFiber = yield* child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) => Ref.update(stderrRef, (stderr) => `${stderr}${chunk}`)),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );
      const exitFiber = yield* child.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            const stdout = yield* Ref.get(stdoutRef);
            const stderr = yield* Ref.get(stderrRef);
            yield* Deferred.fail(
              readyDeferred,
              new OpenCode2RuntimeError({
                operation: "startOpenCode2ServerProcess",
                detail: [
                  `OpenCode2 server exited before startup completed (code: ${String(code)}).`,
                  stdout.trim() ? `stdout:\n${stdout.trim()}` : null,
                  stderr.trim() ? `stderr:\n${stderr.trim()}` : null,
                ]
                  .filter(Boolean)
                  .join("\n\n"),
              }),
            ).pipe(Effect.ignore);
          }),
        ),
        Effect.ignore,
        Effect.forkIn(runtimeScope),
      );

      const readyExit = yield* Effect.exit(
        Deferred.await(readyDeferred).pipe(Effect.timeoutOption(timeoutMs)),
      );
      yield* Fiber.interrupt(stdoutFiber).pipe(Effect.ignore);
      yield* Fiber.interrupt(stderrFiber).pipe(Effect.ignore);

      if (Exit.isFailure(readyExit)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        const squashed = Cause.squash(readyExit.cause);
        return yield* ensureOpenCode2RuntimeError(
          "startOpenCode2ServerProcess",
          `Failed while waiting for OpenCode2 server startup: ${openCode2RuntimeErrorDetail(squashed)}`,
          squashed,
        );
      }

      const readyOption = readyExit.value;
      if (Option.isNone(readyOption)) {
        yield* Fiber.interrupt(exitFiber).pipe(Effect.ignore);
        return yield* new OpenCode2RuntimeError({
          operation: "startOpenCode2ServerProcess",
          detail: `Timed out waiting for OpenCode2 server start after ${timeoutMs}ms.`,
        });
      }

      return {
        url: readyOption.value.url,
        password: readyOption.value.password,
        exitCode: child.exitCode.pipe(
          Effect.map(Number),
          Effect.orElseSucceed(() => 0),
        ),
      };
    });

  const connectToOpenCode2Server: OpenCode2RuntimeShape["connectToOpenCode2Server"] = (input) => {
    const serverUrl = input.serverUrl?.trim();
    if (serverUrl) {
      const password = input.serverPassword?.trim() ?? "";
      if (password.length === 0) {
        return Effect.fail(
          new OpenCode2RuntimeError({
            operation: "connectToOpenCode2Server",
            detail:
              "An external OpenCode2 server URL is configured but no server password. Add the password in provider settings.",
          }),
        );
      }
      return Effect.succeed({
        url: serverUrl,
        password,
        external: true,
        exitCode: null,
      });
    }

    return startOpenCode2ServerProcess({
      binaryPath: input.binaryPath,
      ...(input.environment !== undefined ? { environment: input.environment } : {}),
      ...(input.port !== undefined ? { port: input.port } : {}),
      ...(input.hostname !== undefined ? { hostname: input.hostname } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    }).pipe(
      Effect.map((server) => ({
        url: server.url,
        password: server.password,
        external: false,
        exitCode: server.exitCode,
      })),
    );
  };

  const request: OpenCode2RuntimeShape["request"] = (input) =>
    Effect.gen(function* () {
      const url = buildOpenCode2Url(input.connection.url, input.path, input.query);
      let request = HttpClientRequest.make(input.method)(url).pipe(
        HttpClientRequest.setHeader(
          "authorization",
          buildAuthorizationHeader(input.connection.password),
        ),
        HttpClientRequest.setHeader("accept", "application/json"),
      );
      if (input.body !== undefined) {
        request = HttpClientRequest.setBody(HttpBody.jsonUnsafe(input.body))(request);
      }
      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new OpenCode2RuntimeError({
              operation: `${input.method} ${input.path}`,
              detail: `OpenCode2 request failed (${input.connection.url}${input.path}): ${openCode2RuntimeErrorDetail(cause)}`,
              cause,
            }),
        ),
        Effect.timeoutOption(input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      );
      if (Option.isNone(response)) {
        return yield* new OpenCode2RuntimeError({
          operation: `${input.method} ${input.path}`,
          detail: `OpenCode2 request timed out after ${input.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS}ms (${input.connection.url}${input.path}).`,
        });
      }
      const httpResponse = response.value;
      const json = yield* httpResponse.json.pipe(Effect.orElseSucceed(() => undefined));
      return {
        status: httpResponse.status,
        json,
      } satisfies OpenCode2HttpResult;
    }).pipe(Effect.withSpan(`opencode2.${input.method}.${input.path}`));

  const streamOpenCode2Events: OpenCode2RuntimeShape["streamOpenCode2Events"] = (input) =>
    Effect.gen(function* () {
      const url = buildOpenCode2Url(input.connection.url, "/api/event");
      const request = HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader(
          "authorization",
          buildAuthorizationHeader(input.connection.password),
        ),
        HttpClientRequest.setHeader("accept", "text/event-stream"),
      );
      const response = yield* httpClient.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new OpenCode2RuntimeError({
              operation: "GET /api/event",
              detail: `OpenCode2 event stream request failed: ${openCode2RuntimeErrorDetail(cause)}`,
              cause,
            }),
        ),
      );
      if (response.status < 200 || response.status >= 300) {
        return yield* new OpenCode2RuntimeError({
          operation: "GET /api/event",
          detail: `OpenCode2 event stream returned ${response.status}.`,
        });
      }

      return HttpClientResponse.stream(Effect.succeed(response)).pipe(
        Stream.mapError((cause) =>
          OpenCode2RuntimeError.is(cause)
            ? cause
            : new OpenCode2RuntimeError({
                operation: "GET /api/event",
                detail: openCode2RuntimeErrorDetail(cause),
                cause,
              }),
        ),
        Stream.decodeText(),
        Stream.mapAccum(
          () => "",
          (remainder: string, chunk: string) => {
            const { frames, remainder: nextRemainder } = parseOpenCode2SseBuffer(remainder, chunk);
            return [nextRemainder, frames] as const;
          },
        ),
        Stream.filterMap(
          Filter.make((payload: string): Result.Result<OpenCode2SseMessage, string> => {
            const message = decodeOpenCode2SseMessage(payload);
            return message ? Result.succeed(message) : Result.fail(payload);
          }),
        ),
      );
    });

  return {
    runOpenCode2Command,
    startOpenCode2ServerProcess,
    connectToOpenCode2Server,
    request,
    streamOpenCode2Events,
  } satisfies OpenCode2RuntimeShape;
});

function ensureOpenCode2RuntimeError(
  operation: string,
  detail: string,
  cause: unknown,
): OpenCode2RuntimeError {
  return OpenCode2RuntimeError.is(cause)
    ? cause
    : new OpenCode2RuntimeError({ operation, detail, cause });
}

export class OpenCode2Runtime extends Context.Service<OpenCode2Runtime, OpenCode2RuntimeShape>()(
  "t3/provider/opencode2Runtime",
) {}

export const OpenCode2RuntimeLive = Layer.effect(OpenCode2Runtime, makeOpenCode2Runtime).pipe(
  Layer.provide(NetService.layer),
);
