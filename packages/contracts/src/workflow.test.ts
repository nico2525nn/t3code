import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  WorkflowAgentProgressEntry,
  WorkflowInspectionError,
  WorkflowLogProgressEntry,
  WorkflowPhaseProgressEntry,
  WorkflowProgressEntry,
  WorkflowRunHandles,
} from "./workflow.ts";

const decodeAgent = Schema.decodeUnknownSync(WorkflowAgentProgressEntry);
const decodePhase = Schema.decodeUnknownSync(WorkflowPhaseProgressEntry);
const decodeLog = Schema.decodeUnknownSync(WorkflowLogProgressEntry);
const decodeEntry = Schema.decodeUnknownSync(WorkflowProgressEntry);
const decodeHandles = Schema.decodeUnknownSync(WorkflowRunHandles);

describe("WorkflowProgressEntry variants", () => {
  it("decodes a minimal workflow_agent entry and leaves optional fields absent", () => {
    const agent = decodeAgent({ type: "workflow_agent", index: 0, state: "start" });
    expect(agent).toEqual({ type: "workflow_agent", index: 0, state: "start" });
    expect(agent.label).toBeUndefined();
    expect(agent.phaseIndex).toBeUndefined();
    expect(agent.startedAt).toBeUndefined();
  });

  it("decodes a workflow_agent with the full optional surface, including isolation literals", () => {
    const agent = decodeAgent({
      type: "workflow_agent",
      index: 3,
      state: "done",
      label: "reviewer",
      phaseIndex: 1,
      phaseTitle: "Review",
      agentId: "agent-3",
      agentType: "code-reviewer",
      model: "claude",
      fallbackModel: "haiku",
      isolation: "worktree",
      attempt: 2,
      queuedAt: 10,
      startedAt: 20,
      lastProgressAt: 30,
      cached: true,
      remoteSessionId: "remote-1",
      lastToolName: "Bash",
      lastToolSummary: "ran tests",
      promptPreview: "do the thing",
      resultPreview: "done",
      error: "none",
    });
    expect(agent.isolation).toBe("worktree");
    expect(agent.phaseIndex).toBe(1);
    expect(agent.cached).toBe(true);
  });

  it("rejects an unknown isolation literal", () => {
    expect(() =>
      decodeAgent({ type: "workflow_agent", index: 0, state: "start", isolation: "cloud" }),
    ).toThrow();
  });

  // Effect's Schema.Struct defaults to onExcessProperty: "ignore", so unknown
  // extra keys DECODE SUCCESSFULLY and are stripped rather than rejected.
  it("accepts and strips unknown extra keys on a workflow_agent", () => {
    const agent = decodeAgent({
      type: "workflow_agent",
      index: 0,
      state: "start",
      somethingNew: "from a future SDK",
    });
    expect(agent).toEqual({ type: "workflow_agent", index: 0, state: "start" });
    expect(agent).not.toHaveProperty("somethingNew");
  });

  it("decodes a minimal workflow_phase and keeps optional kind absent when omitted", () => {
    const phase = decodePhase({ type: "workflow_phase", index: 0, title: "Plan" });
    expect(phase).toEqual({ type: "workflow_phase", index: 0, title: "Plan" });
    expect(phase.kind).toBeUndefined();
  });

  it("decodes a workflow_log entry", () => {
    const log = decodeLog({ type: "workflow_log", message: "starting up" });
    expect(log).toEqual({ type: "workflow_log", message: "starting up" });
  });

  it("decodes each variant through the union by its discriminant", () => {
    expect(decodeEntry({ type: "workflow_agent", index: 0, state: "start" }).type).toBe(
      "workflow_agent",
    );
    expect(decodeEntry({ type: "workflow_phase", index: 0, title: "Plan" }).type).toBe(
      "workflow_phase",
    );
    expect(decodeEntry({ type: "workflow_log", message: "hi" }).type).toBe("workflow_log");
  });

  it("rejects an unknown entry type in the union", () => {
    expect(() => decodeEntry({ type: "workflow_mystery", index: 0 })).toThrow();
  });
});

describe("WorkflowRunHandles", () => {
  it("decodes with only the required taskId", () => {
    const handles = decodeHandles({ taskId: "task-1" });
    expect(handles).toEqual({ taskId: "task-1" });
    expect(handles.runId).toBeUndefined();
    expect(handles.sessionUrl).toBeUndefined();
  });

  it("requires taskId", () => {
    expect(() => decodeHandles({ runId: "wf_abc" })).toThrow();
  });

  it("rejects a blank (untrimmed-empty) taskId", () => {
    expect(() => decodeHandles({ taskId: "   " })).toThrow();
  });

  it("decodes the full remote handle surface", () => {
    const handles = decodeHandles({
      taskId: "task-1",
      runId: "wf_abc",
      workflowName: "spec",
      taskType: "remote_agent",
      scriptPath: "/x/s.js",
      transcriptDir: "/x/t",
      sessionUrl: "https://example.com/run",
      warning: "degraded",
    });
    expect(handles.sessionUrl).toBe("https://example.com/run");
    expect(handles.taskType).toBe("remote_agent");
  });
});

describe("WorkflowInspectionError", () => {
  it("derives a stable message from operation and detail", () => {
    const error = new WorkflowInspectionError({
      operation: "readScript",
      reason: "not-found",
      detail: "no such file",
    });
    expect(error.message).toBe("Workflow inspection failed in readScript: no such file");
    expect(error.reason).toBe("not-found");
  });
});
