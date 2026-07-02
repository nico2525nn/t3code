// @effect-diagnostics nodeBuiltinImport:off - realpath containment must use Node's fs/path directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  WorkflowInspectionError,
  type WorkflowReadAgentTranscriptInput,
  type WorkflowReadAgentTranscriptResult,
  type WorkflowReadJournalInput,
  type WorkflowReadJournalResult,
  type WorkflowReadScriptInput,
  type WorkflowReadScriptResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

/**
 * Read-only inspection of Claude Agent SDK workflow-run artifacts on local
 * disk. Clients echo server-local paths back over RPC, so every path is
 * validated structurally (absolute + realpath-contained inside the projects
 * root) before any disk access — the service must never become an
 * arbitrary-file-read oracle.
 */

/** `readScript`: clip source text past this many characters. */
const SCRIPT_MAX_CHARS = 512 * 1024;
/** `readJournal`: clip each serialized result past this many characters. */
const JOURNAL_RESULT_MAX_CHARS = 32 * 1024;
/** `readJournal`: cap the number of distinct agents reported. */
const JOURNAL_MAX_ENTRIES = 512;
/** `readAgentTranscript`: cap the number of lines returned per page. */
const TRANSCRIPT_MAX_LINES = 400;
/** `readAgentTranscript`: stop a page once accumulated chars exceed this. */
const TRANSCRIPT_MAX_CHARS = 768 * 1024;

/** Only these agent id shapes are accepted before touching the filesystem. */
const AGENT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** Mutable while parsing the journal; frozen into the readonly contract shape. */
interface MutableJournalEntry {
  agentId: string;
  hasResult: boolean;
  resultJson?: string;
  resultTruncated?: boolean;
}

/** Parse one JSONL line defensively; unparseable lines return `undefined`. */
const parseJsonLine = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const isEnoent = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  (cause as { code?: unknown }).code === "ENOENT";

const isNotFoundPlatformError = (cause: unknown): boolean =>
  typeof cause === "object" &&
  cause !== null &&
  "reason" in cause &&
  typeof (cause as { reason?: unknown }).reason === "object" &&
  (cause as { reason: { _tag?: unknown } }).reason !== null &&
  (cause as { reason: { _tag?: unknown } }).reason._tag === "NotFound";

export class WorkflowInspectionService extends Context.Service<
  WorkflowInspectionService,
  {
    readonly readScript: (
      input: WorkflowReadScriptInput,
    ) => Effect.Effect<WorkflowReadScriptResult, WorkflowInspectionError>;
    readonly readJournal: (
      input: WorkflowReadJournalInput,
    ) => Effect.Effect<WorkflowReadJournalResult, WorkflowInspectionError>;
    readonly readAgentTranscript: (
      input: WorkflowReadAgentTranscriptInput,
    ) => Effect.Effect<WorkflowReadAgentTranscriptResult, WorkflowInspectionError>;
  }
>()("t3/workflow/WorkflowInspectionService") {}

export const make = (options?: { readonly projectsRoot?: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const projectsRoot =
      options?.projectsRoot ?? NodePath.join(NodeOS.homedir(), ".claude", "projects");

    /**
     * Resolve the real path of `target` and prove it is contained within the
     * real projects root using a path-segment-safe prefix comparison. ENOENT
     * during either realpath maps to `not-found`; escape maps to
     * `invalid-path`.
     */
    const resolveContained = Effect.fn("WorkflowInspectionService.resolveContained")(function* (
      operation: string,
      target: string,
    ) {
      if (!NodePath.isAbsolute(target)) {
        return yield* new WorkflowInspectionError({
          operation,
          reason: "invalid-path",
          detail: "Path must be absolute.",
        });
      }

      const realRoot = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(projectsRoot),
        catch: (cause) =>
          new WorkflowInspectionError({
            operation,
            reason: isEnoent(cause) ? "not-found" : "read-failed",
            detail: "Failed to resolve the workflow projects root.",
          }),
      });

      const realTarget = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(target),
        catch: (cause) =>
          new WorkflowInspectionError({
            operation,
            reason: isEnoent(cause) ? "not-found" : "read-failed",
            detail: "Failed to resolve the requested path.",
          }),
      });

      if (realTarget !== realRoot && !realTarget.startsWith(realRoot + NodePath.sep)) {
        return yield* new WorkflowInspectionError({
          operation,
          reason: "invalid-path",
          detail: "Path escapes the workflow projects root.",
        });
      }

      return realTarget;
    });

    const readScript = Effect.fn("WorkflowInspectionService.readScript")(function* (
      input: WorkflowReadScriptInput,
    ) {
      const operation = "WorkflowInspectionService.readScript";
      if (!input.scriptPath.endsWith(".js") && !input.scriptPath.endsWith(".mjs")) {
        return yield* new WorkflowInspectionError({
          operation,
          reason: "invalid-path",
          detail: "Script path must end with .js or .mjs.",
        });
      }

      const realPath = yield* resolveContained(operation, input.scriptPath);
      const source = yield* fs.readFileString(realPath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowInspectionError({
              operation,
              reason: isNotFoundPlatformError(cause) ? "not-found" : "read-failed",
              detail: "Failed to read the workflow script.",
            }),
        ),
      );

      const truncated = source.length > SCRIPT_MAX_CHARS;
      return {
        source: truncated ? source.slice(0, SCRIPT_MAX_CHARS) : source,
        truncated,
      } satisfies WorkflowReadScriptResult;
    });

    const readJournal = Effect.fn("WorkflowInspectionService.readJournal")(function* (
      input: WorkflowReadJournalInput,
    ) {
      const operation = "WorkflowInspectionService.readJournal";
      const realDir = yield* resolveContained(operation, input.transcriptDir);
      // Re-contain the joined leaf: a symlink named journal.jsonl inside a
      // valid directory must not escape the projects root.
      const journalPath = yield* resolveContained(
        operation,
        NodePath.join(realDir, "journal.jsonl"),
      );
      const raw = yield* fs.readFileString(journalPath).pipe(
        Effect.mapError(
          (cause) =>
            new WorkflowInspectionError({
              operation,
              reason: isNotFoundPlatformError(cause) ? "not-found" : "read-failed",
              detail: "Failed to read the workflow journal.",
            }),
        ),
      );

      // Preserve first-seen agent order via an insertion-ordered Map.
      const entries = new Map<string, MutableJournalEntry>();
      let truncated = false;

      const ensureEntry = (agentId: string): MutableJournalEntry | undefined => {
        const existing = entries.get(agentId);
        if (existing !== undefined) return existing;
        if (entries.size >= JOURNAL_MAX_ENTRIES) {
          truncated = true;
          return undefined;
        }
        const created: MutableJournalEntry = { agentId, hasResult: false };
        entries.set(agentId, created);
        return created;
      };

      for (const line of raw.split("\n")) {
        const text = line.trim();
        if (text.length === 0) continue;
        const record = parseJsonLine(text);
        if (record === undefined) continue;
        if (typeof record !== "object" || record === null) continue;
        const parsed = record as {
          type?: unknown;
          agentId?: unknown;
          result?: unknown;
        };
        if (typeof parsed.agentId !== "string" || parsed.agentId.length === 0) continue;

        if (parsed.type === "started") {
          ensureEntry(parsed.agentId);
          continue;
        }
        if (parsed.type === "result") {
          const entry = ensureEntry(parsed.agentId);
          if (entry === undefined) continue;
          entry.hasResult = true;
          // @effect-diagnostics-next-line preferSchemaOverJson:off - result is arbitrary JSON re-serialized verbatim.
          const serialized = JSON.stringify(parsed.result);
          if (serialized !== undefined) {
            const resultTruncated = serialized.length > JOURNAL_RESULT_MAX_CHARS;
            entry.resultJson = resultTruncated
              ? serialized.slice(0, JOURNAL_RESULT_MAX_CHARS)
              : serialized;
            if (resultTruncated) entry.resultTruncated = true;
          }
        }
      }

      return {
        entries: Array.from(entries.values()),
        truncated,
      } satisfies WorkflowReadJournalResult;
    });

    const readAgentTranscript = Effect.fn("WorkflowInspectionService.readAgentTranscript")(
      function* (input: WorkflowReadAgentTranscriptInput) {
        const operation = "WorkflowInspectionService.readAgentTranscript";
        if (!AGENT_ID_PATTERN.test(input.agentId)) {
          return yield* new WorkflowInspectionError({
            operation,
            reason: "invalid-path",
            detail: "Agent id contains unsupported characters.",
          });
        }

        const realDir = yield* resolveContained(operation, input.transcriptDir);
        // Re-contain the joined leaf: a symlink named agent-<id>.jsonl inside
        // a valid directory must not escape the projects root.
        const transcriptPath = yield* resolveContained(
          operation,
          NodePath.join(realDir, `agent-${input.agentId}.jsonl`),
        );
        // v1 reads the whole file per page; acceptable for current transcript
        // sizes. Revisit with a streaming/seek reader if transcripts grow large.
        const raw = yield* fs.readFileString(transcriptPath).pipe(
          Effect.mapError(
            (cause) =>
              new WorkflowInspectionError({
                operation,
                reason: isNotFoundPlatformError(cause) ? "not-found" : "read-failed",
                detail: "Failed to read the agent transcript.",
              }),
          ),
        );

        const allLines = raw.split("\n");
        if (allLines.length > 0 && allLines[allLines.length - 1] === "") {
          allLines.pop();
        }
        const total = allLines.length;
        const afterLine = Math.max(0, input.afterLine ?? 0);

        const lines: string[] = [];
        let accumulated = 0;
        for (let index = afterLine; index < total && lines.length < TRANSCRIPT_MAX_LINES; index++) {
          const current = allLines[index] ?? "";
          lines.push(current);
          accumulated += current.length;
          if (accumulated > TRANSCRIPT_MAX_CHARS) break;
        }

        const nextLine = afterLine + lines.length;
        return {
          lines,
          nextLine,
          complete: nextLine >= total,
        } satisfies WorkflowReadAgentTranscriptResult;
      },
    );

    return WorkflowInspectionService.of({
      readScript,
      readJournal,
      readAgentTranscript,
    });
  });

export const layer = Layer.effect(WorkflowInspectionService, make());
