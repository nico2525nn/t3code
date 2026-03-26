/**
 * Optional integration check against a real `agent acp` install.
 * Enable with: T3_CURSOR_ACP_PROBE=1 bun run test --filter CursorAcpCliProbe
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import { makeAcpJsonRpcConnection } from "./AcpJsonRpcConnection.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe.runIf(process.env.T3_CURSOR_ACP_PROBE === "1")("Cursor ACP CLI probe", () => {
  it.effect("initialize and authenticate against real agent acp", () =>
    Effect.gen(function* () {
      const conn = yield* makeAcpJsonRpcConnection({
        command: "agent",
        args: ["acp"],
        cwd: process.cwd(),
      });

      const init = yield* conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: "t3-probe", version: "0.0.0" },
      });
      expect(init).toBeDefined();

      yield* conn.request("authenticate", { methodId: "cursor_login" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/new returns configOptions with a model selector", () =>
    Effect.gen(function* () {
      const conn = yield* makeAcpJsonRpcConnection({
        command: "agent",
        args: ["acp"],
        cwd: process.cwd(),
      });

      yield* conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-probe", version: "0.0.0" },
      });
      yield* conn.request("authenticate", { methodId: "cursor_login" });

      const result = yield* conn.request("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      });

      expect(isRecord(result)).toBe(true);
      const r = result as Record<string, unknown>;
      expect(typeof r.sessionId).toBe("string");

      const configOptions = r.configOptions;
      console.log("session/new configOptions:", JSON.stringify(configOptions, null, 2));

      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find(
          (opt: unknown) => isRecord(opt) && opt.category === "model",
        );
        console.log("Model config option:", JSON.stringify(modelConfig, null, 2));
        expect(modelConfig).toBeDefined();
        expect(isRecord(modelConfig) && typeof modelConfig.id === "string").toBe(true);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("session/set_config_option switches the model in-session", () =>
    Effect.gen(function* () {
      const conn = yield* makeAcpJsonRpcConnection({
        command: "agent",
        args: ["acp"],
        cwd: process.cwd(),
      });

      yield* conn.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "t3-probe", version: "0.0.0" },
      });
      yield* conn.request("authenticate", { methodId: "cursor_login" });

      const newResult = (yield* conn.request("session/new", {
        cwd: process.cwd(),
        mcpServers: [],
      })) as Record<string, unknown>;
      const sessionId = newResult.sessionId as string;

      const configOptions = newResult.configOptions;
      let modelConfigId = "model";
      if (Array.isArray(configOptions)) {
        const modelConfig = configOptions.find(
          (opt: unknown) => isRecord(opt) && opt.category === "model",
        );
        if (isRecord(modelConfig) && typeof modelConfig.id === "string") {
          modelConfigId = modelConfig.id;
        }
      }

      const setResult = yield* conn.request("session/set_config_option", {
        sessionId,
        configId: modelConfigId,
        value: "composer-2",
      });

      console.log("session/set_config_option result:", JSON.stringify(setResult, null, 2));

      expect(isRecord(setResult)).toBe(true);
      const sr = setResult as Record<string, unknown>;
      if (Array.isArray(sr.configOptions)) {
        const modelConfig = sr.configOptions.find(
          (opt: unknown) => isRecord(opt) && opt.category === "model",
        );
        if (isRecord(modelConfig)) {
          expect(modelConfig.currentValue).toBe("composer-2");
        }
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
