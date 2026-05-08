import { assert, it } from "@effect/vitest";
import { CommandId, ProjectId } from "@t3tools/contracts";
import { Effect, Random } from "effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel } from "./projector.ts";

const createdAt = "2026-05-08T16:00:00.000Z";

const decideProjectCreatedEventId = decideOrchestrationCommand({
  command: {
    type: "project.create",
    commandId: CommandId.make("cmd-deterministic-event-id"),
    projectId: ProjectId.make("project-deterministic-event-id"),
    title: "Deterministic",
    workspaceRoot: "/tmp/deterministic",
    createdAt,
  },
  readModel: createEmptyReadModel(createdAt),
}).pipe(
  Effect.map((event) => {
    assert.isFalse(Array.isArray(event));
    if (Array.isArray(event)) {
      throw new Error("project.create should emit one event");
    }
    return event.eventId;
  }),
);

it.effect("uses Effect Random for deterministic event ids", () =>
  Effect.gen(function* () {
    const first = yield* decideProjectCreatedEventId.pipe(Random.withSeed("decider-seed"));
    const second = yield* decideProjectCreatedEventId.pipe(Random.withSeed("decider-seed"));

    assert.equal(first, second);
  }),
);
