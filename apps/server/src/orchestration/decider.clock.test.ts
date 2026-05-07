import { CommandId, EventId, ProjectId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { DateTime, Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const projectId = ProjectId.make("project-clock");
const createdAt = "2026-01-01T00:00:00.000Z";

it.effect("uses the Effect clock for generated project update timestamps", () =>
  Effect.gen(function* () {
    const readModel = yield* projectEvent(createEmptyReadModel(createdAt), {
      sequence: 1,
      eventId: EventId.make("evt-project-clock"),
      aggregateKind: "project",
      aggregateId: projectId,
      type: "project.created",
      occurredAt: createdAt,
      commandId: CommandId.make("cmd-project-clock-create"),
      causationEventId: null,
      correlationId: CommandId.make("cmd-project-clock-create"),
      metadata: {},
      payload: {
        projectId,
        title: "Clock",
        workspaceRoot: "/tmp/clock",
        defaultModelSelection: null,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      },
    });

    yield* TestClock.adjust(Duration.seconds(5));
    const expectedNow = DateTime.formatIso(yield* DateTime.now);
    const result = yield* decideOrchestrationCommand({
      command: {
        type: "project.meta.update",
        commandId: CommandId.make("cmd-project-clock-update"),
        projectId,
        title: "Clock Updated",
      },
      readModel,
    });
    if (Array.isArray(result)) {
      assert.fail("expected a single project meta-updated event");
      return;
    }
    if (result.type !== "project.meta-updated") {
      assert.fail(`expected project.meta-updated, received ${result.type}`);
      return;
    }
    const event = result;

    assert.equal(event.occurredAt, expectedNow);
    assert.equal(event.payload.updatedAt, expectedNow);
  }).pipe(Effect.provide(Layer.merge(TestClock.layer(), Layer.empty))),
);
