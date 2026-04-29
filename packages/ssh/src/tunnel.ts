import type {
  DesktopSshEnvironmentBootstrap,
  DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { type NetError, NetService } from "@t3tools/shared/Net";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import {
  Deferred,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Schema,
  Scope,
  Schedule,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildSshChildEnvironment,
  type SshAuthOptions,
  SshPasswordPrompt,
  isSshAuthFailure,
} from "./auth.ts";
import {
  baseSshArgs,
  buildSshHostSpecEffect,
  collectProcessOutput,
  getLastNonEmptyOutputLine,
  remoteStateKey,
  resolveSshTarget,
  runSshCommand,
  targetConnectionKey,
} from "./command.ts";
import {
  SshCommandError,
  SshHttpBridgeError,
  SshInvalidTargetError,
  SshLaunchError,
  SshPairingError,
  SshPasswordPromptError,
  SshReadinessError,
} from "./errors.ts";

export const DEFAULT_REMOTE_PORT = 3773;
const REMOTE_PORT_SCAN_WINDOW = 200;
const SSH_READY_TIMEOUT_MS = 20_000;
const TUNNEL_SHUTDOWN_TIMEOUT_MS = 2_000;

export interface SshEnvironmentManagerOptions {
  readonly resolveCliPackageSpec?: () => string;
}

interface SshTunnelEntry {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly process: ChildProcessSpawner.ChildProcessHandle;
}

type SshEnvironmentEffectContext =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | NetService
  | SshPasswordPrompt;

type SshEnvironmentEffectError =
  | SshCommandError
  | SshInvalidTargetError
  | SshLaunchError
  | SshPairingError
  | SshReadinessError
  | SshPasswordPromptError
  | NetError;

interface SshAuthOperationInput<T> {
  readonly key: string;
  readonly target: DesktopSshEnvironmentTarget;
  readonly operation: (
    authOptions: SshAuthOptions,
  ) => Effect.Effect<T, SshEnvironmentEffectError, SshEnvironmentEffectContext>;
}

interface SshAuthAttemptInput<T> extends SshAuthOperationInput<T> {
  readonly promptCount: number;
  readonly authSecret: string | null;
}

export interface SshEnvironmentManagerShape {
  readonly ensureEnvironment: (
    target: DesktopSshEnvironmentTarget,
    options?: { readonly issuePairingToken?: boolean },
  ) => Effect.Effect<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  >;
}

const RemoteLaunchResult = Schema.Struct({
  remotePort: Schema.Number,
});

const RemotePairingResult = Schema.Struct({
  credential: Schema.String,
});

const RemoteHttpError = Schema.Struct({
  error: Schema.optional(Schema.String),
});

const decodeRemoteLaunchResult = Schema.decodeEffect(fromLenientJson(RemoteLaunchResult));
const decodeRemotePairingResult = Schema.decodeEffect(fromLenientJson(RemotePairingResult));
const decodeRemoteHttpError = Schema.decodeEffect(Schema.fromJsonString(RemoteHttpError));

export function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

function stripTrailingNewlines(value: string): string {
  return value.replace(/\n+$/u, "");
}

function applyScriptPlaceholders(
  template: string,
  replacements: Readonly<Record<string, string>>,
): string {
  let result = template;
  for (const [token, value] of Object.entries(replacements)) {
    result = result.replaceAll(`@@${token}@@`, value);
  }
  return result;
}

export const REMOTE_PICK_PORT_SCRIPT = `const fs = require("node:fs");
const net = require("node:net");
const filePath = process.argv[2] ?? "";
const defaultPort = Number.parseInt(process.argv[3] ?? "", 10);
const scanWindow = Number.parseInt(process.argv[4] ?? "", 10);
const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim() : "";
const preferred = Number.parseInt(raw, 10);
const start = Number.isInteger(preferred) ? preferred : defaultPort;
const end = start + scanWindow;

function tryPort(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => resolve(error ? false : port));
    });
  });
}

(async () => {
  for (let port = start; port < end; port += 1) {
    const available = await tryPort(port);
    if (available) {
      process.stdout.write(String(port));
      return;
    }
  }
  process.exit(1);
})().catch(() => process.exit(1));
`;

export const REMOTE_RUNNER_SCRIPT = `#!/bin/sh
set -eu
if command -v t3 >/dev/null 2>&1; then
  exec t3 "$@"
fi
if command -v npx >/dev/null 2>&1; then
  exec npx --yes @@T3_PACKAGE_SPEC@@ "$@"
fi
if command -v npm >/dev/null 2>&1; then
  exec npm exec --yes @@T3_PACKAGE_SPEC@@ -- "$@"
fi
printf 'Remote host is missing the t3 CLI and could not install @@T3_PACKAGE_SPEC@@ because npx and npm are unavailable on PATH.\\n' >&2
exit 1
`;

export const REMOTE_LAUNCH_SCRIPT = `set -eu
STATE_KEY="$1"
STATE_DIR="$HOME/.t3/ssh-launch/$STATE_KEY"
SERVER_HOME="$STATE_DIR/server-home"
PORT_FILE="$STATE_DIR/port"
PID_FILE="$STATE_DIR/pid"
LOG_FILE="$STATE_DIR/server.log"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
mkdir -p "$STATE_DIR" "$SERVER_HOME"
cat >"$RUNNER_FILE" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
chmod 700 "$RUNNER_FILE"
pick_port() {
  node - "$PORT_FILE" "@@T3_DEFAULT_REMOTE_PORT@@" "@@T3_REMOTE_PORT_SCAN_WINDOW@@" <<'NODE'
@@T3_PICK_PORT_SCRIPT@@
NODE
}
REMOTE_PID="$(cat "$PID_FILE" 2>/dev/null || true)"
REMOTE_PORT="$(cat "$PORT_FILE" 2>/dev/null || true)"
if [ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null; then
  :
else
  REMOTE_PORT="$(pick_port)" || true
  if [ -z "$REMOTE_PORT" ]; then
    printf 'Failed to find an available port on the remote host. Ensure node is available on PATH.\\n' >&2
    exit 1
  fi
  nohup env T3CODE_NO_BROWSER=1 "$RUNNER_FILE" serve --host 127.0.0.1 --port "$REMOTE_PORT" --base-dir "$SERVER_HOME" >>"$LOG_FILE" 2>&1 < /dev/null &
  REMOTE_PID="$!"
  printf '%s\\n' "$REMOTE_PID" >"$PID_FILE"
  printf '%s\\n' "$REMOTE_PORT" >"$PORT_FILE"
fi
printf '{"remotePort":%s}\\n' "$REMOTE_PORT"
`;

export const REMOTE_PAIRING_SCRIPT = `set -eu
STATE_DIR="$HOME/.t3/ssh-launch/@@T3_STATE_KEY@@"
SERVER_HOME="$STATE_DIR/server-home"
RUNNER_FILE="$STATE_DIR/run-t3.sh"
mkdir -p "$STATE_DIR" "$SERVER_HOME"
cat >"$RUNNER_FILE" <<'SH'
@@T3_RUNNER_SCRIPT@@
SH
chmod 700 "$RUNNER_FILE"
"$RUNNER_FILE" auth pairing create --base-dir "$SERVER_HOME" --json
`;

export function buildRemoteT3RunnerScript(input?: { readonly packageSpec?: string }): string {
  const packageSpec = input?.packageSpec?.trim() || "t3@latest";
  return stripTrailingNewlines(
    applyScriptPlaceholders(REMOTE_RUNNER_SCRIPT, {
      T3_PACKAGE_SPEC: packageSpec,
    }),
  );
}

export function buildRemoteLaunchScript(input?: { readonly packageSpec?: string }): string {
  return applyScriptPlaceholders(REMOTE_LAUNCH_SCRIPT, {
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
    T3_PICK_PORT_SCRIPT: stripTrailingNewlines(REMOTE_PICK_PORT_SCRIPT),
    T3_DEFAULT_REMOTE_PORT: String(DEFAULT_REMOTE_PORT),
    T3_REMOTE_PORT_SCAN_WINDOW: String(REMOTE_PORT_SCAN_WINDOW),
  });
}

export function buildRemotePairingScript(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly packageSpec?: string },
): string {
  return applyScriptPlaceholders(REMOTE_PAIRING_SCRIPT, {
    T3_STATE_KEY: remoteStateKey(target),
    T3_RUNNER_SCRIPT: stripTrailingNewlines(buildRemoteT3RunnerScript(input)),
  });
}

export const launchOrReuseRemoteServer = Effect.fn("ssh/tunnel.launchOrReuseRemoteServer")(
  function* (
    target: DesktopSshEnvironmentTarget,
    input?: SshAuthOptions,
    runner?: { readonly packageSpec?: string },
  ): Effect.fn.Return<
    number,
    SshCommandError | SshInvalidTargetError | SshLaunchError,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const result = yield* runSshCommand(target, {
      remoteCommandArgs: ["sh", "-s", "--", remoteStateKey(target)],
      stdin: buildRemoteLaunchScript(runner),
      ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
      ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
      ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
    });
    if (!getLastNonEmptyOutputLine(result.stdout)) {
      return yield* new SshLaunchError({
        message: "SSH launch did not return a remote port.",
        stdout: result.stdout,
      });
    }
    const parsed = yield* decodeRemoteLaunchResult(result.stdout).pipe(
      Effect.mapError(
        (cause) =>
          new SshLaunchError({
            message: "SSH launch returned unparseable output.",
            stdout: result.stdout,
            cause,
          }),
      ),
    );
    if (!Number.isInteger(parsed.remotePort)) {
      return yield* new SshLaunchError({
        message: `SSH launch returned an invalid remote port: ${String(parsed.remotePort)}.`,
        stdout: result.stdout,
      });
    }
    return parsed.remotePort;
  },
);

export const issueRemotePairingToken = Effect.fn("ssh/tunnel.issueRemotePairingToken")(function* (
  target: DesktopSshEnvironmentTarget,
  input?: SshAuthOptions,
  runner?: { readonly packageSpec?: string },
): Effect.fn.Return<
  string,
  SshCommandError | SshInvalidTargetError | SshPairingError,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const result = yield* runSshCommand(target, {
    remoteCommandArgs: ["sh", "-s"],
    stdin: buildRemotePairingScript(target, runner),
    ...(input?.authSecret === undefined ? {} : { authSecret: input.authSecret }),
    ...(input?.batchMode === undefined ? {} : { batchMode: input.batchMode }),
    ...(input?.interactiveAuth === undefined ? {} : { interactiveAuth: input.interactiveAuth }),
  });
  if (!getLastNonEmptyOutputLine(result.stdout)) {
    return yield* new SshPairingError({
      message: "SSH pairing did not return a credential.",
      stdout: result.stdout,
    });
  }
  const parsed = yield* decodeRemotePairingResult(result.stdout).pipe(
    Effect.mapError(
      (cause) =>
        new SshPairingError({
          message: "SSH pairing returned unparseable output.",
          stdout: result.stdout,
          cause,
        }),
    ),
  );
  if (parsed.credential.trim().length === 0) {
    return yield* new SshPairingError({
      message: "SSH pairing command returned an invalid credential.",
      stdout: result.stdout,
    });
  }
  return parsed.credential;
});

export const waitForHttpReady = Effect.fn("ssh/tunnel.waitForHttpReady")(function* (input: {
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly path?: string;
}): Effect.fn.Return<void, SshReadinessError, HttpClient.HttpClient> {
  const timeoutMs = input.timeoutMs ?? 30_000;
  const intervalMs = input.intervalMs ?? 100;
  const maxRetries = Math.max(0, Math.ceil(timeoutMs / intervalMs));
  const requestUrl = new URL(input.path ?? "/", input.baseUrl).toString();
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.filterStatusOk,
    HttpClient.retry({
      schedule: Schedule.spaced(Duration.millis(intervalMs)),
      times: maxRetries,
    }),
  );

  yield* client.execute(HttpClientRequest.get(requestUrl)).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new SshReadinessError({
          message: `Timed out waiting for backend readiness at ${input.baseUrl}.`,
          cause,
        }),
    ),
  );
});

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

function resolveLoopbackSshHttpUrl(
  rawHttpBaseUrl: unknown,
  pathname: string,
): Effect.Effect<URL, SshHttpBridgeError> {
  return Effect.try({
    try: () => {
      if (typeof rawHttpBaseUrl !== "string" || rawHttpBaseUrl.trim().length === 0) {
        throw new Error("Invalid SSH forwarded http base URL.");
      }
      const baseUrl = new URL(rawHttpBaseUrl);
      if (!isLoopbackHostname(baseUrl.hostname)) {
        throw new Error("SSH desktop bridge only supports loopback forwarded URLs.");
      }
      const url = new URL(baseUrl.toString());
      url.pathname = pathname;
      url.search = "";
      url.hash = "";
      return url;
    },
    catch: (cause) =>
      new SshHttpBridgeError({
        message: cause instanceof Error ? cause.message : "Invalid SSH forwarded http base URL.",
        cause,
      }),
  });
}

export const fetchLoopbackSshJson = Effect.fn("ssh/tunnel.fetchLoopbackSshJson")(function* <
  T,
>(input: {
  readonly httpBaseUrl: unknown;
  readonly pathname: string;
  readonly method?: "GET" | "POST";
  readonly bearerToken?: unknown;
  readonly body?: unknown;
}): Effect.fn.Return<T, SshHttpBridgeError, HttpClient.HttpClient> {
  const requestUrl = yield* resolveLoopbackSshHttpUrl(input.httpBaseUrl, input.pathname);
  const bearerToken =
    typeof input.bearerToken === "string" && input.bearerToken.trim().length > 0
      ? input.bearerToken
      : null;

  const request = (
    input.method === "POST"
      ? HttpClientRequest.post(requestUrl.toString())
      : HttpClientRequest.get(requestUrl.toString())
  ).pipe(
    input.body === undefined ? (req) => req : HttpClientRequest.bodyJsonUnsafe(input.body),
    bearerToken
      ? HttpClientRequest.setHeader("authorization", `Bearer ${bearerToken}`)
      : (req) => req,
  );
  const client = yield* HttpClient.HttpClient;
  const response = yield* client.execute(request).pipe(
    Effect.mapError(
      (cause) =>
        new SshHttpBridgeError({
          message: `Failed to reach SSH forwarded endpoint ${requestUrl.toString()}.`,
          cause,
        }),
    ),
  );
  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
    const parsedError = yield* decodeRemoteHttpError(text).pipe(
      Effect.catch(() => Effect.succeed(null)),
    );
    const message =
      parsedError?.error && parsedError.error.trim().length > 0
        ? parsedError.error
        : text || `SSH forwarded request failed (${response.status}).`;
    return yield* new SshHttpBridgeError({
      status: response.status,
      message: `[ssh_http:${response.status}] ${message}`,
    });
  }
  return (yield* response.json.pipe(
    Effect.mapError(
      (cause) =>
        new SshHttpBridgeError({
          message: `SSH forwarded endpoint ${requestUrl.toString()} returned invalid JSON.`,
          cause,
        }),
    ),
  )) as T;
});

const reserveLocalTunnelPort = Effect.fn("ssh/tunnel.reserveLocalTunnelPort")(function* () {
  const net = yield* NetService;
  return yield* net.reserveLoopbackPort();
});

const startSshTunnel = Effect.fn("ssh/tunnel.startSshTunnel")(function* (input: {
  readonly key: string;
  readonly resolvedTarget: DesktopSshEnvironmentTarget;
  readonly remotePort: number;
  readonly localPort: number;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly authOptions: SshAuthOptions;
}): Effect.fn.Return<
  SshTunnelEntry,
  SshCommandError | SshInvalidTargetError | SshReadinessError,
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | Scope.Scope
> {
  const hostSpec = yield* buildSshHostSpecEffect(input.resolvedTarget);
  const childEnvironment = yield* buildSshChildEnvironment({
    ...(input.authOptions.authSecret === undefined
      ? {}
      : { authSecret: input.authOptions.authSecret }),
    ...(input.authOptions.interactiveAuth === undefined
      ? {}
      : { interactiveAuth: input.authOptions.interactiveAuth }),
  }).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh"],
          exitCode: null,
          stderr: "",
          message: "Failed to prepare SSH authentication helpers.",
          cause,
        }),
    ),
  );
  const args = [
    ...baseSshArgs(input.resolvedTarget, {
      batchMode: input.authOptions.batchMode ?? "no",
    }),
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "-N",
    "-L",
    `${input.localPort}:127.0.0.1:${input.remotePort}`,
    hostSpec,
  ];
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner
    .spawn(
      ChildProcess.make("ssh", args, {
        env: childEnvironment,
        shell: process.platform === "win32",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new SshCommandError({
            command: ["ssh", ...args],
            exitCode: null,
            stderr: "",
            message:
              cause instanceof Error
                ? cause.message
                : `Failed to spawn SSH tunnel for ${input.resolvedTarget.alias}.`,
            cause,
          }),
      ),
    );
  const tunnelEntry: SshTunnelEntry = {
    key: input.key,
    target: input.resolvedTarget,
    remotePort: input.remotePort,
    localPort: input.localPort,
    httpBaseUrl: input.httpBaseUrl,
    wsBaseUrl: input.wsBaseUrl,
    process: child,
  };
  const exitFailure = Effect.all(
    [collectProcessOutput(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new SshCommandError({
          command: ["ssh", ...args],
          exitCode: null,
          stderr: "",
          message:
            cause instanceof Error
              ? cause.message
              : `Failed to monitor SSH tunnel for ${input.resolvedTarget.alias}.`,
          cause,
        }),
    ),
    Effect.flatMap(([stderr, exitCode]) =>
      Effect.fail(
        new SshCommandError({
          command: ["ssh", ...args],
          exitCode,
          stderr,
          message: normalizeSshErrorMessage(
            stderr,
            `SSH tunnel exited unexpectedly for ${input.resolvedTarget.alias} (exit ${exitCode}).`,
          ),
        }),
      ),
    ),
  );
  yield* Effect.raceFirst(
    waitForHttpReady({
      baseUrl: input.httpBaseUrl,
      timeoutMs: SSH_READY_TIMEOUT_MS,
    }),
    exitFailure,
  ).pipe(
    Effect.onExit((exit) =>
      Exit.isSuccess(exit)
        ? Effect.void
        : child
            .kill({
              killSignal: "SIGTERM",
              forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
            })
            .pipe(Effect.ignore),
    ),
  );
  return tunnelEntry;
});

const makeSshEnvironmentManager = Effect.fn("ssh/tunnel.SshEnvironmentManager.make")(function* (
  options: SshEnvironmentManagerOptions = {},
): Effect.fn.Return<SshEnvironmentManagerShape, never, Scope.Scope> {
  const tunnelScope = yield* Scope.Scope;
  const tunnels = new Map<string, SshTunnelEntry>();
  const pendingTunnelEntries = new Map<
    string,
    Deferred.Deferred<SshTunnelEntry, SshEnvironmentEffectError>
  >();
  const authSecrets = new Map<string, string>();

  const deleteTunnelIfCurrent = (entry: SshTunnelEntry): void => {
    if (tunnels.get(entry.key) === entry) {
      tunnels.delete(entry.key);
    }
  };

  const promptForPassword = Effect.fn("ssh/tunnel.promptForPassword")(function* (
    target: DesktopSshEnvironmentTarget,
    attempt: number,
  ): Effect.fn.Return<string, SshInvalidTargetError | SshPasswordPromptError, SshPasswordPrompt> {
    const promptService = yield* SshPasswordPrompt;
    const hostSpec = yield* buildSshHostSpecEffect(target);
    if (!promptService.isAvailable) {
      return yield* new SshPasswordPromptError({
        message: `SSH authentication failed for ${hostSpec}.`,
      });
    }

    const password = yield* promptService.request({
      attempt,
      destination: target.alias.trim() || target.hostname.trim(),
      username: target.username,
      prompt: `Enter the SSH password for ${hostSpec}.`,
    });
    if (password === null) {
      return yield* new SshPasswordPromptError({
        message: `SSH authentication cancelled for ${hostSpec}.`,
      });
    }
    return password;
  });

  const handleSshAuthFailure = Effect.fn("ssh/tunnel.runWithSshAuthAttempt.handleFailure")(
    function* <T>(
      input: SshAuthAttemptInput<T> & {
        readonly error: SshEnvironmentEffectError;
      },
    ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
      if (!isSshAuthFailure(input.error)) {
        return yield* input.error;
      }

      const promptService = yield* SshPasswordPrompt;
      if (!promptService.isAvailable) {
        return yield* input.error;
      }
      if (input.authSecret !== null) {
        authSecrets.delete(input.key);
      }
      if (input.promptCount >= 2) {
        return yield* input.error;
      }

      const nextPromptCount = input.promptCount + 1;
      const nextAuthSecret = yield* promptForPassword(input.target, nextPromptCount);
      authSecrets.set(input.key, nextAuthSecret);
      return yield* runWithSshAuthAttempt({
        ...input,
        promptCount: nextPromptCount,
        authSecret: nextAuthSecret,
      });
    },
  );

  const runWithSshAuthAttempt = Effect.fn("ssh/tunnel.runWithSshAuthAttempt")(function* <T>(
    input: SshAuthAttemptInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const promptService = yield* SshPasswordPrompt;
    const authOptions =
      input.authSecret === null
        ? {
            batchMode: promptService.isAvailable ? ("yes" as const) : ("no" as const),
            interactiveAuth: !promptService.isAvailable,
          }
        : {
            authSecret: input.authSecret,
            batchMode: "no" as const,
            interactiveAuth: true,
          };

    return yield* input
      .operation(authOptions)
      .pipe(Effect.catch((error) => handleSshAuthFailure({ ...input, error })));
  });

  const runWithSshAuth = Effect.fn("ssh/tunnel.runWithSshAuth")(function* <T>(
    input: SshAuthOperationInput<T>,
  ): Effect.fn.Return<T, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    return yield* runWithSshAuthAttempt({
      ...input,
      promptCount: 0,
      authSecret: authSecrets.get(input.key) ?? null,
    });
  });

  const createTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry.create")(function* (input: {
    readonly key: string;
    readonly resolvedTarget: DesktopSshEnvironmentTarget;
    readonly packageSpec?: string;
  }): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    const remotePort = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        launchOrReuseRemoteServer(
          input.resolvedTarget,
          authOptions,
          input.packageSpec === undefined ? undefined : { packageSpec: input.packageSpec },
        ),
    });
    const localPort = yield* reserveLocalTunnelPort();
    const httpBaseUrl = `http://127.0.0.1:${localPort}/`;
    const wsBaseUrl = `ws://127.0.0.1:${localPort}/`;
    const tunnelEntry = yield* runWithSshAuth({
      key: input.key,
      target: input.resolvedTarget,
      operation: (authOptions) =>
        startSshTunnel({
          key: input.key,
          resolvedTarget: input.resolvedTarget,
          remotePort,
          localPort,
          httpBaseUrl,
          wsBaseUrl,
          authOptions,
        }).pipe(Effect.provideService(Scope.Scope, tunnelScope)),
    });
    tunnels.set(input.key, tunnelEntry);
    return tunnelEntry;
  });

  const ensureTunnelEntry = Effect.fn("ssh/tunnel.ensureTunnelEntry")(function* (
    key: string,
    resolvedTarget: DesktopSshEnvironmentTarget,
    packageSpec?: string,
  ): Effect.fn.Return<SshTunnelEntry, SshEnvironmentEffectError, SshEnvironmentEffectContext> {
    let entry = tunnels.get(key) ?? null;

    if (entry !== null) {
      const readinessExit = yield* Effect.exit(
        waitForHttpReady({ baseUrl: entry.httpBaseUrl, timeoutMs: 2_000 }),
      );
      if (Exit.isSuccess(readinessExit)) {
        return entry;
      }
      yield* entry.process
        .kill({
          killSignal: "SIGTERM",
          forceKillAfter: TUNNEL_SHUTDOWN_TIMEOUT_MS,
        })
        .pipe(Effect.ignore);
      deleteTunnelIfCurrent(entry);
      entry = null;
    }

    const pending = pendingTunnelEntries.get(key);
    if (pending) {
      return yield* Deferred.await(pending);
    }

    const deferred = yield* Deferred.make<SshTunnelEntry, SshEnvironmentEffectError>();
    pendingTunnelEntries.set(key, deferred);

    return yield* createTunnelEntry({
      key,
      resolvedTarget,
      ...(packageSpec === undefined ? {} : { packageSpec }),
    }).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (pendingTunnelEntries.get(key) === deferred) {
            pendingTunnelEntries.delete(key);
          }
        }).pipe(Effect.andThen(Deferred.done(deferred, exit))),
      ),
    );
  });

  const ensureEnvironment = Effect.fn("ssh/tunnel.ensureEnvironment")(function* (
    target: DesktopSshEnvironmentTarget,
    requestOptions?: { readonly issuePairingToken?: boolean },
  ): Effect.fn.Return<
    DesktopSshEnvironmentBootstrap,
    SshEnvironmentEffectError,
    SshEnvironmentEffectContext
  > {
    const baseResolved = yield* resolveSshTarget(target.alias || target.hostname);
    const resolvedTarget: DesktopSshEnvironmentTarget = {
      ...baseResolved,
      ...(target.username !== null ? { username: target.username } : {}),
      ...(target.port !== null ? { port: target.port } : {}),
    };
    const key = targetConnectionKey(resolvedTarget);
    const packageSpec = options.resolveCliPackageSpec?.();
    const entry = yield* ensureTunnelEntry(key, resolvedTarget, packageSpec);

    const pairingToken = requestOptions?.issuePairingToken
      ? yield* runWithSshAuth({
          key,
          target: entry.target,
          operation: (authOptions) =>
            issueRemotePairingToken(
              entry.target,
              authOptions,
              packageSpec === undefined ? undefined : { packageSpec },
            ),
        })
      : null;

    return {
      target: entry.target,
      httpBaseUrl: entry.httpBaseUrl,
      wsBaseUrl: entry.wsBaseUrl,
      pairingToken,
    };
  });

  return SshEnvironmentManager.of({ ensureEnvironment });
});

export class SshEnvironmentManager extends Context.Service<
  SshEnvironmentManager,
  SshEnvironmentManagerShape
>()("@t3tools/ssh/SshEnvironmentManager") {
  static readonly layer = (options: SshEnvironmentManagerOptions = {}) =>
    Layer.effect(SshEnvironmentManager, makeSshEnvironmentManager(options));
}
