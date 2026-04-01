import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { PerfThresholdProfile } from "./thresholds.ts";

export interface PerfActionDuration {
  readonly name: string;
  readonly durationMs: number;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export interface PerfLongTaskSample {
  readonly startTimeMs: number;
  readonly durationMs: number;
  readonly name: string;
}

export interface PerfMountedRowSample {
  readonly label: string;
  readonly count: number;
  readonly capturedAtMs: number;
}

export interface BrowserPerfMetrics {
  readonly actions: ReadonlyArray<PerfActionDuration>;
  readonly longTasks: ReadonlyArray<PerfLongTaskSample>;
  readonly rafGapsMs: ReadonlyArray<number>;
  readonly mountedRowSamples: ReadonlyArray<PerfMountedRowSample>;
}

export interface PerfServerMetricSample {
  readonly capturedAt: string;
  readonly cpuUserMicros?: number;
  readonly cpuSystemMicros?: number;
  readonly rssBytes?: number;
  readonly heapTotalBytes?: number;
  readonly heapUsedBytes?: number;
  readonly externalBytes?: number;
  readonly arrayBuffersBytes?: number;
}

export interface PerfArtifactSummary {
  readonly maxMountedTimelineRows: number;
  readonly threadSwitchP50Ms: number | null;
  readonly threadSwitchP95Ms: number | null;
  readonly maxLongTaskMs: number;
  readonly longTasksOver50Ms: number;
  readonly maxRafGapMs: number;
  readonly burstCompletionMs: number | null;
}

export interface PerfRunArtifact {
  readonly suite: string;
  readonly scenarioId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly thresholds: PerfThresholdProfile;
  readonly summary: PerfArtifactSummary;
  readonly browserMetrics: BrowserPerfMetrics;
  readonly serverMetrics: ReadonlyArray<PerfServerMetricSample> | null;
  readonly metadata?: Record<string, unknown>;
}

export function percentile(values: ReadonlyArray<number>, target: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = values.toSorted((left, right) => left - right);
  const clampedTarget = Math.min(Math.max(target, 0), 1);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * clampedTarget) - 1);
  return sorted[index] ?? null;
}

export function summarizeBrowserPerfMetrics(
  browserMetrics: BrowserPerfMetrics,
  options?: {
    readonly threadSwitchActionPrefix?: string;
    readonly burstActionName?: string;
  },
): PerfArtifactSummary {
  const threadSwitchActions = browserMetrics.actions
    .filter((action) =>
      options?.threadSwitchActionPrefix
        ? action.name.startsWith(options.threadSwitchActionPrefix)
        : action.name.startsWith("thread-switch"),
    )
    .map((action) => action.durationMs);
  const burstCompletionAction = browserMetrics.actions.find(
    (action) => action.name === (options?.burstActionName ?? "burst-completion"),
  );
  const maxMountedTimelineRows = browserMetrics.mountedRowSamples.reduce(
    (maxCount, sample) => Math.max(maxCount, sample.count),
    0,
  );
  const maxLongTaskMs = browserMetrics.longTasks.reduce(
    (maxDuration, sample) => Math.max(maxDuration, sample.durationMs),
    0,
  );
  const longTasksOver50Ms = browserMetrics.longTasks.filter(
    (sample) => sample.durationMs > 50,
  ).length;
  const maxRafGapMs = browserMetrics.rafGapsMs.reduce((maxGap, gap) => Math.max(maxGap, gap), 0);

  return {
    maxMountedTimelineRows,
    threadSwitchP50Ms: percentile(threadSwitchActions, 0.5),
    threadSwitchP95Ms: percentile(threadSwitchActions, 0.95),
    maxLongTaskMs,
    longTasksOver50Ms,
    maxRafGapMs,
    burstCompletionMs: burstCompletionAction?.durationMs ?? null,
  };
}

export async function writePerfArtifact(
  outputPath: string,
  artifact: PerfRunArtifact,
): Promise<void> {
  const resolvedOutputPath = resolve(outputPath);
  await mkdir(dirname(resolvedOutputPath), { recursive: true });
  await writeFile(`${resolvedOutputPath}`, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}
