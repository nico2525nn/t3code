import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteT3RunnerScript,
  issueRemotePairingToken,
  REMOTE_PICK_PORT_SCRIPT,
} from "./tunnel.ts";

const makeSuccessfulProcess = (stdout: string) => {
  const stdoutStream = Stream.make(new TextEncoder().encode(stdout));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: stdoutStream,
    stderr: Stream.empty,
    all: stdoutStream,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    unref: Effect.succeed(Effect.void),
  });
};

describe("ssh tunnel scripts", () => {
  it("builds the remote t3 runner with npx and npm fallbacks", () => {
    const script = buildRemoteT3RunnerScript();

    assert.include(script, 'exec t3 "$@"');
    assert.include(script, 'exec npx --yes t3@latest "$@"');
    assert.include(script, 'exec npm exec --yes t3@latest -- "$@"');
    assert.include(script, "could not install t3@latest");
  });

  it("uses the remote t3 runner for launch and pairing scripts", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;

    assert.include(
      buildRemoteLaunchScript(),
      '[ -n "$REMOTE_PID" ] && [ -n "$REMOTE_PORT" ] && kill -0 "$REMOTE_PID" 2>/dev/null',
    );
    assert.include(buildRemoteLaunchScript(), '"$RUNNER_FILE" serve --host 127.0.0.1');
    assert.include(buildRemoteLaunchScript({ packageSpec: "t3@nightly" }), "t3@nightly");
    assert.include(
      buildRemotePairingScript(target),
      '"$RUNNER_FILE" auth pairing create --base-dir "$SERVER_HOME" --json',
    );
    assert.include(buildRemotePairingScript(target, { packageSpec: "t3@nightly" }), "t3@nightly");
  });

  it("allows the remote port picker to run without a state file path", () => {
    assert.include(REMOTE_PICK_PORT_SCRIPT, 'const filePath = process.argv[2] ?? "";');
  });

  it.effect("accepts pretty-printed pairing JSON from the remote CLI", () => {
    const target = {
      alias: "devbox",
      hostname: "devbox.example.com",
      username: "julius",
      port: 2222,
    } as const;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        makeSuccessfulProcess(`{
  "id": "88941235-6ed5-4184-a2ff-5339e2075958",
  "credential": "LCL4R2TPHDKQ",
  "role": "client",
  "expiresAt": "2026-04-29T01:01:20.994Z"
}

`),
      ),
    );
    const spawnerLayer = Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner);
    const processLayer = Layer.merge(NodeServices.layer, spawnerLayer);
    return Effect.gen(function* () {
      const credential = yield* issueRemotePairingToken(target);
      assert.equal(credential, "LCL4R2TPHDKQ");
    }).pipe(Effect.provide(processLayer));
  });
});
