import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  CheckpointDiffBlobRepository,
  type CheckpointDiffBlob,
} from "../Services/CheckpointDiffBlobs.ts";
import { CheckpointDiffBlobRepositoryLive } from "./CheckpointDiffBlobs.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const layer = it.layer(
  CheckpointDiffBlobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("CheckpointDiffBlobRepository", (it) => {
  it.effect("upserts and lists provider-native turn diffs", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointDiffBlobRepository;
      const threadId = ThreadId.make("thread-provider-diff-persistence");
      const row: CheckpointDiffBlob = {
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: "first patch",
        createdAt: "2026-01-01T00:00:00.000Z",
        status: "preview",
      };

      yield* repository.upsert(row);
      yield* repository.upsert({ ...row, diff: "updated first patch" });
      yield* repository.upsert({
        ...row,
        fromTurnCount: 1,
        toTurnCount: 2,
        diff: "second patch",
        status: "final",
      });

      const rows = yield* repository.listByThreadId({ threadId });
      assert.deepEqual(rows, [
        { ...row, diff: "updated first patch" },
        {
          ...row,
          fromTurnCount: 1,
          toTurnCount: 2,
          diff: "second patch",
          status: "final",
        },
      ]);

      yield* repository.deleteAfterTurnCount({ threadId, turnCount: 1 });
      assert.deepEqual(yield* repository.listByThreadId({ threadId }), [
        { ...row, diff: "updated first patch" },
      ]);
    }),
  );

  it.effect("does not let a late preview replace a finalized native diff", () =>
    Effect.gen(function* () {
      const repository = yield* CheckpointDiffBlobRepository;
      const threadId = ThreadId.make("thread-provider-diff-finality");
      const finalRow: CheckpointDiffBlob = {
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        diff: "complete patch",
        createdAt: "2026-01-01T00:00:01.000Z",
        status: "final",
      };

      yield* repository.upsert(finalRow);
      yield* repository.upsert({
        ...finalRow,
        diff: "stale preview",
        createdAt: "2026-01-01T00:00:02.000Z",
        status: "preview",
      });

      const row = yield* repository.get({ threadId, fromTurnCount: 0, toTurnCount: 1 });
      assert.equal(row._tag, "Some");
      if (row._tag === "Some") {
        assert.deepEqual(row.value, finalRow);
      }
    }),
  );
});
