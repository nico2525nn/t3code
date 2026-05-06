import {
  Console,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Sink,
  Stream,
  Terminal,
} from "effect";
import { TestConsole } from "effect/testing";
import { describe, expect, it } from "@effect/vitest";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  DESKTOP_RELEASES_URL,
  desktopAppLaunchCommands,
  openDesktopAppOrPrompt,
} from "./desktopAppLauncher.ts";

const makeUserInput = (name: string): Terminal.UserInput => ({
  input: Option.some(name),
  key: { name, ctrl: false, meta: false, shift: false },
});

const makeTerminalLayer = (keys: ReadonlyArray<string>) =>
  Layer.effect(
    Terminal.Terminal,
    Effect.gen(function* () {
      const input = yield* Queue.unbounded<Terminal.UserInput>();
      yield* Queue.offerAll(input, keys.map(makeUserInput));

      return Terminal.make({
        columns: Effect.succeed(80),
        display: (text) => Console.log(text),
        readInput: Effect.succeed(Queue.asDequeue(input)),
        readLine: Effect.succeed(""),
      });
    }),
  );

const makeHandle = (exitCode: number) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

const makeSpawnerLayer = (
  calls: Array<{ command: string; args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.sync(() => {
        const standardCommand = command as ChildProcess.StandardCommand;
        calls.push({ command: standardCommand.command, args: standardCommand.args });
        return makeHandle(exitCodes[calls.length - 1] ?? 0);
      }),
    ),
  );

const makeTestLayer = (
  calls: Array<{ command: string; args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
  keys: ReadonlyArray<string> = [],
) =>
  Layer.mergeAll(
    TestConsole.layer,
    FileSystem.layerNoop({}),
    Path.layer,
    makeTerminalLayer(keys),
    makeSpawnerLayer(calls, exitCodes),
  );

describe("desktopAppLaunchCommands", () => {
  it("tries Alpha and Nightly app names on macOS", () => {
    expect(desktopAppLaunchCommands("darwin")).toEqual([
      { command: "open", args: ["-a", "T3 Code (Alpha)"] },
      { command: "open", args: ["-a", "T3 Code (Nightly)"] },
    ]);
  });

  it("passes the workspace path through macOS app launches", () => {
    expect(desktopAppLaunchCommands("darwin", "/repo/app")).toEqual([
      {
        command: "open",
        args: ["-a", "T3 Code (Alpha)", "--args", "--t3-open-path", "/repo/app"],
      },
      {
        command: "open",
        args: ["-a", "T3 Code (Nightly)", "--args", "--t3-open-path", "/repo/app"],
      },
    ]);
  });

  it("tries the Linux desktop entry before the executable", () => {
    expect(desktopAppLaunchCommands("linux")).toEqual([
      { command: "gtk-launch", args: ["t3code.desktop"] },
      { command: "t3code", args: [] },
    ]);
  });

  it("uses the Linux executable directly when passing a workspace path", () => {
    expect(desktopAppLaunchCommands("linux", "/repo/app")).toEqual([
      { command: "t3code", args: ["--t3-open-path", "/repo/app"] },
    ]);
  });
});

describe("openDesktopAppOrPrompt", () => {
  it.effect("opens the installed app without prompting for releases", () =>
    Effect.gen(function* () {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

      const result = yield* openDesktopAppOrPrompt("darwin", "/repo/app").pipe(
        Effect.provide(makeTestLayer(calls, [0])),
      );
      const logs = yield* TestConsole.logLines;

      expect(result).toEqual({ _tag: "opened-app" });
      expect(calls).toEqual([
        {
          command: "open",
          args: ["-a", "T3 Code (Alpha)", "--args", "--t3-open-path", "/repo/app"],
        },
      ]);
      expect(logs).toContain("Opened T3 Code.");
    }),
  );

  it.effect("opens Nightly when Alpha is not installed", () =>
    Effect.gen(function* () {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

      const result = yield* openDesktopAppOrPrompt("darwin").pipe(
        Effect.provide(makeTestLayer(calls, [1, 0])),
      );
      const logs = yield* TestConsole.logLines;

      expect(result).toEqual({ _tag: "opened-app" });
      expect(calls).toEqual([
        { command: "open", args: ["-a", "T3 Code (Alpha)"] },
        { command: "open", args: ["-a", "T3 Code (Nightly)"] },
      ]);
      expect(logs).toContain("Opened T3 Code.");
    }),
  );

  it.effect("prompts and opens GitHub releases when app launch fails", () =>
    Effect.gen(function* () {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

      const result = yield* openDesktopAppOrPrompt("darwin").pipe(
        Effect.provide(makeTestLayer(calls, [1, 1, 0], ["enter"])),
      );
      const logs = yield* TestConsole.logLines;

      expect(result).toEqual({ _tag: "opened-releases" });
      expect(calls).toEqual([
        { command: "open", args: ["-a", "T3 Code (Alpha)"] },
        { command: "open", args: ["-a", "T3 Code (Nightly)"] },
        { command: "open", args: [DESKTOP_RELEASES_URL] },
      ]);
      expect(logs.some((line) => String(line).includes("Yes, open github"))).toBe(true);
      expect(logs).toContain(`Opened ${DESKTOP_RELEASES_URL}`);
    }),
  );

  it.effect("returns use-web-ui without opening releases when selected", () =>
    Effect.gen(function* () {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

      const result = yield* openDesktopAppOrPrompt("darwin").pipe(
        Effect.provide(makeTestLayer(calls, [1, 1], ["down", "enter"])),
      );
      const logs = yield* TestConsole.logLines;

      expect(result).toEqual({ _tag: "use-web-ui" });
      expect(calls).toEqual([
        { command: "open", args: ["-a", "T3 Code (Alpha)"] },
        { command: "open", args: ["-a", "T3 Code (Nightly)"] },
      ]);
      expect(logs).toContain("Starting the web UI.");
    }),
  );

  it.effect("prints the releases URL without opening a browser when exiting", () =>
    Effect.gen(function* () {
      const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];

      const result = yield* openDesktopAppOrPrompt("darwin").pipe(
        Effect.provide(makeTestLayer(calls, [1, 1], ["down", "down", "enter"])),
      );
      const logs = yield* TestConsole.logLines;

      expect(result).toEqual({ _tag: "exit" });
      expect(calls).toEqual([
        { command: "open", args: ["-a", "T3 Code (Alpha)"] },
        { command: "open", args: ["-a", "T3 Code (Nightly)"] },
      ]);
      expect(logs).toContain(`Download T3 Code from ${DESKTOP_RELEASES_URL}`);
    }),
  );
});
