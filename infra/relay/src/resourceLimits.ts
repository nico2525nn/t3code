import type { RelayQuotaResource } from "@t3tools/contracts/relay";
import * as Data from "effect/Data";

export const DEFAULT_MANAGED_ENDPOINT_LIMIT = 3;
export const DEFAULT_MOBILE_DEVICE_LIMIT = 5;
export const MAX_ACTIVE_AGENT_THREADS_PER_ENVIRONMENT = 50;
export const MAX_AGENT_AWARENESS_DELIVERY_USERS = 10;

export class ResourceQuotaExceeded extends Data.TaggedError("ResourceQuotaExceeded")<{
  readonly resource: RelayQuotaResource;
  readonly limit: number;
}> {}
