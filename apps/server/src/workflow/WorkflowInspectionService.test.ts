// @effect-diagnostics nodeBuiltinImport:off - test builds fixtures via Node fs/path directly.
// @effect-diagnostics preferSchemaOverJson:off - fixtures serialize plain JSON journal records.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as WorkflowInspectionService from "./WorkflowInspectionService.ts";

interface Layout {
  readonly root: string;
  readonly transcriptDir: string;
  readonly scriptsDir: string;
  readonly scriptPath: string;
}

const makeLayout = (fs: FileSystem.FileSystem, root: string) =>
  Effect.gen(function* () {
    const sessionDir = NodePath.join(root, "proj", "sess");
    const transcriptDir = NodePath.join(sessionDir, "subagents", "workflows", "wf_abc");
    const scriptsDir = NodePath.join(sessionDir, "workflows", "scripts");
    yield* fs.makeDirectory(transcriptDir, { recursive: true });
    yield* fs.makeDirectory(scriptsDir, { recursive: true });
    return {
      root,
      transcriptDir,
      scriptsDir,
      scriptPath: NodePath.join(scriptsDir, "spec.js"),
    } satisfies Layout;
  });

/** Build a service instance whose projects root is an isolated temp dir. */
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-inspection-" });
  const layout = yield* makeLayout(fs, root);
  const service = yield* WorkflowInspectionService.make({ projectsRoot: root });
  return { fs, service, layout };
});

describe("WorkflowInspectionService", () => {
  describe("readScript", () => {
    it.effect("reads a contained script and reports it untruncated", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        yield* fs.writeFileString(layout.scriptPath, "export const run = () => 1;\n");

        const result = yield* service.readScript({ scriptPath: layout.scriptPath });
        assert.equal(result.source, "export const run = () => 1;\n");
        assert.isFalse(result.truncated);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("clips scripts larger than the cap and marks them truncated", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        const big = "a".repeat(512 * 1024 + 128);
        yield* fs.writeFileString(layout.scriptPath, big);

        const result = yield* service.readScript({ scriptPath: layout.scriptPath });
        assert.isTrue(result.truncated);
        assert.equal(result.source.length, 512 * 1024);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects a relative path as invalid-path", () =>
      Effect.gen(function* () {
        const { service } = yield* setup;
        const error = yield* service
          .readScript({ scriptPath: "relative/spec.js" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "invalid-path");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects a path outside the projects root as invalid-path", () =>
      Effect.gen(function* () {
        const { fs, service } = yield* setup;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-outside-" });
        const outsideScript = NodePath.join(outside, "escape.js");
        yield* fs.writeFileString(outsideScript, "export const x = 1;");

        const error = yield* service.readScript({ scriptPath: outsideScript }).pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "invalid-path");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects a symlink inside the root that escapes it as invalid-path", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-outside-" });
        const outsideScript = NodePath.join(outside, "real.js");
        yield* fs.writeFileString(outsideScript, "export const x = 1;");

        const linkPath = NodePath.join(layout.scriptsDir, "link.js");
        yield* Effect.promise(() => NodeFSP.symlink(outsideScript, linkPath));

        const error = yield* service.readScript({ scriptPath: linkPath }).pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "invalid-path");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects a non-script extension as invalid-path", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        const badPath = NodePath.join(layout.scriptsDir, "spec.txt");
        yield* fs.writeFileString(badPath, "not a script");

        const error = yield* service.readScript({ scriptPath: badPath }).pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "invalid-path");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("reports a missing script as not-found", () =>
      Effect.gen(function* () {
        const { service, layout } = yield* setup;
        const missing = NodePath.join(layout.scriptsDir, "missing.js");
        const error = yield* service.readScript({ scriptPath: missing }).pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "not-found");
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  describe("readJournal", () => {
    it.effect("summarizes started and result records with clipping", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        const bigResult = "z".repeat(64 * 1024);
        const lines = [
          JSON.stringify({ type: "started", key: "k1", agentId: "a1" }),
          JSON.stringify({
            type: "result",
            key: "k1",
            agentId: "a1",
            result: { ok: true, value: 42 },
          }),
          JSON.stringify({ type: "started", key: "k2", agentId: "a2" }),
          "this-is-not-json{",
          JSON.stringify({ type: "result", key: "k3", agentId: "a3", result: bigResult }),
        ];
        yield* fs.writeFileString(
          NodePath.join(layout.transcriptDir, "journal.jsonl"),
          `${lines.join("\n")}\n`,
        );

        const result = yield* service.readJournal({ transcriptDir: layout.transcriptDir });
        assert.isFalse(result.truncated);
        assert.deepEqual(
          result.entries.map((entry) => entry.agentId),
          ["a1", "a2", "a3"],
        );

        const a1 = result.entries[0];
        assert.isTrue(a1?.hasResult);
        assert.equal(a1?.resultJson, JSON.stringify({ ok: true, value: 42 }));
        assert.isUndefined(a1?.resultTruncated);

        const a2 = result.entries[1];
        assert.isFalse(a2?.hasResult);
        assert.isUndefined(a2?.resultJson);

        const a3 = result.entries[2];
        assert.isTrue(a3?.hasResult);
        assert.isTrue(a3?.resultTruncated);
        assert.equal(a3?.resultJson?.length, 32 * 1024);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("reports a missing journal as not-found", () =>
      Effect.gen(function* () {
        const { service, layout } = yield* setup;
        const error = yield* service
          .readJournal({ transcriptDir: layout.transcriptDir })
          .pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "not-found");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects a journal.jsonl symlink that escapes the root as invalid-path", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-outside-" });
        const secret = NodePath.join(outside, "secret.jsonl");
        yield* fs.writeFileString(secret, JSON.stringify({ type: "started", agentId: "leak" }));

        const escapeDir = NodePath.join(layout.transcriptDir, "..", "wf_journal_escape");
        yield* fs.makeDirectory(escapeDir, { recursive: true });
        yield* Effect.promise(() =>
          NodeFSP.symlink(secret, NodePath.join(escapeDir, "journal.jsonl")),
        );

        const error = yield* service.readJournal({ transcriptDir: escapeDir }).pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "invalid-path");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects a transcript dir outside the root as invalid-path", () =>
      Effect.gen(function* () {
        const { fs, service } = yield* setup;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-outside-" });
        yield* fs.writeFileString(NodePath.join(outside, "journal.jsonl"), "");

        const error = yield* service.readJournal({ transcriptDir: outside }).pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "invalid-path");
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  describe("readAgentTranscript", () => {
    it.effect("reads the full transcript and reports completion", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        yield* fs.writeFileString(
          NodePath.join(layout.transcriptDir, "agent-a1.jsonl"),
          "l0\nl1\nl2\n",
        );

        const result = yield* service.readAgentTranscript({
          transcriptDir: layout.transcriptDir,
          agentId: "a1",
        });
        assert.deepEqual(result.lines, ["l0", "l1", "l2"]);
        assert.equal(result.nextLine, 3);
        assert.isTrue(result.complete);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("returns the remainder from a mid-file cursor", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        yield* fs.writeFileString(
          NodePath.join(layout.transcriptDir, "agent-a1.jsonl"),
          "l0\nl1\nl2\n",
        );

        const result = yield* service.readAgentTranscript({
          transcriptDir: layout.transcriptDir,
          agentId: "a1",
          afterLine: 1,
        });
        assert.deepEqual(result.lines, ["l1", "l2"]);
        assert.equal(result.nextLine, 3);
        assert.isTrue(result.complete);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("returns empty and complete when the cursor is past end-of-file", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        yield* fs.writeFileString(
          NodePath.join(layout.transcriptDir, "agent-a1.jsonl"),
          "l0\nl1\nl2\n",
        );

        const result = yield* service.readAgentTranscript({
          transcriptDir: layout.transcriptDir,
          agentId: "a1",
          afterLine: 10,
        });
        assert.deepEqual(result.lines, []);
        assert.equal(result.nextLine, 10);
        assert.isTrue(result.complete);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects a traversal agent id as invalid-path", () =>
      Effect.gen(function* () {
        const { service, layout } = yield* setup;
        const error = yield* service
          .readAgentTranscript({ transcriptDir: layout.transcriptDir, agentId: "../journal" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "invalid-path");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("pages a long transcript at the line cap", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        const lines = Array.from({ length: 500 }, (_unused, index) => `line-${index}`);
        yield* fs.writeFileString(
          NodePath.join(layout.transcriptDir, "agent-a1.jsonl"),
          lines.join("\n"),
        );

        const first = yield* service.readAgentTranscript({
          transcriptDir: layout.transcriptDir,
          agentId: "a1",
        });
        assert.equal(first.lines.length, 400);
        assert.equal(first.nextLine, 400);
        assert.isFalse(first.complete);

        const second = yield* service.readAgentTranscript({
          transcriptDir: layout.transcriptDir,
          agentId: "a1",
          afterLine: first.nextLine,
        });
        assert.equal(second.lines.length, 100);
        assert.equal(second.nextLine, 500);
        assert.isTrue(second.complete);
        assert.equal(second.lines[99], "line-499");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects an agent transcript symlink that escapes the root as invalid-path", () =>
      Effect.gen(function* () {
        const { fs, service, layout } = yield* setup;
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-workflow-outside-" });
        const secret = NodePath.join(outside, "secret.txt");
        yield* fs.writeFileString(secret, "root:x:0:0::/root:/bin/bash");

        const escapeDir = NodePath.join(layout.transcriptDir, "..", "wf_transcript_escape");
        yield* fs.makeDirectory(escapeDir, { recursive: true });
        yield* Effect.promise(() =>
          NodeFSP.symlink(secret, NodePath.join(escapeDir, "agent-leak.jsonl")),
        );

        const error = yield* service
          .readAgentTranscript({ transcriptDir: escapeDir, agentId: "leak" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "invalid-path");
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("reports a missing transcript as not-found", () =>
      Effect.gen(function* () {
        const { service, layout } = yield* setup;
        const error = yield* service
          .readAgentTranscript({ transcriptDir: layout.transcriptDir, agentId: "missing" })
          .pipe(Effect.flip);
        assert.equal(error._tag, "WorkflowInspectionError");
        assert.equal(error.reason, "not-found");
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });
});
