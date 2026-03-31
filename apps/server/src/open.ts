/**
 * Open - Browser/editor launch service interface.
 *
 * Owns process launch helpers for opening URLs in a browser, workspace paths in
 * a configured editor, and generic external targets through the platform's
 * default opener.
 *
 * @module Open
 */
import os from "node:os";

import { EDITORS, type EditorId } from "@t3tools/contracts";
import { Effect, Exit, FileSystem, Layer, Option, Path, Schema, Scope, ServiceMap } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

export class OpenError extends Schema.TaggedErrorClass<OpenError>()("OpenError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

export interface OpenInEditorInput {
  readonly cwd: string;
  readonly editor: EditorId;
}

export interface OpenApplicationInput {
  readonly name: string | ReadonlyArray<string>;
  readonly arguments?: ReadonlyArray<string>;
}

export interface OpenExternalInput {
  readonly target: string;
  readonly wait?: boolean;
  readonly background?: boolean;
  readonly newInstance?: boolean;
  readonly allowNonzeroExitCode?: boolean;
  readonly app?: OpenApplicationInput | ReadonlyArray<OpenApplicationInput>;
}

export interface OpenRuntimeOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly isWsl?: boolean;
  readonly isInsideContainer?: boolean;
  readonly powerShellCommand?: string;
}

interface OpenRuntime {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly isWsl: boolean;
  readonly isInsideContainer: boolean;
  readonly powerShellCandidates: ReadonlyArray<string>;
  readonly windowsPathExtensions: ReadonlyArray<string>;
}

interface LaunchPlan {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly wait: boolean;
  readonly allowNonzeroExitCode: boolean;
  readonly detached?: boolean;
  readonly shell?: boolean;
  readonly stdio?: "ignore";
}

interface ResolvedCommand {
  readonly path: string;
  readonly usesCmdWrapper: boolean;
}

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const WINDOWS_POWERSHELL_CANDIDATES = ["powershell.exe", "powershell", "pwsh.exe", "pwsh"] as const;
const WSL_POWERSHELL_CANDIDATES = [
  "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
  "/mnt/c/Program Files/PowerShell/7/pwsh.exe",
  "powershell.exe",
  "pwsh.exe",
] as const;
const WINDOWS_BATCH_EXTENSIONS = [".CMD", ".BAT"] as const;

function shouldUseGotoFlag(editor: (typeof EDITORS)[number], target: string): boolean {
  return editor.supportsGoto && LINE_COLUMN_SUFFIX_PATTERN.test(target);
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^"+|"+$/g, "");
}

function resolvePathEnvironmentVariable(env: NodeJS.ProcessEnv): string {
  return env.PATH ?? env.Path ?? env.path ?? "";
}

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];
  if (!rawValue) return fallback;

  const parsed = rawValue
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => (entry.startsWith(".") ? entry.toUpperCase() : `.${entry.toUpperCase()}`));

  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveWindowsCommandShell(env: NodeJS.ProcessEnv): string {
  return env.ComSpec ?? env.COMSPEC ?? "cmd.exe";
}

function resolveCommandCandidates(
  command: string,
  runtime: OpenRuntime,
  pathService: Path.Path,
): ReadonlyArray<string> {
  if (runtime.platform !== "win32") return [command];
  const extension = pathService.extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && runtime.windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);
    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];
  for (const extensionName of runtime.windowsPathExtensions) {
    candidates.push(`${command}${extensionName}`);
    candidates.push(`${command}${extensionName.toLowerCase()}`);
  }
  return Array.from(new Set(candidates));
}

function resolvePathDelimiter(platform: NodeJS.Platform): string {
  return platform === "win32" ? ";" : ":";
}

function detectWsl(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  if (platform !== "linux") return false;
  if (typeof env.WSL_DISTRO_NAME === "string" || typeof env.WSL_INTEROP === "string") {
    return true;
  }
  return os.release().toLowerCase().includes("microsoft");
}

function quotePowerShellValue(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

function normalizeAppCandidates(
  app: OpenExternalInput["app"],
): ReadonlyArray<{ readonly name: string; readonly arguments: ReadonlyArray<string> } | undefined> {
  if (!app) return [undefined];

  const apps = Array.isArray(app) ? app : [app];
  const candidates: Array<{ readonly name: string; readonly arguments: ReadonlyArray<string> }> =
    [];

  for (const appDef of apps) {
    const names = Array.isArray(appDef.name) ? appDef.name : [appDef.name];
    for (const name of names) {
      candidates.push({ name, arguments: appDef.arguments ?? [] });
    }
  }

  return candidates;
}

function isUriLikeTarget(target: string): boolean {
  return /^[A-Za-z][A-Za-z\d+.-]*:/.test(target);
}

function shouldPreferWindowsOpenerOnWsl(input: OpenExternalInput, runtime: OpenRuntime): boolean {
  return runtime.isWsl && !runtime.isInsideContainer && isUriLikeTarget(input.target);
}

function makeLaunchPlan(
  runtime: OpenRuntime,
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly wait: boolean;
    readonly allowNonzeroExitCode: boolean;
    readonly detached?: boolean;
    readonly shell?: boolean;
    readonly stdio?: "ignore";
  },
): LaunchPlan {
  return {
    command,
    args,
    wait: options.wait,
    allowNonzeroExitCode: options.allowNonzeroExitCode,
    shell: options.shell ?? false,
    ...(options.detached !== undefined ? { detached: options.detached } : {}),
    ...(options.stdio !== undefined ? { stdio: options.stdio } : {}),
  };
}

function makeDarwinDefaultPlan(input: OpenExternalInput, runtime: OpenRuntime): LaunchPlan {
  const args: string[] = [];
  const wait = input.wait ?? false;

  if (wait) args.push("--wait-apps");
  if (input.background) args.push("--background");
  if (input.newInstance) args.push("--new");
  args.push(input.target);

  return makeLaunchPlan(runtime, "open", args, {
    wait,
    allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
    shell: false,
  });
}

function makeDarwinApplicationPlan(
  input: OpenExternalInput,
  app: { readonly name: string; readonly arguments: ReadonlyArray<string> },
  runtime: OpenRuntime,
): LaunchPlan {
  const args: string[] = [];
  const wait = input.wait ?? false;

  if (wait) args.push("--wait-apps");
  if (input.background) args.push("--background");
  if (input.newInstance) args.push("--new");
  args.push("-a", app.name);
  args.push(input.target);
  if (app.arguments.length > 0) {
    args.push("--args", ...app.arguments);
  }

  return makeLaunchPlan(runtime, "open", args, {
    wait,
    allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
    shell: false,
  });
}

function makePowerShellPlan(
  input: OpenExternalInput,
  runtime: OpenRuntime,
  powerShellCommand: string,
): LaunchPlan {
  const encodedParts = ["Start"];
  const wait = input.wait ?? false;

  if (wait) encodedParts.push("-Wait");
  encodedParts.push(quotePowerShellValue(input.target));

  return makeLaunchPlan(
    runtime,
    powerShellCommand,
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      encodePowerShellCommand(encodedParts.join(" ")),
    ],
    {
      wait,
      allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
      shell: false,
    },
  );
}

function makeLinuxDefaultPlan(input: OpenExternalInput, runtime: OpenRuntime): LaunchPlan {
  const wait = input.wait ?? false;
  return makeLaunchPlan(runtime, "xdg-open", [input.target], {
    wait,
    allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
    detached: !wait,
    ...(wait ? {} : { stdio: "ignore" as const }),
    shell: false,
  });
}

function makeWindowsExplorerPlan(input: OpenExternalInput, runtime: OpenRuntime): LaunchPlan {
  return makeLaunchPlan(runtime, "explorer", [input.target], {
    wait: false,
    allowNonzeroExitCode: false,
    shell: false,
  });
}

function makeDirectApplicationPlan(
  input: OpenExternalInput,
  app: { readonly name: string; readonly arguments: ReadonlyArray<string> },
  runtime: OpenRuntime,
): LaunchPlan {
  return makeLaunchPlan(runtime, app.name, [...app.arguments, input.target], {
    wait: input.wait ?? false,
    allowNonzeroExitCode: input.allowNonzeroExitCode ?? false,
    shell: false,
  });
}

function resolveExternalPlans(
  input: OpenExternalInput,
  runtime: OpenRuntime,
): ReadonlyArray<LaunchPlan> {
  const appCandidates = normalizeAppCandidates(input.app);
  const plans: LaunchPlan[] = [];
  const preferWindowsOpenerOnWsl = shouldPreferWindowsOpenerOnWsl(input, runtime);

  for (const app of appCandidates) {
    if (app) {
      if (runtime.platform === "darwin") {
        plans.push(makeDarwinApplicationPlan(input, app, runtime));
      } else {
        plans.push(makeDirectApplicationPlan(input, app, runtime));
      }
      continue;
    }

    if (runtime.platform === "darwin") {
      plans.push(makeDarwinDefaultPlan(input, runtime));
      continue;
    }

    if (runtime.platform === "win32" || preferWindowsOpenerOnWsl) {
      for (const powerShellCommand of runtime.powerShellCandidates) {
        plans.push(makePowerShellPlan(input, runtime, powerShellCommand));
      }
    }

    if (runtime.platform === "win32") {
      if (!(input.wait ?? false)) {
        plans.push(makeWindowsExplorerPlan(input, runtime));
      }
      continue;
    }

    plans.push(makeLinuxDefaultPlan(input, runtime));
  }

  return plans;
}

function toOpenError(message: string, cause: unknown): OpenError {
  return new OpenError({ message, cause });
}

function isWindowsBatchShim(pathService: Path.Path, filePath: string): boolean {
  return WINDOWS_BATCH_EXTENSIONS.includes(pathService.extname(filePath).toUpperCase() as never);
}

function quoteForWindowsCmd(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll('"', '""')}"`;
}

function makeWindowsCmdCommandLine(commandPath: string, args: ReadonlyArray<string>): string {
  return `"${[commandPath, ...args].map(quoteForWindowsCmd).join(" ")}"`;
}

export interface OpenShape {
  readonly getAvailableEditors: Effect.Effect<ReadonlyArray<EditorId>, OpenError>;
  readonly openExternal: (input: OpenExternalInput) => Effect.Effect<void, OpenError>;
  readonly openBrowser: (
    target: string,
    options?: Omit<OpenExternalInput, "target">,
  ) => Effect.Effect<void, OpenError>;
  readonly openInEditor: (input: OpenInEditorInput) => Effect.Effect<void, OpenError>;
}

export class Open extends ServiceMap.Service<Open, OpenShape>()("t3/open") {}

const makeOpen = (options: OpenRuntimeOptions = {}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const pathService = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const isInsideContainer =
      options.isInsideContainer ??
      (typeof options.env?.CONTAINER === "string" ||
      typeof options.env?.container === "string" ||
      typeof options.env?.KUBERNETES_SERVICE_HOST === "string"
        ? true
        : yield* fileSystem.exists("/.dockerenv").pipe(Effect.catch(() => Effect.succeed(false))));

    const runtime: OpenRuntime = {
      platform: options.platform ?? process.platform,
      env: options.env ?? process.env,
      isWsl:
        options.isWsl ??
        detectWsl(options.platform ?? process.platform, options.env ?? process.env),
      isInsideContainer,
      powerShellCandidates:
        options.powerShellCommand !== undefined
          ? [options.powerShellCommand]
          : (options.isWsl ??
              detectWsl(options.platform ?? process.platform, options.env ?? process.env))
            ? WSL_POWERSHELL_CANDIDATES
            : WINDOWS_POWERSHELL_CANDIDATES,
      windowsPathExtensions: resolveWindowsPathExtensions(options.env ?? process.env),
    };

    const resolveCommand = Effect.fn(function* (
      command: string,
    ): Effect.fn.Return<Option.Option<ResolvedCommand>, never> {
      const candidates = resolveCommandCandidates(command, runtime, pathService);

      const resolveExecutableFile = Effect.fn(function* (
        filePath: string,
      ): Effect.fn.Return<Option.Option<ResolvedCommand>, never> {
        const info = yield* fileSystem.stat(filePath).pipe(Effect.option);
        if (Option.isNone(info) || info.value.type !== "File") return Option.none();

        if (runtime.platform === "win32") {
          const extension = pathService.extname(filePath);
          if (
            extension.length === 0 ||
            !runtime.windowsPathExtensions.includes(extension.toUpperCase())
          ) {
            return Option.none();
          }

          return Option.some({
            path: filePath,
            usesCmdWrapper: isWindowsBatchShim(pathService, filePath),
          } satisfies ResolvedCommand);
        }

        return (info.value.mode & 0o111) !== 0
          ? Option.some({
              path: filePath,
              usesCmdWrapper: false,
            } satisfies ResolvedCommand)
          : Option.none();
      });

      if (command.includes("/") || command.includes("\\")) {
        for (const candidate of candidates) {
          const resolved = yield* resolveExecutableFile(candidate);
          if (Option.isSome(resolved)) return resolved;
        }
        return Option.none();
      }

      const pathValue = resolvePathEnvironmentVariable(runtime.env);
      if (pathValue.length === 0) return Option.none();

      const pathEntries = pathValue
        .split(resolvePathDelimiter(runtime.platform))
        .map((entry) => stripWrappingQuotes(entry.trim()))
        .filter((entry) => entry.length > 0);

      for (const pathEntry of pathEntries) {
        for (const candidate of candidates) {
          const resolved = yield* resolveExecutableFile(pathService.join(pathEntry, candidate));
          if (Option.isSome(resolved)) {
            return resolved;
          }
        }
      }

      return Option.none();
    });

    const commandAvailable = (command: string) =>
      resolveCommand(command).pipe(Effect.map(Option.isSome));

    const fileManagerAvailable = Effect.gen(function* () {
      const candidates =
        runtime.platform === "darwin"
          ? ["open"]
          : runtime.platform === "win32"
            ? [...runtime.powerShellCandidates, "explorer"]
            : ["xdg-open"];

      for (const candidate of candidates) {
        if (yield* commandAvailable(candidate)) {
          return true;
        }
      }

      return false;
    });

    const getAvailableEditors = Effect.gen(function* () {
      const available: EditorId[] = [];

      for (const editor of EDITORS) {
        if (editor.id === "file-manager") {
          if (yield* fileManagerAvailable) {
            available.push(editor.id);
          }
          continue;
        }

        if (editor.command && (yield* commandAvailable(editor.command))) {
          available.push(editor.id);
        }
      }

      return available as ReadonlyArray<EditorId>;
    }).pipe(Effect.mapError((cause) => toOpenError("Failed to resolve available editors", cause)));

    const spawnPlan = (
      plan: LaunchPlan,
      resolvedCommand: ResolvedCommand,
      failureMessage: string,
    ) =>
      spawner
        .spawn(
          ChildProcess.make(
            resolvedCommand.usesCmdWrapper
              ? resolveWindowsCommandShell(runtime.env)
              : resolvedCommand.path,
            resolvedCommand.usesCmdWrapper
              ? [
                  "/d",
                  "/v:off",
                  "/s",
                  "/c",
                  makeWindowsCmdCommandLine(resolvedCommand.path, plan.args),
                ]
              : [...plan.args],
            {
              detached: plan.detached,
              shell: plan.shell,
              ...(plan.stdio === "ignore"
                ? {
                    stdin: "ignore",
                    stdout: "ignore",
                    stderr: "ignore",
                  }
                : {}),
            },
          ),
        )
        .pipe(Effect.mapError((cause) => toOpenError(failureMessage, cause)));

    const waitForExit = (
      plan: LaunchPlan,
      failureMessage: string,
      handle: ChildProcessSpawner.ChildProcessHandle,
    ) =>
      handle.exitCode.pipe(
        Effect.flatMap((exitCode) =>
          !plan.allowNonzeroExitCode && (exitCode as number) !== 0
            ? Effect.fail(
                new OpenError({
                  message: `${failureMessage} (code=${exitCode as number})`,
                }),
              )
            : Effect.void,
        ),
        Effect.mapError((cause) => toOpenError(failureMessage, cause)),
      );

    const runWaitedPlan = (
      plan: LaunchPlan,
      resolvedCommand: ResolvedCommand,
      failureMessage: string,
    ) =>
      Effect.acquireUseRelease(
        Scope.make("sequential"),
        (scope) =>
          Effect.gen(function* () {
            const handle = yield* spawnPlan(plan, resolvedCommand, failureMessage).pipe(
              Scope.provide(scope),
            );
            yield* waitForExit(plan, failureMessage, handle);
          }),
        (scope) => Scope.close(scope, Exit.void),
      );

    const runDetachedPlan = (
      plan: LaunchPlan,
      resolvedCommand: ResolvedCommand,
      failureMessage: string,
    ) =>
      Effect.gen(function* () {
        const childScope = yield* Scope.make("sequential");
        const handle = yield* spawnPlan(plan, resolvedCommand, failureMessage).pipe(
          Scope.provide(childScope),
          Effect.catch((error) =>
            Scope.close(childScope, Exit.void).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );

        const releaseOnExit: Effect.Effect<void, never> = handle.exitCode.pipe(
          Effect.ignoreCause,
          Effect.ensuring(Scope.close(childScope, Exit.void)),
        );

        yield* Effect.forkDetach(releaseOnExit);
      });

    const runPlan = (plan: LaunchPlan, resolvedCommand: ResolvedCommand, failureMessage: string) =>
      plan.wait
        ? runWaitedPlan(plan, resolvedCommand, failureMessage)
        : runDetachedPlan(plan, resolvedCommand, failureMessage);

    const runFirstAvailablePlan = (
      plans: ReadonlyArray<LaunchPlan>,
      failureMessage: string,
    ): Effect.Effect<void, OpenError> => {
      const [first, ...rest] = plans;
      if (!first) {
        return Effect.fail(new OpenError({ message: failureMessage }));
      }

      return resolveCommand(first.command).pipe(
        Effect.flatMap((resolvedCommand) => {
          if (Option.isNone(resolvedCommand)) {
            return rest.length === 0
              ? Effect.fail(new OpenError({ message: `Command not found: ${first.command}` }))
              : runFirstAvailablePlan(rest, failureMessage);
          }

          return runPlan(first, resolvedCommand.value, failureMessage).pipe(
            Effect.catch((error) =>
              rest.length === 0 ? Effect.fail(error) : runFirstAvailablePlan(rest, failureMessage),
            ),
          );
        }),
      );
    };

    const openExternal = (input: OpenExternalInput) => {
      if (input.target.trim().length === 0) {
        return Effect.fail(new OpenError({ message: "Open target must not be empty" }));
      }

      return runFirstAvailablePlan(
        resolveExternalPlans(input, runtime),
        `Failed to open ${input.target}`,
      );
    };

    const openInEditor = (input: OpenInEditorInput) => {
      const editor = EDITORS.find((candidate) => candidate.id === input.editor);
      if (!editor) {
        return Effect.fail(new OpenError({ message: `Unknown editor: ${input.editor}` }));
      }

      if (editor.command) {
        return runFirstAvailablePlan(
          [
            makeLaunchPlan(
              runtime,
              editor.command,
              shouldUseGotoFlag(editor, input.cwd) ? ["--goto", input.cwd] : [input.cwd],
              {
                wait: false,
                allowNonzeroExitCode: false,
                detached: true,
                stdio: "ignore",
                shell: false,
              },
            ),
          ],
          `Failed to open ${input.cwd} in ${input.editor}`,
        );
      }

      return openExternal({ target: input.cwd });
    };

    return {
      getAvailableEditors,
      openExternal,
      openBrowser: (target, openOptions = {}) => openExternal({ ...openOptions, target }),
      openInEditor,
    } satisfies OpenShape;
  });

export const makeOpenLayer = (options: OpenRuntimeOptions = {}) =>
  Layer.effect(Open, makeOpen(options));

export const OpenLive = makeOpenLayer();
