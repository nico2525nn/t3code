import * as path from "node:path";
import { fileURLToPath } from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import { describe, expect } from "vitest";

import { makeAcpSessionRuntime } from "./AcpSessionRuntime.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const bunExe = "bun";

describe("AcpSessionRuntime", () => {
  it.effect("starts a session, prompts, and emits normalized events against the mock agent", () =>
    Effect.gen(function* () {
      const runtime = yield* makeAcpSessionRuntime({
        spawn: {
          command: bunExe,
          args: [mockAgentPath],
        },
        cwd: process.cwd(),
        clientInfo: { name: "t3-test", version: "0.0.0" },
      });

      expect(runtime.initializeResult).toMatchObject({ protocolVersion: 1 });
      expect(runtime.sessionId).toBe("mock-session-1");

      const promptResult = yield* runtime.prompt({
        prompt: [{ type: "text", text: "hi" }],
      });
      expect(promptResult).toMatchObject({ stopReason: "end_turn" });

      const notes = Array.from(yield* Stream.runCollect(Stream.take(runtime.events, 2)));
      expect(notes).toHaveLength(2);
      expect(notes.map((note) => note._tag)).toEqual(["PlanUpdated", "ContentDelta"]);
      const planUpdate = notes.find((note) => note._tag === "PlanUpdated");
      expect(planUpdate?._tag).toBe("PlanUpdated");
      if (planUpdate?._tag === "PlanUpdated") {
        expect(planUpdate.payload.plan).toHaveLength(2);
      }

      yield* runtime.close;
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
