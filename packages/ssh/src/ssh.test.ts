import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  baseSshArgs,
  discoverSshHosts,
  getLastNonEmptyOutputLine,
  isSshAuthFailure,
  parseKnownHostsHostnames,
  parseSshResolveOutput,
  resolveRemoteT3CliPackageSpec,
  resolveSshConfigIncludePattern,
} from "./ssh.ts";

const tempDirectories: string[] = [];

function makeTempHomeDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "t3-ssh-test-"));
  tempDirectories.push(directory);
  return directory;
}

describe("ssh", () => {
  it.effect("discovers ssh config hosts across included files", () =>
    Effect.acquireUseRelease(
      Effect.sync(makeTempHomeDir),
      (homeDir) =>
        Effect.gen(function* () {
          const sshDir = Path.join(homeDir, ".ssh");
          FS.mkdirSync(Path.join(sshDir, "config.d"), { recursive: true });
          FS.writeFileSync(
            Path.join(sshDir, "config"),
            ["Host devbox", "  HostName devbox.example.com", "Include config.d/*.conf", ""].join(
              "\n",
            ),
            "utf8",
          );
          FS.writeFileSync(
            Path.join(sshDir, "config.d", "team.conf"),
            [
              "Host staging",
              "  HostName staging.example.com",
              "Host *",
              "  ServerAliveInterval 30",
              "",
            ].join("\n"),
            "utf8",
          );
          FS.writeFileSync(
            Path.join(sshDir, "known_hosts"),
            [
              "known.example.com ssh-ed25519 AAAA",
              "|1|hashed|entry ssh-ed25519 AAAA",
              "[bastion.example.com]:2222 ssh-ed25519 AAAA",
              "",
            ].join("\n"),
            "utf8",
          );

          const hosts = yield* discoverSshHosts({ homeDir });
          assert.deepEqual(hosts, [
            {
              alias: "bastion.example.com",
              hostname: "bastion.example.com",
              username: null,
              port: null,
              source: "known-hosts",
            },
            {
              alias: "devbox",
              hostname: "devbox",
              username: null,
              port: null,
              source: "ssh-config",
            },
            {
              alias: "known.example.com",
              hostname: "known.example.com",
              username: null,
              port: null,
              source: "known-hosts",
            },
            {
              alias: "staging",
              hostname: "staging",
              username: null,
              port: null,
              source: "ssh-config",
            },
          ]);
        }),
      (homeDir) => Effect.sync(() => FS.rmSync(homeDir, { recursive: true, force: true })),
    ),
  );

  it.effect("parses known_hosts entries without returning hashed hosts", () =>
    Effect.sync(() => {
      assert.deepEqual(
        parseKnownHostsHostnames(
          [
            "github.com ssh-ed25519 AAAA",
            "gitlab.com,gitlab-alias ssh-ed25519 BBBB",
            "|1|hashed|entry ssh-ed25519 CCCC",
            "@cert-authority *.example.com ssh-ed25519 DDDD",
            "[ssh.example.com]:2200 ssh-ed25519 EEEE",
            "port.example.com:22 ssh-ed25519 HHHH",
            "::1 ssh-ed25519 FFFF",
            "2001:db8::1 ssh-ed25519 GGGG",
            "",
          ].join("\n"),
        ),
        [
          "::1",
          "2001:db8::1",
          "github.com",
          "gitlab-alias",
          "gitlab.com",
          "port.example.com",
          "ssh.example.com",
        ],
      );
    }),
  );

  it.effect("expands tilde-prefixed ssh config include patterns", () =>
    Effect.sync(() => {
      assert.equal(
        resolveSshConfigIncludePattern("~/.ssh/config.d/*.conf", "/tmp/project", "/tmp/home"),
        "/tmp/home/.ssh/config.d/*.conf",
      );
    }),
  );

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

  it.effect("detects ssh auth failures from common permission denied messages", () =>
    Effect.sync(() => {
      assert.equal(
        isSshAuthFailure(
          new Error(
            "julius@100.65.180.100: Permission denied (publickey,password,keyboard-interactive).",
          ),
        ),
        true,
      );
      assert.equal(isSshAuthFailure(new Error("Permission denied (publickey).")), true);
      assert.equal(isSshAuthFailure(new Error("Connection timed out")), false);
      assert.equal(isSshAuthFailure(new Error("mkdir: Permission denied")), false);
    }),
  );
});
