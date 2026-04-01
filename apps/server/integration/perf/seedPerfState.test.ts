import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PERF_CATALOG_IDS } from "@t3tools/shared/perf/scenarioCatalog";
import { seedPerfState } from "./seedPerfState.ts";

describe("seedPerfState", () => {
  const baseDirsToCleanup: string[] = [];

  afterEach(async () => {
    await Promise.all(
      baseDirsToCleanup.splice(0).map((baseDir) => rm(baseDir, { recursive: true, force: true })),
    );
  });

  it("seeds large thread fixtures through the real event store and projection pipeline", async () => {
    const seeded = await seedPerfState("large_threads");
    baseDirsToCleanup.push(seeded.baseDir);

    expect(seeded.snapshot.projects).toHaveLength(1);
    expect(seeded.snapshot.threads).toHaveLength(12);

    const heavyThread = seeded.snapshot.threads.find(
      (thread) => thread.id === PERF_CATALOG_IDS.largeThreads.heavyAThreadId,
    );
    expect(heavyThread?.messages).toHaveLength(2_000);
    expect((heavyThread?.activities.length ?? 0) > 0).toBe(true);
    expect((heavyThread?.proposedPlans.length ?? 0) > 0).toBe(true);
    expect((heavyThread?.checkpoints.length ?? 0) > 0).toBe(true);
  });

  it("enables assistant streaming in the burst base seed for websocket perf runs", async () => {
    const seeded = await seedPerfState("burst_base");
    baseDirsToCleanup.push(seeded.baseDir);

    const rawSettings = await readFile(join(seeded.baseDir, "userdata/settings.json"), "utf8");
    expect(JSON.parse(rawSettings)).toMatchObject({
      enableAssistantStreaming: true,
    });
  });
});
