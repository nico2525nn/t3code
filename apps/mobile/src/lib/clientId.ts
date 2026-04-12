import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

export function newClientId(prefix: string): string {
  return `${prefix}-${Effect.runSync(Random.nextUUIDv4)}`;
}
