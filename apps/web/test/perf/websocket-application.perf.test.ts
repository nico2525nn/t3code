import { expect, test } from "vitest";

import { summarizeBrowserPerfMetrics } from "../../../../test/perf/support/artifact";
import { PERF_CATALOG_IDS, PERF_PROVIDER_SCENARIOS } from "@t3tools/shared/perf/scenarioCatalog";
import { PERF_THRESHOLDS } from "../../../../test/perf/support/thresholds";
import { startPerfAppHarness, type PerfAppHarness } from "./appHarness";
import {
  ensureThreadRowVisible,
  measureThreadSwitch,
  typeIntoComposerAndSend,
  waitForThreadRoute,
} from "./pagePerfHelpers";

test("high-frequency websocket events stay responsive under real built-app flow", async () => {
  const thresholds = PERF_THRESHOLDS.local;
  let harness: PerfAppHarness | null = null;
  let finished = false;

  try {
    harness = await startPerfAppHarness({
      suite: "websocket-application",
      seedScenarioId: "burst_base",
      providerScenarioId: "dense_assistant_stream",
    });

    const projectTitle = harness.seededState.projectTitle ?? "Performance Workspace";
    const streamScenario = PERF_PROVIDER_SCENARIOS.dense_assistant_stream;

    await ensureThreadRowVisible(
      harness.page,
      projectTitle,
      PERF_CATALOG_IDS.burstBase.burstThreadId,
    );
    await harness.page
      .getByTestId(`thread-row-${PERF_CATALOG_IDS.burstBase.burstThreadId}`)
      .click();
    await waitForThreadRoute(harness.page, {
      threadId: PERF_CATALOG_IDS.burstBase.burstThreadId,
      messageId: PERF_CATALOG_IDS.burstBase.burstTerminalMessageId,
    });

    await harness.resetBrowserMetrics();
    await harness.startAction("burst-completion");
    await typeIntoComposerAndSend(harness.page, "Run the dense websocket perf burst.");

    await harness.page.waitForTimeout(900);

    await measureThreadSwitch(harness, {
      actionName: "thread-switch-burst-nav",
      projectTitle,
      threadId: PERF_CATALOG_IDS.burstBase.navigationThreadId,
      messageId: PERF_CATALOG_IDS.burstBase.navigationTerminalMessageId,
    });

    await measureThreadSwitch(harness, {
      actionName: "thread-switch-burst-return",
      projectTitle,
      threadId: PERF_CATALOG_IDS.burstBase.burstThreadId,
      messageId: PERF_CATALOG_IDS.burstBase.burstTerminalMessageId,
      extraSelector: '[data-testid="composer-editor"]',
    });

    await harness.page.waitForFunction(
      (sentinelText) => document.body.textContent?.includes(sentinelText as string) ?? false,
      streamScenario.sentinelText,
      { timeout: 15_000 },
    );
    await harness.endAction("burst-completion");

    const browserMetrics = await harness.snapshotBrowserMetrics();
    const summary = summarizeBrowserPerfMetrics(browserMetrics, {
      threadSwitchActionPrefix: "thread-switch",
      burstActionName: "burst-completion",
    });

    expect(summary.burstCompletionMs).not.toBeNull();
    expect(summary.burstCompletionMs ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      thresholds.burstCompletionMs,
    );
    expect(summary.maxLongTaskMs).toBeLessThanOrEqual(thresholds.maxLongTaskMs);
    expect(summary.longTasksOver50Ms).toBeLessThanOrEqual(thresholds.longTasksOver50MsMax);
    expect(summary.maxRafGapMs).toBeLessThanOrEqual(thresholds.maxRafGapMs);

    const burstNavActions = browserMetrics.actions.filter((action) =>
      action.name.startsWith("thread-switch-burst"),
    );
    expect(burstNavActions).toHaveLength(2);
    for (const action of burstNavActions) {
      expect(action.durationMs).toBeLessThanOrEqual(thresholds.threadSwitchP95Ms);
    }

    await harness.finishRun({
      suite: "websocket-application",
      scenarioId: "dense_assistant_stream",
      thresholds,
      metadata: {
        burstSeedThreadId: PERF_CATALOG_IDS.burstBase.burstThreadId,
        navigationThreadId: PERF_CATALOG_IDS.burstBase.navigationThreadId,
        sentinelText: streamScenario.sentinelText,
      },
      actionSummary: {
        threadSwitchActionPrefix: "thread-switch",
        burstActionName: "burst-completion",
      },
    });
    finished = true;
  } finally {
    if (harness && !finished) {
      await harness.finishRun({
        suite: "websocket-application",
        scenarioId: "dense_assistant_stream",
        thresholds,
        metadata: {
          burstSeedThreadId: PERF_CATALOG_IDS.burstBase.burstThreadId,
          navigationThreadId: PERF_CATALOG_IDS.burstBase.navigationThreadId,
          sentinelText: PERF_PROVIDER_SCENARIOS.dense_assistant_stream.sentinelText,
        },
        actionSummary: {
          threadSwitchActionPrefix: "thread-switch",
          burstActionName: "burst-completion",
        },
      });
    }
  }
});
