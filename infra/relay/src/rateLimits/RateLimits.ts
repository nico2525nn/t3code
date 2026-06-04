import type * as Cloudflare from "alchemy/Cloudflare";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { RelayRateLimitTier } from "@t3tools/contracts/relay";

export const RELAY_RATE_LIMIT_OPERATIONS = [
  "token_exchange",
  "link_challenge",
  "managed_endpoint_provision",
  "environment_connect",
  "environment_status",
  "mobile_registration",
  "agent_activity_publish",
] as const;

export type RelayRateLimitOperation = (typeof RELAY_RATE_LIMIT_OPERATIONS)[number];

export const RELAY_RATE_LIMITS = {
  token_exchange: { limit: 20, period: 60 },
  link_challenge: { limit: 10, period: 60 },
  managed_endpoint_provision: { limit: 5, period: 60 },
  environment_connect: { limit: 20, period: 60 },
  environment_status: { limit: 30, period: 60 },
  mobile_registration: { limit: 10, period: 60 },
  agent_activity_publish: { limit: 60, period: 10 },
} as const satisfies Readonly<Record<RelayRateLimitOperation, { limit: number; period: number }>>;

type ActiveRelayRateLimitTier = Exclude<RelayRateLimitTier, "blocked">;

export function mapRelayRateLimitOperations<A>(
  map: (operation: RelayRateLimitOperation) => A,
): Readonly<Record<RelayRateLimitOperation, A>> {
  return Object.fromEntries(
    RELAY_RATE_LIMIT_OPERATIONS.map((operation) => [operation, map(operation)]),
  ) as Record<RelayRateLimitOperation, A>;
}

export class RelayRateLimitExceeded extends Data.TaggedError("RelayRateLimitExceeded")<{
  readonly operation: RelayRateLimitOperation;
  readonly retryAfterSeconds: number;
}> {}

export type RelayRateLimitClients = Readonly<
  Record<
    RelayRateLimitOperation,
    Readonly<Record<ActiveRelayRateLimitTier, Cloudflare.RateLimitClient>>
  >
>;

export interface RateLimitsShape {
  readonly check: (input: {
    readonly operation: RelayRateLimitOperation;
    readonly key: string;
    readonly tier?: RelayRateLimitTier;
  }) => Effect.Effect<void, RelayRateLimitExceeded, Cloudflare.WorkerEnvironment>;
}

export class RateLimits extends Context.Service<RateLimits, RateLimitsShape>()(
  "t3code-relay/rateLimits/RateLimits",
) {}

export const layerCloudflareBindings = (clients: RelayRateLimitClients) =>
  Layer.succeed(
    RateLimits,
    RateLimits.of({
      check: Effect.fn("relay.rate_limits.check")(function* (input) {
        const tier = input.tier ?? "standard";
        const config = RELAY_RATE_LIMITS[input.operation];
        yield* Effect.annotateCurrentSpan({
          "relay.rate_limit.operation": input.operation,
          "relay.rate_limit.tier": tier,
        });
        if (tier === "blocked") {
          return yield* new RelayRateLimitExceeded({
            operation: input.operation,
            retryAfterSeconds: config.period,
          });
        }
        const result = yield* clients[input.operation][tier].limit({ key: input.key }).pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("relay rate limit binding failed open", {
              cause,
              operation: input.operation,
              tier,
            }),
          ),
          Effect.orElseSucceed(() => ({ success: true })),
        );
        if (!result.success) {
          return yield* new RelayRateLimitExceeded({
            operation: input.operation,
            retryAfterSeconds: config.period,
          });
        }
      }),
    }),
  );

export const layerAllowAll = Layer.succeed(
  RateLimits,
  RateLimits.of({
    check: () => Effect.void,
  }),
);
