import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  aggregateProcessResourceHistory,
  collectMonitoredSamples,
} from "./ProcessResourceMonitor.ts";

describe("ProcessResourceMonitor", () => {
  it.effect("samples the server root process and descendants", () =>
    Effect.sync(() => {
      const sampledAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const samples = collectMonitoredSamples({
        serverPid: 100,
        sampledAt,
        sampledAtMs: DateTime.toEpochMillis(sampledAt),
        rows: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            status: "S",
            cpuPercent: 2,
            rssBytes: 1_000,
            elapsed: "01:00",
            command: "t3 server",
          },
          {
            pid: 101,
            ppid: 100,
            pgid: 100,
            status: "S",
            cpuPercent: 10,
            rssBytes: 2_000,
            elapsed: "00:20",
            command: "codex app-server",
          },
          {
            pid: 102,
            ppid: 101,
            pgid: 100,
            status: "R",
            cpuPercent: 50,
            rssBytes: 3_000,
            elapsed: "00:05",
            command: "rg needle",
          },
          {
            pid: 200,
            ppid: 1,
            pgid: 200,
            status: "R",
            cpuPercent: 99,
            rssBytes: 9_000,
            elapsed: "00:05",
            command: "unrelated",
          },
        ],
      });

      assert.deepStrictEqual(
        samples.map((sample) => sample.pid),
        [100, 101, 102],
      );
      assert.deepStrictEqual(
        samples.map((sample) => sample.depth),
        [0, 1, 2],
      );
      assert.equal(samples[0]?.isServerRoot, true);
      assert.equal(samples[1]?.isServerRoot, false);
    }),
  );

  it.effect("rolls samples up by process and CPU time", () =>
    Effect.sync(() => {
      const firstAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const secondAt = DateTime.makeUnsafe("2026-05-05T10:00:05.000Z");
      const samples = [
        ...collectMonitoredSamples({
          serverPid: 100,
          sampledAt: firstAt,
          sampledAtMs: DateTime.toEpochMillis(firstAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 10,
              rssBytes: 1_000,
              elapsed: "01:00",
              command: "t3 server",
            },
          ],
        }),
        ...collectMonitoredSamples({
          serverPid: 100,
          sampledAt: secondAt,
          sampledAtMs: DateTime.toEpochMillis(secondAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 30,
              rssBytes: 2_000,
              elapsed: "01:05",
              command: "t3 server",
            },
          ],
        }),
      ];

      const result = aggregateProcessResourceHistory({
        samples,
        readAt: secondAt,
        readAtMs: DateTime.toEpochMillis(secondAt),
        windowMs: Duration.toMillis(Duration.minutes(1)),
        bucketMs: Duration.toMillis(Duration.seconds(10)),
        lastError: Option.none(),
      });

      assert.equal(Option.isNone(result.error), true);
      assert.equal(result.topProcesses.length, 1);
      assert.equal(result.topProcesses[0]?.avgCpuPercent, 20);
      assert.equal(result.topProcesses[0]?.maxCpuPercent, 30);
      assert.equal(result.topProcesses[0]?.cpuSecondsApprox, 2);
      assert.equal(result.totalCpuSecondsApprox, 2);
      assert.equal(
        result.buckets.some((bucket) => bucket.maxCpuPercent === 30),
        true,
      );
    }),
  );

  it.effect("keeps a process grouped when elapsed time drifts between samples", () =>
    Effect.sync(() => {
      const firstAt = DateTime.makeUnsafe("2026-05-05T10:00:00.400Z");
      const secondAt = DateTime.makeUnsafe("2026-05-05T10:00:05.900Z");
      const samples = [
        ...collectMonitoredSamples({
          serverPid: 100,
          sampledAt: firstAt,
          sampledAtMs: DateTime.toEpochMillis(firstAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 1,
              rssBytes: 1_000,
              elapsed: "01:00",
              command: "t3 server",
            },
          ],
        }),
        ...collectMonitoredSamples({
          serverPid: 100,
          sampledAt: secondAt,
          sampledAtMs: DateTime.toEpochMillis(secondAt),
          rows: [
            {
              pid: 100,
              ppid: 1,
              pgid: 100,
              status: "S",
              cpuPercent: 2,
              rssBytes: 2_000,
              elapsed: "01:06",
              command: "t3 server",
            },
          ],
        }),
      ];

      const result = aggregateProcessResourceHistory({
        samples,
        readAt: secondAt,
        readAtMs: DateTime.toEpochMillis(secondAt),
        windowMs: Duration.toMillis(Duration.minutes(1)),
        bucketMs: Duration.toMillis(Duration.seconds(10)),
        lastError: Option.none(),
      });

      assert.equal(result.topProcesses.length, 1);
      assert.equal(result.topProcesses[0]?.isServerRoot, true);
      assert.equal(result.topProcesses[0]?.sampleCount, 2);
      assert.equal(result.topProcesses[0]?.maxRssBytes, 2_000);
    }),
  );

  it.effect("returns all process summaries in the selected window", () =>
    Effect.sync(() => {
      const sampledAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const samples = collectMonitoredSamples({
        serverPid: 100,
        sampledAt,
        sampledAtMs: DateTime.toEpochMillis(sampledAt),
        rows: [
          {
            pid: 100,
            ppid: 1,
            pgid: 100,
            status: "S",
            cpuPercent: 1,
            rssBytes: 1_000,
            elapsed: "01:00",
            command: "t3 server",
          },
          ...Array.from({ length: 35 }, (_, index) => ({
            pid: 200 + index,
            ppid: index === 0 ? 100 : 199 + index,
            pgid: 100,
            status: "S",
            cpuPercent: 35 - index,
            rssBytes: 2_000 + index,
            elapsed: "00:10",
            command: `worker ${index}`,
          })),
        ],
      });

      const result = aggregateProcessResourceHistory({
        samples,
        readAt: sampledAt,
        readAtMs: DateTime.toEpochMillis(sampledAt),
        windowMs: Duration.toMillis(Duration.minutes(1)),
        bucketMs: Duration.toMillis(Duration.seconds(10)),
        lastError: Option.none(),
      });

      assert.equal(result.topProcesses.length, 36);
      assert.equal(
        result.topProcesses.some((process) => process.command === "worker 34"),
        true,
      );
    }),
  );

  it.effect("maps the latest sampling error option into the response", () =>
    Effect.sync(() => {
      const readAt = DateTime.makeUnsafe("2026-05-05T10:00:00.000Z");
      const result = aggregateProcessResourceHistory({
        samples: [],
        readAt,
        readAtMs: DateTime.toEpochMillis(readAt),
        windowMs: Duration.toMillis(Duration.minutes(1)),
        bucketMs: Duration.toMillis(Duration.seconds(10)),
        lastError: Option.some("ps failed"),
      });

      if (Option.isNone(result.error)) {
        assert.fail("Expected response error");
      }
      assert.deepStrictEqual(result.error.value, { message: "ps failed" });
    }),
  );
});
