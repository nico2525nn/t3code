import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ThreadId } from "@t3tools/contracts";
import { DateTime, Effect, Layer, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  OrchestrationCommandReceiptRepository,
  type OrchestrationCommandReceipt,
} from "../../persistence/Services/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStore } from "../../persistence/Services/OrchestrationEventStore.ts";
import { createEmptyReadModel } from "../projector.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { OrchestrationProjectionPipeline } from "../Services/ProjectionPipeline.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";

it.effect("uses TestClock-backed DateTime for rejected command receipts", () =>
  Effect.gen(function* () {
    const capturedReceipt = yield* Ref.make<Option.Option<OrchestrationCommandReceipt>>(
      Option.none(),
    );
    const fixedNow = DateTime.makeUnsafe("2026-05-08T16:30:00.000Z");
    const fixedNowIso = DateTime.formatIso(fixedNow);

    const receiptRepositoryLayer = Layer.mock(OrchestrationCommandReceiptRepository)({
      getByCommandId: () => Effect.succeed(Option.none()),
      upsert: (receipt) => Ref.set(capturedReceipt, Option.some(receipt)),
    });

    const testLayer = OrchestrationEngineLive.pipe(
      Layer.provide(
        Layer.mock(ProjectionSnapshotQuery)({
          getCommandReadModel: () => Effect.succeed(createEmptyReadModel(fixedNowIso)),
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationProjectionPipeline)({
          bootstrap: Effect.void,
        }),
      ),
      Layer.provide(
        Layer.mock(OrchestrationEventStore)({
          readFromSequence: () => Stream.empty,
        }),
      ),
      Layer.provide(receiptRepositoryLayer),
      Layer.provide(SqlitePersistenceMemory),
      Layer.provideMerge(TestClock.layer()),
    );

    yield* Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(fixedNow));
      const engine = yield* OrchestrationEngineService;
      const result = yield* Effect.result(
        engine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-clock-rejected"),
          threadId: ThreadId.make("thread-missing-clock"),
          message: {
            messageId: MessageId.make("msg-clock-rejected"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          interactionMode: "default",
          runtimeMode: "approval-required",
          createdAt: fixedNowIso,
        }),
      );

      assert.equal(result._tag, "Failure");
      const receipt = yield* Ref.get(capturedReceipt);
      assert.isTrue(Option.isSome(receipt));
      if (Option.isNone(receipt)) {
        return;
      }
      assert.equal(receipt.value.acceptedAt, fixedNowIso);
    }).pipe(Effect.provide(testLayer));
  }),
);
