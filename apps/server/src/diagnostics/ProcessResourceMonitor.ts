import type {
  ServerProcessResourceHistoryBucket,
  ServerProcessResourceHistoryInput,
  ServerProcessResourceHistoryResult,
  ServerProcessResourceHistorySummary,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  buildDescendantEntries,
  isDiagnosticsQueryProcess,
  type ProcessRow,
  readProcessRows,
} from "./ProcessDiagnostics.ts";

const SAMPLE_INTERVAL = Duration.seconds(5);
const RETENTION = Duration.minutes(60);
const MIN_HISTORY_DURATION = Duration.seconds(1);
const SAMPLE_INTERVAL_MS = Duration.toMillis(SAMPLE_INTERVAL);
const RETENTION_MS = Duration.toMillis(RETENTION);
const MAX_RETAINED_SAMPLES = 20_000;

export interface ProcessResourceSample {
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
  readonly processKey: string;
  readonly pid: number;
  readonly ppid: number;
  readonly command: string;
  readonly cpuPercent: number;
  readonly rssBytes: number;
  readonly depth: number;
  readonly isServerRoot: boolean;
}

interface MonitorState {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly lastError: Option.Option<string>;
}

export interface ProcessResourceMonitorShape {
  readonly readHistory: (
    input: ServerProcessResourceHistoryInput,
  ) => Effect.Effect<ServerProcessResourceHistoryResult>;
}

export class ProcessResourceMonitor extends Context.Service<
  ProcessResourceMonitor,
  ProcessResourceMonitorShape
>()("t3/diagnostics/ProcessResourceMonitor") {}

function dateTimeFromMillis(ms: number): DateTime.Utc {
  return DateTime.makeUnsafe(ms);
}

function sampleKey(row: Pick<ProcessRow, "pid" | "command">): string {
  return `${row.pid}:${row.command}`;
}

function findServerRootRow(
  rows: ReadonlyArray<ProcessRow>,
  serverPid: number,
): Option.Option<ProcessRow> {
  return Option.fromUndefinedOr(rows.find((row) => row.pid === serverPid));
}

export function collectMonitoredSamples(input: {
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly serverPid: number;
  readonly sampledAt: DateTime.Utc;
  readonly sampledAtMs: number;
}): ReadonlyArray<ProcessResourceSample> {
  const rows = input.rows.filter((row) => !isDiagnosticsQueryProcess(row, input.serverPid));
  const root = findServerRootRow(rows, input.serverPid);
  const descendants = buildDescendantEntries(rows, input.serverPid);
  const samples: ProcessResourceSample[] = [];

  if (Option.isSome(root)) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(root.value),
      pid: root.value.pid,
      ppid: root.value.ppid,
      command: root.value.command,
      cpuPercent: root.value.cpuPercent,
      rssBytes: root.value.rssBytes,
      depth: 0,
      isServerRoot: true,
    });
  }

  for (const process of descendants) {
    samples.push({
      sampledAt: input.sampledAt,
      sampledAtMs: input.sampledAtMs,
      processKey: sampleKey(process),
      pid: process.pid,
      ppid: process.ppid,
      command: process.command,
      cpuPercent: process.cpuPercent,
      rssBytes: process.rssBytes,
      depth: process.depth + 1,
      isServerRoot: false,
    });
  }

  return samples;
}

function trimSamples(
  samples: ReadonlyArray<ProcessResourceSample>,
  nowMs: number,
): ReadonlyArray<ProcessResourceSample> {
  const minSampledAtMs = nowMs - RETENTION_MS;
  const retained = samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  return retained.length <= MAX_RETAINED_SAMPLES
    ? retained
    : retained.slice(retained.length - MAX_RETAINED_SAMPLES);
}

function summarizeProcesses(
  samples: ReadonlyArray<ProcessResourceSample>,
): ReadonlyArray<ServerProcessResourceHistorySummary> {
  const groups = new Map<string, ProcessResourceSample[]>();
  for (const sample of samples) {
    const processSamples = groups.get(sample.processKey) ?? [];
    processSamples.push(sample);
    groups.set(sample.processKey, processSamples);
  }

  return [...groups.entries()]
    .map(([processKey, processSamples]) => {
      const sorted = processSamples.toSorted((left, right) => left.sampledAtMs - right.sampledAtMs);
      const first = sorted[0]!;
      const latest = sorted[sorted.length - 1]!;
      const cpuPercentTotal = sorted.reduce((total, sample) => total + sample.cpuPercent, 0);
      const maxCpuPercent = Math.max(...sorted.map((sample) => sample.cpuPercent));
      const maxRssBytes = Math.max(...sorted.map((sample) => sample.rssBytes));
      const cpuSecondsApprox = sorted.reduce(
        (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
        0,
      );

      return {
        processKey,
        pid: latest.pid,
        ppid: latest.ppid,
        command: latest.command,
        depth: latest.depth,
        isServerRoot: latest.isServerRoot,
        firstSeenAt: first.sampledAt,
        lastSeenAt: latest.sampledAt,
        currentCpuPercent: latest.cpuPercent,
        avgCpuPercent: cpuPercentTotal / sorted.length,
        maxCpuPercent,
        cpuSecondsApprox,
        currentRssBytes: latest.rssBytes,
        maxRssBytes,
        sampleCount: sorted.length,
      } satisfies ServerProcessResourceHistorySummary;
    })
    .toSorted((left, right) => right.cpuSecondsApprox - left.cpuSecondsApprox);
}

function buildBuckets(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly nowMs: number;
  readonly window: Duration.Duration;
  readonly bucket: Duration.Duration;
}): ReadonlyArray<ServerProcessResourceHistoryBucket> {
  const bucketMs = Duration.toMillis(Duration.max(MIN_HISTORY_DURATION, input.bucket));
  const windowMs = Duration.toMillis(input.window);
  const windowStartMs = input.nowMs - windowMs;
  const buckets: ServerProcessResourceHistoryBucket[] = [];

  for (let startedAtMs = windowStartMs; startedAtMs < input.nowMs; startedAtMs += bucketMs) {
    const endedAtMs = Math.min(input.nowMs, startedAtMs + bucketMs);
    const bucketSamples = input.samples.filter(
      (sample) =>
        sample.sampledAtMs >= startedAtMs &&
        (endedAtMs === input.nowMs
          ? sample.sampledAtMs <= endedAtMs
          : sample.sampledAtMs < endedAtMs),
    );
    const samplesByRead = new Map<number, ProcessResourceSample[]>();
    for (const sample of bucketSamples) {
      const samplesAtTime = samplesByRead.get(sample.sampledAtMs) ?? [];
      samplesAtTime.push(sample);
      samplesByRead.set(sample.sampledAtMs, samplesAtTime);
    }

    const readTotals = [...samplesByRead.values()].map((samplesAtTime) => ({
      cpuPercent: samplesAtTime.reduce((total, sample) => total + sample.cpuPercent, 0),
      rssBytes: samplesAtTime.reduce((total, sample) => total + sample.rssBytes, 0),
      processCount: samplesAtTime.length,
    }));
    const avgCpuPercent =
      readTotals.length === 0
        ? 0
        : readTotals.reduce((total, read) => total + read.cpuPercent, 0) / readTotals.length;

    buckets.push({
      startedAt: dateTimeFromMillis(startedAtMs),
      endedAt: dateTimeFromMillis(endedAtMs),
      avgCpuPercent,
      maxCpuPercent: readTotals.length ? Math.max(...readTotals.map((read) => read.cpuPercent)) : 0,
      maxRssBytes: readTotals.length ? Math.max(...readTotals.map((read) => read.rssBytes)) : 0,
      maxProcessCount: readTotals.length
        ? Math.max(...readTotals.map((read) => read.processCount))
        : 0,
    });
  }

  return buckets;
}

export function aggregateProcessResourceHistory(input: {
  readonly samples: ReadonlyArray<ProcessResourceSample>;
  readonly readAt: DateTime.Utc;
  readonly readAtMs: number;
  readonly windowMs: number;
  readonly bucketMs: number;
  readonly lastError: Option.Option<string>;
}): ServerProcessResourceHistoryResult {
  const window = Duration.max(MIN_HISTORY_DURATION, Duration.millis(input.windowMs));
  const bucket = Duration.max(MIN_HISTORY_DURATION, Duration.millis(input.bucketMs));
  const windowMs = Duration.toMillis(window);
  const bucketMs = Duration.toMillis(bucket);
  const minSampledAtMs = input.readAtMs - windowMs;
  const samples = input.samples.filter((sample) => sample.sampledAtMs >= minSampledAtMs);
  const topProcesses = summarizeProcesses(samples);
  const totalCpuSecondsApprox = samples.reduce(
    (total, sample) => total + (sample.cpuPercent / 100) * (SAMPLE_INTERVAL_MS / 1_000),
    0,
  );

  return {
    readAt: input.readAt,
    windowMs,
    bucketMs,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    retainedSampleCount: input.samples.length,
    totalCpuSecondsApprox,
    buckets: buildBuckets({ samples, nowMs: input.readAtMs, window, bucket }),
    topProcesses,
    error: Option.map(input.lastError, (message) => ({ message })),
  };
}

export const make = Effect.fn("makeProcessResourceMonitor")(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const state = yield* Ref.make<MonitorState>({ samples: [], lastError: Option.none() });

  const sampleOnce = Effect.gen(function* () {
    const sampledAt = yield* DateTime.now;
    const sampledAtMs = DateTime.toEpochMillis(sampledAt);
    const rows = yield* readProcessRows().pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    const samples = collectMonitoredSamples({
      rows,
      serverPid: process.pid,
      sampledAt,
      sampledAtMs,
    });
    yield* Ref.update(state, (current) => ({
      samples: trimSamples([...current.samples, ...samples], sampledAtMs),
      lastError: Option.none(),
    }));
  }).pipe(
    Effect.catch((error: unknown) =>
      Ref.update(state, (current) => ({
        ...current,
        lastError: Option.some(
          error instanceof Error ? error.message : "Failed to sample process resources.",
        ),
      })),
    ),
  );

  yield* sampleOnce.pipe(Effect.repeat(Schedule.spaced(SAMPLE_INTERVAL)), Effect.forkScoped);

  const readHistory: ProcessResourceMonitorShape["readHistory"] = (input) =>
    Effect.gen(function* () {
      const readAt = yield* DateTime.now;
      const readAtMs = DateTime.toEpochMillis(readAt);
      const current = yield* Ref.get(state);
      return aggregateProcessResourceHistory({
        samples: current.samples,
        readAt,
        readAtMs,
        windowMs: input.windowMs,
        bucketMs: input.bucketMs,
        lastError: current.lastError,
      });
    });

  return ProcessResourceMonitor.of({ readHistory });
});

export const layer = Layer.effect(ProcessResourceMonitor, make());
