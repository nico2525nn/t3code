import { assert, it } from "@effect/vitest";
import { RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";

const layerTest = TurnItemPositionStore.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("reuses an item's position without attempting another allocation insert", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const input = {
      threadId: ThreadId.make("thread:position-reuse"),
      turnItemId: TurnItemId.make("item:streaming"),
      runId: null,
    };
    const first = yield* positions.allocate(input);
    assert.equal(first, 1);

    // BEFORE INSERT runs even when ON CONFLICT would discard the allocation.
    yield* sql`
      CREATE TEMP TRIGGER reject_redundant_position_insert
      BEFORE INSERT ON orchestration_v2_turn_item_positions
      WHEN EXISTS (
        SELECT 1 FROM orchestration_v2_turn_item_positions
        WHERE thread_id = NEW.thread_id AND turn_item_id = NEW.turn_item_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Existing item positions must be reused');
      END
    `;

    const next = yield* positions.allocate({
      ...input,
      turnItemId: TurnItemId.make("item:next"),
    });
    assert.equal(next, first + 1);
    assert.equal(yield* positions.allocate(input), first);
    assert.equal(
      yield* positions.allocate({
        ...input,
        runId: RunId.make("run:moved"),
        runOrdinal: 2,
      }),
      first,
    );
    assert.equal(
      yield* positions.allocate({ ...input, threadId: ThreadId.make("thread:other") }),
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("reorders a thread's items atomically and idempotently", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
    const threadId = ThreadId.make("thread:position-reorder");
    const items = ["first", "second", "third"].map((id) => TurnItemId.make(`item:${id}`));
    for (const turnItemId of items) {
      yield* positions.allocate({ threadId, turnItemId, runId: null });
    }

    yield* positions.reorder({ threadId, turnItemIds: [items[2]!, items[0]!, items[1]!] });
    const reordered = yield* sql<{
      readonly turn_item_id: string;
      readonly ordinal: number;
    }>`
      SELECT turn_item_id, ordinal
      FROM orchestration_v2_turn_item_positions
      WHERE thread_id = ${threadId}
      ORDER BY ordinal
    `;
    assert.deepEqual(
      reordered.map((row) => [row.turn_item_id, row.ordinal]),
      [
        [items[2]!, 1],
        [items[0]!, 2],
        [items[1]!, 3],
      ],
    );

    yield* positions.reorder({ threadId, turnItemIds: [items[2]!, items[0]!, items[1]!] });
    const repeated = yield* sql<{ readonly ordinal: number }>`
      SELECT ordinal
      FROM orchestration_v2_turn_item_positions
      WHERE thread_id = ${threadId}
      ORDER BY ordinal
    `;
    assert.deepEqual(
      repeated.map((row) => row.ordinal),
      [1, 2, 3],
    );
  }).pipe(Effect.provide(layerTest)),
);
