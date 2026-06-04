import * as NodeOS from "node:os";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import {
  readPathFromLoginShell,
  readEnvironmentFromWindowsShell,
  resolveWindowsEnvironment,
  type CommandAvailabilityOptions,
  type WindowsShellEnvironmentReader,
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLaunchctl,
} from "@t3tools/shared/shell";

type WindowsCommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => Effect.Effect<boolean, never>;

class ShellPathReadError extends Data.TaggedError("ShellPathReadError")<{
  readonly cause: unknown;
}> {}

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

export const fixPath = Effect.fn("fixPath")(function* (
  options: {
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    readPath?: typeof readPathFromLoginShell;
    readWindowsEnvironment?: WindowsShellEnvironmentReader;
    isWindowsCommandAvailable?: WindowsCommandAvailabilityChecker;
    readLaunchctlPath?: typeof readPathFromLaunchctl;
    userShell?: string;
    logWarning?: (message: string, error?: unknown) => void;
  } = {},
) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const logWarning = options.logWarning ?? logPathHydrationWarning;
  const readPath = options.readPath ?? readPathFromLoginShell;

  yield* Effect.gen(function* () {
    if (platform === "win32") {
      const repairedEnvironment = yield* resolveWindowsEnvironment(env, {
        readEnvironment: options.readWindowsEnvironment ?? readEnvironmentFromWindowsShell,
        ...(options.isWindowsCommandAvailable
          ? { commandAvailable: options.isWindowsCommandAvailable }
          : {}),
      });
      for (const [key, value] of Object.entries(repairedEnvironment)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
      return;
    }

    if (platform !== "darwin" && platform !== "linux") return;

    let shellPath: string | undefined;
    for (const shell of listLoginShellCandidates(platform, env.SHELL, options.userShell)) {
      shellPath = yield* Effect.try({
        try: () => readPath(shell),
        catch: (error) => new ShellPathReadError({ cause: error }),
      }).pipe(
        Effect.catchTag("ShellPathReadError", (error) =>
          Effect.sync(() => {
            logWarning(`Failed to read PATH from login shell ${shell}.`, error.cause);
            return undefined;
          }),
        ),
      );

      if (shellPath) {
        break;
      }
    }

    const launchctlPath =
      platform === "darwin" && !shellPath
        ? (options.readLaunchctlPath ?? readPathFromLaunchctl)()
        : undefined;
    const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
    if (mergedPath) {
      env.PATH = mergedPath;
    }
  });
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), ".t3");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
