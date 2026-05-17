import { parsePersistedServerObservabilitySettings } from "@t3tools/shared/serverSettings";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";

import serverPackageJson from "../../../server/package.json" with { type: "json" };

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopObservability from "../app/DesktopObservability.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

export interface DesktopBackendConfigurationShape {
  // Build the Windows-native primary backend's start config. Reads the
  // primary's port/host/exposure from DesktopServerExposure.
  readonly resolvePrimary: Effect.Effect<DesktopBackendManager.DesktopBackendStartConfig>;
  // Build a WSL backend start config for the given distro on the given
  // port. The WSL backend is always loopback-only (the primary owns LAN
  // exposure when the user opts in), so this takes the port directly and
  // hardcodes 127.0.0.1. Distro=null means "WSL default distro" and is
  // forwarded to wsl.exe with no -d flag.
  readonly resolveWsl: (input: {
    readonly port: number;
    readonly distro: string | null;
  }) => Effect.Effect<DesktopBackendManager.DesktopBackendStartConfig>;
}

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  DesktopBackendConfigurationShape
>()("t3/desktop/BackendConfiguration") {}

interface BackendObservabilitySettings {
  readonly otlpTracesUrl: Option.Option<string>;
  readonly otlpMetricsUrl: Option.Option<string>;
}

const emptyBackendObservabilitySettings: BackendObservabilitySettings = {
  otlpTracesUrl: Option.none(),
  otlpMetricsUrl: Option.none(),
};

const DESKTOP_BACKEND_ENV_NAMES = [
  "T3CODE_PORT",
  "T3CODE_MODE",
  "T3CODE_NO_BROWSER",
  "T3CODE_HOST",
  "T3CODE_DESKTOP_WS_URL",
  "T3CODE_DESKTOP_LAN_ACCESS",
  "T3CODE_DESKTOP_LAN_HOST",
  "T3CODE_DESKTOP_HTTPS_ENDPOINTS",
  "T3CODE_TAILSCALE_SERVE",
  "T3CODE_TAILSCALE_SERVE_PORT",
] as const;

// Sensitive env vars that the WSL backend needs but Windows process.env won't
// forward across the wsl.exe boundary without WSLENV. The dev-server URL is
// handled separately via a `--dev-url` CLI flag because WSLENV translation of
// URL-shaped values (colons / slashes) is unreliable.
const WSL_FORWARDED_ENV_NAMES = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] as const;

const backendChildEnvPatch = (): Record<string, string | undefined> =>
  Object.fromEntries(DESKTOP_BACKEND_ENV_NAMES.map((name) => [name, undefined]));

const getWslEnvEntryName = (entry: string): string => {
  const slashIndex = entry.indexOf("/");
  return slashIndex === -1 ? entry : entry.slice(0, slashIndex);
};

const mergeWslEnv = (
  existingWslEnv: string | undefined,
  forwardedEnvNames: ReadonlyArray<string>,
): string | undefined => {
  const entries: string[] = [];
  const seenNames = new Set<string>();

  for (const rawEntry of existingWslEnv?.split(":") ?? []) {
    const entry = rawEntry.trim();
    if (entry.length === 0) continue;

    const name = getWslEnvEntryName(entry);
    if (name.length === 0 || seenNames.has(name)) continue;

    seenNames.add(name);
    entries.push(entry);
  }

  for (const name of forwardedEnvNames) {
    if (seenNames.has(name)) continue;

    seenNames.add(name);
    entries.push(name);
  }

  return entries.length > 0 ? entries.join(":") : undefined;
};

const { logWarning: logBackendConfigurationWarning } = DesktopObservability.makeComponentLogger(
  "desktop-backend-configuration",
);

const readPersistedBackendObservabilitySettings: Effect.Effect<
  BackendObservabilitySettings,
  never,
  FileSystem.FileSystem | DesktopEnvironment.DesktopEnvironment
> = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const exists = yield* fileSystem
    .exists(environment.serverSettingsPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return emptyBackendObservabilitySettings;
  }

  const raw = yield* fileSystem.readFileString(environment.serverSettingsPath).pipe(Effect.option);
  if (Option.isNone(raw)) {
    yield* logBackendConfigurationWarning(
      "failed to read persisted backend observability settings",
    );
    return emptyBackendObservabilitySettings;
  }

  const parsed = parsePersistedServerObservabilitySettings(raw.value);
  return {
    otlpTracesUrl: Option.fromNullishOr(parsed.otlpTracesUrl),
    otlpMetricsUrl: Option.fromNullishOr(parsed.otlpMetricsUrl),
  };
});

const getOrCreateBootstrapToken = Effect.fn("desktop.backendConfiguration.bootstrapToken")(
  function* (tokenRef: Ref.Ref<Option.Option<string>>) {
    const existing = yield* Ref.get(tokenRef);
    if (Option.isSome(existing)) {
      return existing.value;
    }

    let token = "";
    while (token.length < 48) {
      token += (yield* Random.nextUUIDv4).replace(/-/g, "");
    }
    token = token.slice(0, 48);
    yield* Ref.set(tokenRef, Option.some(token));
    return token;
  },
);

interface SharedBootstrapInput {
  readonly bootstrapToken: string;
  readonly observabilitySettings: BackendObservabilitySettings;
}

interface WslPreflightOutcome {
  readonly _tag: "Ready";
  readonly linuxEntryPath: string;
}

interface WslPreflightFailure {
  readonly _tag: "Failed";
  readonly reason: string;
}

const runWslPreflight = Effect.fn("desktop.backendConfiguration.wslPreflight")(function* (input: {
  readonly distro: string | null;
  readonly windowsEntryPath: string;
  readonly windowsRepoRoot: string;
  readonly allowBuild: boolean;
}): Effect.fn.Return<
  WslPreflightOutcome | WslPreflightFailure,
  never,
  DesktopWslEnvironment.DesktopWslEnvironment | FileSystem.FileSystem
> {
  const wslEnv = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const wslAvailable = yield* wslEnv.isAvailable;
  if (!wslAvailable) {
    return { _tag: "Failed", reason: "WSL is not available on this system" } as const;
  }

  const entryExists = yield* fileSystem
    .exists(input.windowsEntryPath)
    .pipe(Effect.orElseSucceed(() => false));
  if (!entryExists) {
    return {
      _tag: "Failed",
      reason: `missing server entry at ${input.windowsEntryPath}`,
    } as const;
  }

  const linuxEntry = yield* wslEnv.windowsToWslPath(input.distro, input.windowsEntryPath);
  if (Option.isNone(linuxEntry)) {
    return {
      _tag: "Failed",
      reason: `wslpath conversion failed for ${input.windowsEntryPath}`,
    } as const;
  }

  const nodePtyResult = yield* wslEnv.ensureNodePty(input.distro, input.windowsRepoRoot, {
    allowBuild: input.allowBuild,
    nodeEngineRange: serverPackageJson.engines.node,
  });
  if (!nodePtyResult.ok) {
    return {
      _tag: "Failed",
      reason: `WSL node-pty unavailable: ${nodePtyResult.reason}`,
    } as const;
  }

  return { _tag: "Ready", linuxEntryPath: linuxEntry.value } as const;
});

const buildObservabilityFragment = (observabilitySettings: BackendObservabilitySettings) => ({
  ...Option.match(observabilitySettings.otlpTracesUrl, {
    onNone: () => ({}),
    onSome: (otlpTracesUrl) => ({ otlpTracesUrl }),
  }),
  ...Option.match(observabilitySettings.otlpMetricsUrl, {
    onNone: () => ({}),
    onSome: (otlpMetricsUrl) => ({ otlpMetricsUrl }),
  }),
});

const resolvePrimaryStartConfig = Effect.fn("desktop.backendConfiguration.resolvePrimary")(
  function* (
    input: SharedBootstrapInput,
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    DesktopEnvironment.DesktopEnvironment | DesktopServerExposure.DesktopServerExposure
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: backendExposure.port,
      t3Home: environment.baseDir,
      host: backendExposure.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
      tailscaleServePort: backendExposure.tailscaleServePort,
      ...buildObservabilityFragment(input.observabilitySettings),
    };

    return {
      executablePath: process.execPath,
      args: [environment.backendEntryPath, "--bootstrap-fd", "3"],
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...backendChildEnvPatch(),
        ELECTRON_RUN_AS_NODE: "1",
      },
      // Primary wants process.env (PATH, dev-runner's T3CODE_HOME, etc.).
      extendEnv: true,
      bootstrap,
      bootstrapDelivery: "fd3",
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
      preflightFailure: Option.none(),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);

const resolveWslStartConfig = Effect.fn("desktop.backendConfiguration.resolveWsl")(function* (
  input: SharedBootstrapInput & {
    readonly port: number;
    readonly distro: string | null;
  },
): Effect.fn.Return<
  DesktopBackendManager.DesktopBackendStartConfig,
  never,
  | DesktopEnvironment.DesktopEnvironment
  | DesktopWslEnvironment.DesktopWslEnvironment
  | FileSystem.FileSystem
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;

  // WSL backend is always loopback-only; the primary owns LAN exposure
  // when the user opts in. Hardcode 127.0.0.1 + drop the tailscale flags
  // so a second tailscale serve forwarder doesn't try to bind the same
  // port from inside WSL.
  const wslHost = "127.0.0.1";
  const httpBaseUrl = new URL(`http://${wslHost}:${input.port}`);

  const bootstrap = {
    mode: "desktop" as const,
    noBrowser: true,
    port: input.port,
    // Omit t3Home so the Linux backend uses its own home dir instead of
    // the Windows-side baseDir (which would be a /mnt/c path and share
    // the SQLite file with the primary).
    host: wslHost,
    desktopBootstrapToken: input.bootstrapToken,
    // PortSchema rejects 0, so when tailscale serve is disabled we still
    // need a valid number in this slot. The backend reads tailscaleServePort
    // only when tailscaleServeEnabled is true, so the actual value here is
    // inert.
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    ...buildObservabilityFragment(input.observabilitySettings),
  };

  const preflight = yield* runWslPreflight({
    distro: input.distro,
    windowsEntryPath: environment.backendEntryPath,
    windowsRepoRoot: environment.appRoot,
    allowBuild: !environment.isPackaged,
  });

  const distroArgs = input.distro ? ["-d", input.distro] : [];
  const forwardedEnv: Record<string, string> = {};
  const forwardedEnvNames: string[] = [];
  for (const name of WSL_FORWARDED_ENV_NAMES) {
    const value = process.env[name];
    if (value !== undefined && value.length > 0) {
      forwardedEnv[name] = value;
      forwardedEnvNames.push(name);
    }
  }

  // Build an explicit copy of process.env minus T3CODE_HOME (dev-runner
  // exports the Windows-side base dir for the primary; if it leaks into
  // the WSL backend the Linux side ends up sharing C:\Users\...\.t3 via
  // /mnt/c, which means both backends read/write the same database and
  // their env-ids collide).
  const parentEnvWithoutT3Home: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key === "T3CODE_HOME") continue;
    parentEnvWithoutT3Home[key] = value;
  }
  const wslEnv = mergeWslEnv(parentEnvWithoutT3Home.WSLENV, forwardedEnvNames);

  const baseConfig = {
    executablePath: "wsl.exe",
    entryPath: environment.backendEntryPath,
    cwd: environment.backendCwd,
    env: {
      ...parentEnvWithoutT3Home,
      ...backendChildEnvPatch(),
      ...forwardedEnv,
      ...(wslEnv !== undefined ? { WSLENV: wslEnv } : {}),
    },
    // env is already a complete process.env minus T3CODE_HOME; pass it
    // verbatim instead of letting the spawner re-merge process.env on top.
    extendEnv: false,
    bootstrap,
    bootstrapDelivery: "stdin" as const,
    httpBaseUrl,
    captureOutput: true,
  };

  // Forward the dev-server URL as an explicit CLI flag so the WSL backend's
  // config resolution lands in dev/ instead of userdata/. Inheriting through
  // WSLENV is unreliable in practice (URL-shaped values with colons /
  // slashes get translated unpredictably depending on flags), and the
  // packaged build leaves devServerUrl as None anyway.
  const devUrlArgs = Option.match(environment.devServerUrl, {
    onNone: () => [] as ReadonlyArray<string>,
    onSome: (url) => ["--dev-url", url.href],
  });

  if (preflight._tag === "Failed") {
    return {
      ...baseConfig,
      args: [...distroArgs, "--", "node", "--version"],
      preflightFailure: Option.some(preflight.reason),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  }

  return {
    ...baseConfig,
    args: [
      ...distroArgs,
      "--",
      "node",
      preflight.linuxEntryPath,
      "--bootstrap-fd",
      "0",
      ...devUrlArgs,
    ],
    preflightFailure: Option.none(),
  } satisfies DesktopBackendManager.DesktopBackendStartConfig;
});

export const layer = Layer.effect(
  DesktopBackendConfiguration,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const tokenRef = yield* Ref.make(Option.none<string>());

    // Both resolvers share the same bootstrap token: the renderer holds a
    // single token and uses it against whichever backend it's currently
    // talking to. Observability settings get re-read each resolve so a
    // hot-swap of the server-settings file is picked up on the next
    // restart cycle without having to bounce the desktop process.
    const sharedInputs = Effect.gen(function* () {
      const bootstrapToken = yield* getOrCreateBootstrapToken(tokenRef);
      const observabilitySettings = yield* readPersistedBackendObservabilitySettings.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      );
      return { bootstrapToken, observabilitySettings } satisfies SharedBootstrapInput;
    });

    return DesktopBackendConfiguration.of({
      resolvePrimary: Effect.gen(function* () {
        const shared = yield* sharedInputs;
        return yield* resolvePrimaryStartConfig(shared).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
        );
      }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimary")),
      resolveWsl: (input) =>
        Effect.gen(function* () {
          const shared = yield* sharedInputs;
          return yield* resolveWslStartConfig({ ...shared, ...input }).pipe(
            Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
            Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
        }).pipe(
          Effect.withSpan("desktop.backendConfiguration.resolveWsl", {
            attributes: { port: input.port, distro: input.distro ?? null },
          }),
        ),
    });
  }),
);
