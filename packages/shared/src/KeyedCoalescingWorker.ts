/**
 * KeyedCoalescingWorker - A keyed worker that keeps only the latest value per key.
 *
 * Enqueues for an active or already-queued key are merged atomically instead of
 * creating duplicate queued items. `drainKey()` resolves only when that key has
 * no queued, pending, or active work left.
 *
 * @module KeyedCoalescingWorker
 */
import * as Scope from "effect/Scope";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TxQueue from "effect/TxQueue";
import * as TxRef from "effect/TxRef";

export interface KeyedCoalescingWorker<K, V> {
  readonly enqueue: (key: K, value: V) => Effect.Effect<void>;
  readonly drainKey: (key: K) => Effect.Effect<void>;
}

interface KeyedCoalescingWorkerState<K, V> {
  readonly latestByKey: Map<K, V>;
  readonly queuedKeys: Set<K>;
  readonly activeKeys: Set<K>;
}

const getMapValue = <K, V>(map: ReadonlyMap<K, V>, key: K): Option.Option<V> =>
  map.has(key) ? Option.some(map.get(key) as V) : Option.none();

export const makeKeyedCoalescingWorker = <K, V, E, R>(options: {
  readonly merge: (current: V, next: V) => V;
  readonly process: (key: K, value: V) => Effect.Effect<void, E, R>;
}): Effect.Effect<KeyedCoalescingWorker<K, V>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const queue = yield* Effect.acquireRelease(TxQueue.unbounded<K>(), TxQueue.shutdown);
    const stateRef = yield* TxRef.make<KeyedCoalescingWorkerState<K, V>>({
      latestByKey: new Map(),
      queuedKeys: new Set(),
      activeKeys: new Set(),
    });

    const processKey = (key: K, value: V): Effect.Effect<void, E, R> =>
      options.process(key, value).pipe(
        Effect.flatMap(() =>
          TxRef.modify(stateRef, (state) => {
            const nextValue = getMapValue(state.latestByKey, key);
            if (Option.isNone(nextValue)) {
              const activeKeys = new Set(state.activeKeys);
              activeKeys.delete(key);
              return [Option.none<V>(), { ...state, activeKeys }] as const;
            }

            const latestByKey = new Map(state.latestByKey);
            latestByKey.delete(key);
            return [nextValue, { ...state, latestByKey }] as const;
          }).pipe(Effect.tx),
        ),
        Effect.flatMap((nextValue) =>
          Option.match(nextValue, {
            onNone: () => Effect.void,
            onSome: (value) => processKey(key, value),
          }),
        ),
      );

    const cleanupFailedKey = (key: K): Effect.Effect<void> =>
      TxRef.modify(stateRef, (state) => {
        const activeKeys = new Set(state.activeKeys);
        activeKeys.delete(key);

        if (state.latestByKey.has(key) && !state.queuedKeys.has(key)) {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.add(key);
          return [true, { ...state, activeKeys, queuedKeys }] as const;
        }

        return [false, { ...state, activeKeys }] as const;
      }).pipe(
        Effect.tx,
        Effect.flatMap((shouldRequeue) =>
          shouldRequeue ? TxQueue.offer(queue, key) : Effect.void,
        ),
      );

    yield* TxQueue.take(queue).pipe(
      Effect.flatMap((key) =>
        TxRef.modify(stateRef, (state) => {
          const queuedKeys = new Set(state.queuedKeys);
          queuedKeys.delete(key);

          const value = getMapValue(state.latestByKey, key);
          if (Option.isNone(value)) {
            return [
              Option.none<{ readonly key: K; readonly value: V }>(),
              { ...state, queuedKeys },
            ] as const;
          }

          const latestByKey = new Map(state.latestByKey);
          latestByKey.delete(key);
          const activeKeys = new Set(state.activeKeys);
          activeKeys.add(key);

          return [
            Option.some({ key, value: value.value }),
            { ...state, latestByKey, queuedKeys, activeKeys },
          ] as const;
        }).pipe(Effect.tx),
      ),
      Effect.flatMap((item) =>
        Option.match(item, {
          onNone: () => Effect.void,
          onSome: ({ key, value }) =>
            processKey(key, value).pipe(Effect.catchCause(() => cleanupFailedKey(key))),
        }),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    const enqueue: KeyedCoalescingWorker<K, V>["enqueue"] = (key, value) =>
      TxRef.modify(stateRef, (state) => {
        const latestByKey = new Map(state.latestByKey);
        const existing = getMapValue(latestByKey, key);
        latestByKey.set(
          key,
          Option.match(existing, {
            onNone: () => value,
            onSome: (current) => options.merge(current, value),
          }),
        );

        if (state.queuedKeys.has(key) || state.activeKeys.has(key)) {
          return [false, { ...state, latestByKey }] as const;
        }

        const queuedKeys = new Set(state.queuedKeys);
        queuedKeys.add(key);
        return [true, { ...state, latestByKey, queuedKeys }] as const;
      }).pipe(
        Effect.flatMap((shouldOffer) => (shouldOffer ? TxQueue.offer(queue, key) : Effect.void)),
        Effect.tx,
        Effect.asVoid,
      );

    const drainKey: KeyedCoalescingWorker<K, V>["drainKey"] = (key) =>
      TxRef.get(stateRef).pipe(
        Effect.tap((state) =>
          state.latestByKey.has(key) || state.queuedKeys.has(key) || state.activeKeys.has(key)
            ? Effect.txRetry
            : Effect.void,
        ),
        Effect.asVoid,
        Effect.tx,
      );

    return { enqueue, drainKey } satisfies KeyedCoalescingWorker<K, V>;
  });
