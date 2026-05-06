import { Console, Data, Duration, Effect, Option, Stream } from "effect";
import { Prompt } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

const DESKTOP_APP_NAMES = ["T3 Code (Alpha)", "T3 Code (Nightly)"] as const;
const DESKTOP_APP_NAME = "T3 Code";
const DESKTOP_LINUX_DESKTOP_ENTRY = "t3code.desktop";
const DESKTOP_LINUX_EXECUTABLE = "t3code";
export const DESKTOP_RELEASES_URL = "https://github.com/pingdotgg/t3code/releases/latest";

type Platform = NodeJS.Platform;

export interface DesktopLaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export class DesktopAppLaunchError extends Data.TaggedError("DesktopAppLaunchError")<{
  readonly command: string;
  readonly message: string;
  readonly exitCode?: number | undefined;
  readonly cause?: unknown;
}> {}

export type DesktopAppFallbackChoice = "open-github" | "use-web-ui" | "exit";

export interface DesktopAppFallbackPromptChoice {
  readonly title: string;
  readonly value: DesktopAppFallbackChoice;
}

export const desktopAppFallbackPromptChoices: ReadonlyArray<DesktopAppFallbackPromptChoice> = [
  { title: "Yes, open github", value: "open-github" },
  { title: "No, use web UI", value: "use-web-ui" },
  { title: "No, exit", value: "exit" },
];

export type DesktopAppLaunchResult =
  | { readonly _tag: "opened-app" }
  | { readonly _tag: "opened-releases" }
  | { readonly _tag: "use-web-ui" }
  | { readonly _tag: "exit" };

const desktopAppLaunchArgs = (workspacePath: string | undefined): ReadonlyArray<string> =>
  workspacePath ? ["--t3-open-path", workspacePath] : [];

function quotePowerShellSingle(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function desktopAppLaunchCommands(
  platform: Platform,
  workspacePath?: string,
): ReadonlyArray<DesktopLaunchCommand> {
  const appArgs = desktopAppLaunchArgs(workspacePath);
  if (platform === "darwin") {
    return DESKTOP_APP_NAMES.map((appName) => ({
      command: "open",
      args: appArgs.length > 0 ? ["-a", appName, "--args", ...appArgs] : ["-a", appName],
    }));
  }

  if (platform === "win32") {
    const argumentList =
      appArgs.length > 0
        ? ` -ArgumentList @(${appArgs.map(quotePowerShellSingle).join(", ")})`
        : "";
    const script = [
      "$names = @('T3 Code (Alpha)', 'T3 Code (Nightly)', 'T3 Code')",
      "$roots = @($env:LOCALAPPDATA, $env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { $_ }",
      '$candidates = foreach ($root in $roots) { foreach ($name in $names) { Join-Path (Join-Path $root \'Programs\') (Join-Path $name "$name.exe"); Join-Path $root (Join-Path $name "$name.exe") } }',
      "$target = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1",
      "if (-not $target) { exit 1 }",
      `Start-Process -FilePath $target${argumentList}`,
    ].join("; ");

    return [
      {
        command: "powershell.exe",
        args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
      },
    ];
  }

  if (platform === "linux") {
    if (appArgs.length > 0) {
      return [{ command: DESKTOP_LINUX_EXECUTABLE, args: appArgs }];
    }

    return [
      { command: "gtk-launch", args: [DESKTOP_LINUX_DESKTOP_ENTRY] },
      { command: DESKTOP_LINUX_EXECUTABLE, args: [] },
    ];
  }

  return [];
}

function openReleasesCommand(platform: Platform): DesktopLaunchCommand {
  if (platform === "darwin") {
    return { command: "open", args: [DESKTOP_RELEASES_URL] };
  }

  if (platform === "win32") {
    return {
      command: "powershell.exe",
      args: [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Start-Process ${JSON.stringify(DESKTOP_RELEASES_URL)}`,
      ],
    };
  }

  return { command: "xdg-open", args: [DESKTOP_RELEASES_URL] };
}

function commandLabel(command: string, args: ReadonlyArray<string>): string {
  return [command, ...args].join(" ");
}

const runDesktopCommand = (
  command: string,
  args: ReadonlyArray<string>,
): Effect.Effect<void, DesktopAppLaunchError, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const label = commandLabel(command, args);

    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner
          .spawn(
            ChildProcess.make(command, [...args], {
              env: process.env,
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new DesktopAppLaunchError({
                  command: label,
                  message: `Failed to run ${label}.`,
                  cause,
                }),
            ),
          );

        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

        const [, , code] = yield* Effect.all(
          [Stream.runDrain(child.stdout), Stream.runDrain(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopAppLaunchError({
                command: label,
                message: `Failed to collect result for ${label}.`,
                cause,
              }),
          ),
        );

        return code;
      }).pipe(
        Effect.timeoutOption(Duration.millis(10_000)),
        Effect.flatMap((result) =>
          Option.match(result, {
            onSome: Effect.succeed,
            onNone: () =>
              Effect.fail(
                new DesktopAppLaunchError({
                  command: label,
                  message: `${label} timed out.`,
                }),
              ),
          }),
        ),
      ),
    );

    if (exitCode !== 0) {
      return yield* new DesktopAppLaunchError({
        command: label,
        message: `${label} exited with code ${exitCode}.`,
        exitCode,
      });
    }
  });

const chooseFallback = (
  message: string,
): Effect.Effect<DesktopAppFallbackChoice, DesktopAppLaunchError, Prompt.Environment> =>
  Prompt.select({
    message,
    choices: desktopAppFallbackPromptChoices,
  }).pipe(
    Prompt.run,
    Effect.mapError(
      (cause) =>
        new DesktopAppLaunchError({
          command: "desktop fallback prompt",
          message: "Desktop fallback prompt was cancelled.",
          cause,
        }),
    ),
  );

function tryLaunchDesktopApp(
  platform: Platform,
  workspacePath: string | undefined,
): Effect.Effect<boolean, never, ChildProcessSpawner.ChildProcessSpawner> {
  return Effect.gen(function* () {
    for (const launchCommand of desktopAppLaunchCommands(platform, workspacePath)) {
      const launched = yield* runDesktopCommand(launchCommand.command, launchCommand.args).pipe(
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false)),
      );
      if (launched) {
        return true;
      }
    }

    return false;
  });
}

export function openDesktopAppOrPrompt(
  platform: Platform,
  workspacePath?: string,
): Effect.Effect<
  DesktopAppLaunchResult,
  DesktopAppLaunchError,
  ChildProcessSpawner.ChildProcessSpawner | Prompt.Environment
> {
  return Effect.gen(function* () {
    if (yield* tryLaunchDesktopApp(platform, workspacePath)) {
      yield* Console.log(`Opened ${DESKTOP_APP_NAME}.`);
      return { _tag: "opened-app" } satisfies DesktopAppLaunchResult;
    }

    const fallbackChoice = yield* chooseFallback(
      `${DESKTOP_APP_NAME} does not appear to be installed.`,
    );

    if (fallbackChoice === "use-web-ui") {
      yield* Console.log("Starting the web UI.");
      return { _tag: "use-web-ui" } satisfies DesktopAppLaunchResult;
    }

    if (fallbackChoice === "exit") {
      yield* Console.log(`Download ${DESKTOP_APP_NAME} from ${DESKTOP_RELEASES_URL}`);
      return { _tag: "exit" } satisfies DesktopAppLaunchResult;
    }

    const command = openReleasesCommand(platform);
    yield* runDesktopCommand(command.command, command.args);
    yield* Console.log(`Opened ${DESKTOP_RELEASES_URL}`);
    return { _tag: "opened-releases" } satisfies DesktopAppLaunchResult;
  });
}
