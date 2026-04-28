import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  baseSshArgs,
  getLastNonEmptyOutputLine,
  parseSshResolveOutput,
  resolveRemoteT3CliPackageSpec,
} from "./command.ts";

describe("ssh command", () => {
  it.effect("parses resolved ssh config output into a target", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseSshResolveOutput(
          "devbox",
          ["hostname devbox.example.com", "user julius", "port 2222", ""].join("\n"),
        ),
        {
          alias: "devbox",
          hostname: "devbox.example.com",
          username: "julius",
          port: 2222,
        },
      );
    }),
  );

  it.effect("builds interactive ssh args without forcing batch mode", () =>
    Effect.sync(() => {
      assert.deepEqual(
        baseSshArgs(
          {
            alias: "devbox",
            hostname: "devbox.example.com",
            username: "julius",
            port: 2222,
          },
          { batchMode: "no" },
        ),
        ["-o", "BatchMode=no", "-o", "ConnectTimeout=10", "-p", "2222"],
      );
    }),
  );

  it.effect("resolves the remote t3 package spec from the desktop release channel", () =>
    Effect.sync(() => {
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.17",
          updateChannel: "latest",
        }),
        "t3@0.0.17",
      );
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.17-nightly.20260415.44",
          updateChannel: "nightly",
        }),
        "t3@0.0.17-nightly.20260415.44",
      );
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.0-dev",
          updateChannel: "nightly",
          isDevelopment: true,
        }),
        "t3@nightly",
      );
      assert.equal(
        resolveRemoteT3CliPackageSpec({
          appVersion: "0.0.0-dev",
          updateChannel: "latest",
          isDevelopment: true,
        }),
        "t3@nightly",
      );
    }),
  );

  it.effect("reads the last non-empty ssh output line", () =>
    Effect.sync(() => {
      assert.equal(
        getLastNonEmptyOutputLine(
          ["Welcome to the host", "", '{"credential":"pairing-token"}', ""].join("\n"),
        ),
        '{"credential":"pairing-token"}',
      );
    }),
  );
});
