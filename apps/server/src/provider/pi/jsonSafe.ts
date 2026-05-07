import type { Schema } from "effect";

export type PiJsonValue = Schema.Json;

function toPiJsonValueInternal(value: unknown, seen: WeakSet<object>): PiJsonValue | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      return value.map((item) => toPiJsonValueInternal(item, seen) ?? null);
    } finally {
      seen.delete(value);
    }
  }

  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return undefined;
    seen.add(value);
    try {
      const out: Record<string, PiJsonValue> = {};
      for (const [key, nested] of Object.entries(value)) {
        const jsonValue = toPiJsonValueInternal(nested, seen);
        if (jsonValue !== undefined) {
          out[key] = jsonValue;
        }
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  return undefined;
}

export function toPiJsonValue(value: unknown): PiJsonValue | undefined {
  return toPiJsonValueInternal(value, new WeakSet());
}
