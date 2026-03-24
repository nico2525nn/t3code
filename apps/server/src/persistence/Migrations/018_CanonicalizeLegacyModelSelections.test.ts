import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import Migration0018 from "./018_CanonicalizeLegacyModelSelections.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("018_CanonicalizeLegacyModelSelections", (it) => {
  it.effect("canonicalizes legacy projection rows and orchestration event payloads", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* sql`
        CREATE TABLE projection_projects (
          project_id TEXT PRIMARY KEY,
          default_provider TEXT,
          default_model TEXT,
          default_model_options_json TEXT
        )
      `;
      yield* sql`
        CREATE TABLE projection_threads (
          thread_id TEXT PRIMARY KEY,
          provider TEXT,
          model TEXT NOT NULL,
          model_options_json TEXT
        )
      `;
      yield* sql`
        CREATE TABLE orchestration_events (
          event_type TEXT NOT NULL,
          payload_json TEXT NOT NULL
        )
      `;

      yield* sql`
        INSERT INTO projection_projects (
          project_id,
          default_provider,
          default_model,
          default_model_options_json
        )
        VALUES (
          'project-1',
          'codex',
          'claude-opus-4-6',
          '{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max","thinking":false}}'
        )
      `;
      yield* sql`
        INSERT INTO projection_threads (
          thread_id,
          provider,
          model,
          model_options_json
        )
        VALUES (
          'thread-1',
          'codex',
          'claude-opus-4-6',
          '{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max"}}'
        )
      `;
      yield* sql`
        INSERT INTO orchestration_events (
          event_type,
          payload_json
        )
        VALUES
        (
          'project.created',
          '{"projectId":"project-1","title":"Project","workspaceRoot":"/tmp/project","defaultModel":"claude-opus-4-6","defaultModelOptions":{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max"}},"scripts":[],"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}'
        ),
        (
          'thread.created',
          '{"threadId":"thread-1","projectId":"project-1","title":"Thread","model":"claude-opus-4-6","modelOptions":{"codex":{"reasoningEffort":"high"},"claudeAgent":{"effort":"max","thinking":false}},"runtimeMode":"full-access","interactionMode":"default","branch":null,"worktreePath":null,"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}'
        ),
        (
          'thread.turn-start-requested',
          '{"threadId":"thread-1","turnId":"turn-1","input":"hi","model":"gpt-5.4","modelOptions":{"codex":{"fastMode":true},"claudeAgent":{"effort":"max"}},"deliveryMode":"buffered"}'
        )
      `;

      yield* Migration0018;

      const projectRows = yield* sql<{
        readonly defaultProvider: string | null;
        readonly defaultModelOptions: string | null;
      }>`
        SELECT
          default_provider AS "defaultProvider",
          default_model_options_json AS "defaultModelOptions"
        FROM projection_projects
        WHERE project_id = 'project-1'
      `;
      assert.deepStrictEqual(projectRows[0], {
        defaultProvider: "claudeAgent",
        defaultModelOptions: '{"effort":"max","thinking":false}',
      });

      const threadRows = yield* sql<{
        readonly provider: string | null;
        readonly modelOptions: string | null;
      }>`
        SELECT
          provider,
          model_options_json AS "modelOptions"
        FROM projection_threads
        WHERE thread_id = 'thread-1'
      `;
      assert.deepStrictEqual(threadRows[0], {
        provider: "claudeAgent",
        modelOptions: '{"effort":"max"}',
      });

      const eventRows = yield* sql<{
        readonly eventType: string;
        readonly payloadJson: string;
      }>`
        SELECT
          event_type AS "eventType",
          payload_json AS "payloadJson"
        FROM orchestration_events
        ORDER BY rowid ASC
      `;

      assert.deepStrictEqual(JSON.parse(eventRows[0]!.payloadJson), {
        projectId: "project-1",
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
          },
        },
        scripts: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      assert.deepStrictEqual(JSON.parse(eventRows[1]!.payloadJson), {
        threadId: "thread-1",
        projectId: "project-1",
        title: "Thread",
        modelSelection: {
          provider: "claudeAgent",
          model: "claude-opus-4-6",
          options: {
            effort: "max",
            thinking: false,
          },
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });

      assert.deepStrictEqual(JSON.parse(eventRows[2]!.payloadJson), {
        threadId: "thread-1",
        turnId: "turn-1",
        input: "hi",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
          options: {
            fastMode: true,
          },
        },
        deliveryMode: "buffered",
      });
    }),
  );
});
