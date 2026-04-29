import { assert, describe, it } from "@effect/vitest";

import {
  buildRemoteLaunchScript,
  buildRemotePairingScript,
  buildRemoteT3RunnerScript,
  REMOTE_PICK_PORT_SCRIPT,
} from "./tunnel.ts";

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
});
