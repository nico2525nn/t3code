import { Debouncer } from "@tanstack/react-pacer";
import type { PersistStorage, StorageValue } from "zustand/middleware";

export interface StateStorage<R = unknown> {
  getItem: (name: string) => string | null | Promise<string | null>;
  setItem: (name: string, value: string) => R;
  removeItem: (name: string) => R;
}

export interface DebouncedStorage<R = unknown> extends StateStorage<R> {
  flush: () => void;
}

export function createMemoryStorage(): StateStorage {
  const store = new Map<string, string>();
  return {
    getItem: (name) => store.get(name) ?? null,
    setItem: (name, value) => {
      store.set(name, value);
    },
    removeItem: (name) => {
      store.delete(name);
    },
  };
}

export function isStateStorage(
  storage: Partial<StateStorage> | null | undefined,
): storage is StateStorage {
  return (
    storage !== null &&
    storage !== undefined &&
    typeof storage.getItem === "function" &&
    typeof storage.setItem === "function" &&
    typeof storage.removeItem === "function"
  );
}

export function resolveStorage(storage: Partial<StateStorage> | null | undefined): StateStorage {
  return isStateStorage(storage) ? storage : createMemoryStorage();
}

export function createDebouncedStorage(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedStorage {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: string) => {
      resolvedStorage.setItem(name, value);
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => resolvedStorage.getItem(name),
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}

export interface DebouncedPersistStorage<S> extends PersistStorage<S> {
  flush: () => void;
}

/**
 * A zustand `PersistStorage` that debounces the JSON serialization as well as
 * the storage write. `createJSONStorage` + a debounced `StateStorage` only
 * delays the write — the full state is still stringified on every store
 * update; here it happens once per debounce window instead.
 */
export function createDebouncedJsonStorage<S>(
  baseStorage: Partial<StateStorage> | null | undefined,
  debounceMs: number = 300,
): DebouncedPersistStorage<S> {
  const resolvedStorage = resolveStorage(baseStorage);
  const debouncedSetItem = new Debouncer(
    (name: string, value: StorageValue<S>) => {
      resolvedStorage.setItem(name, JSON.stringify(value));
    },
    { wait: debounceMs },
  );

  return {
    getItem: (name) => {
      const raw = resolvedStorage.getItem(name);
      const parse = (value: string | null): StorageValue<S> | null =>
        value === null ? null : (JSON.parse(value) as StorageValue<S>);
      return raw instanceof Promise ? raw.then(parse) : parse(raw);
    },
    setItem: (name, value) => {
      debouncedSetItem.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedSetItem.cancel();
      resolvedStorage.removeItem(name);
    },
    flush: () => {
      debouncedSetItem.flush();
    },
  };
}
