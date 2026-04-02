import { seedPerfState } from "../integration/perf/seedPerfState.ts";

const PERF_SEED_JSON_START = "__T3_PERF_SEED_JSON_START__";
const PERF_SEED_JSON_END = "__T3_PERF_SEED_JSON_END__";
const scenarioId = process.argv[2];

if (scenarioId !== "large_threads" && scenarioId !== "burst_base") {
  console.error(`Expected a perf seed scenario id, received '${scenarioId ?? "<missing>"}'.`);
  process.exit(1);
}

const seeded = await seedPerfState(scenarioId);
const payload = JSON.stringify(
  {
    scenarioId: seeded.scenarioId,
    runParentDir: seeded.runParentDir,
    baseDir: seeded.baseDir,
    workspaceRoot: seeded.workspaceRoot,
    projectTitle: seeded.snapshot.projects[0]?.title ?? null,
    threadSummaries: seeded.snapshot.threads.map((thread) => ({
      id: thread.id,
      title: thread.title,
      messageCount: thread.messages.length,
      activityCount: thread.activities.length,
      proposedPlanCount: thread.proposedPlans.length,
      checkpointCount: thread.checkpoints.length,
    })),
  },
  null,
  2,
);
process.stdout.write(`${PERF_SEED_JSON_START}\n${payload}\n${PERF_SEED_JSON_END}\n`);
