import { afterEach, describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { ThreadId } from "@t3tools/contracts";

import { makePerfProviderAdapter } from "./PerfProviderAdapter.ts";

const PERF_SCENARIO_ENV = "T3CODE_PERF_SCENARIO";

describe("PerfProviderAdapter", () => {
  const previousScenarioEnv = process.env[PERF_SCENARIO_ENV];

  afterEach(() => {
    if (previousScenarioEnv === undefined) {
      delete process.env[PERF_SCENARIO_ENV];
      return;
    }
    process.env[PERF_SCENARIO_ENV] = previousScenarioEnv;
  });

  it("emits canonical runtime events for the dense assistant stream scenario", async () => {
    process.env[PERF_SCENARIO_ENV] = "dense_assistant_stream";
    const adapter = await Effect.runPromise(makePerfProviderAdapter);
    const threadId = ThreadId.makeUnsafe("perf-adapter-test-thread");

    await Effect.runPromise(
      adapter.startSession({
        threadId,
        provider: "codex",
        runtimeMode: "full-access",
      }),
    );

    const firstEventsPromise = Effect.runPromise(
      Stream.runCollect(Stream.take(adapter.streamEvents, 4)),
    );
    await Effect.runPromise(
      adapter.sendTurn({
        threadId,
        input: "exercise the dense perf scenario",
        attachments: [],
      }),
    );

    const firstEvents = Array.from(await firstEventsPromise);
    expect(firstEvents.map((event) => event.type)).toEqual([
      "turn.started",
      "item.started",
      "content.delta",
      "item.completed",
    ]);
    expect(firstEvents.every((event) => event.threadId === threadId)).toBe(true);
    expect(
      firstEvents[2]?.type === "content.delta" ? firstEvents[2].payload.delta.length : 0,
    ).toBeGreaterThan(0);
  });
});
