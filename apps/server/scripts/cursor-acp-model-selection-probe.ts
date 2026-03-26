#!/usr/bin/env bun
/**
 * Standalone probe: spawn `agent acp`, send initialize → session/new, print results.
 *
 * Usage:
 *   bun apps/server/scripts/cursor-acp-model-selection-probe.ts [--cwd /path/to/dir]
 */
import { parseArgs } from "node:util";

import {
  attachAcpJsonRpcConnection,
  disposeAcpChild,
  spawnAcpChildProcess,
} from "../src/provider/acp/AcpJsonRpcConnection.ts";
import { Effect } from "effect";

const { values } = parseArgs({
  options: {
    cwd: { type: "string", default: process.cwd() },
  },
  strict: true,
});

const cwd = values.cwd!;

const program = Effect.gen(function* () {
  const child = yield* spawnAcpChildProcess({ command: "agent", args: ["acp"], cwd });

  try {
    const conn = yield* attachAcpJsonRpcConnection(child);

    console.log("→ initialize");
    const initResult = yield* conn.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: "cursor-acp-probe", version: "0.0.0" },
    });
    console.log("← initialize response:");
    console.log(JSON.stringify(initResult, null, 2));

    console.log("\n→ authenticate");
    const authResult = yield* conn.request("authenticate", { methodId: "cursor_login" });
    console.log("← authenticate response:");
    console.log(JSON.stringify(authResult, null, 2));

    console.log(`\n→ session/new (cwd: ${cwd})`);
    const sessionResult = yield* conn.request("session/new", {
      cwd,
      mcpServers: [],
    });
    console.log("← session/new response:");
    console.log(JSON.stringify(sessionResult, null, 2));
  } finally {
    disposeAcpChild(child);
  }
});

Effect.runPromise(program).catch((err) => {
  console.error("Probe failed:", err);
  process.exit(1);
});
