import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
} from "@t3tools/contracts/relay";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import { findErrorTraceId } from "../errors/errorTrace.ts";
import * as ManagedRelay from "./managedRelay.ts";

const DEFAULT_STALE_TIME = Duration.seconds(15);
const DEFAULT_IDLE_TTL = Duration.minutes(5);
const CLERK_TOKEN_EXPIRY_SKEW = Duration.seconds(5);

export interface ManagedRelaySession {
  readonly accountId: string;
  readonly readClerkToken: () => Effect.Effect<Option.Option<string>, ManagedRelaySessionError>;
}

export interface ManagedRelaySessionInput {
  readonly accountId: string;
  readonly readClerkToken: () => Effect.Effect<Option.Option<string>, ManagedRelaySessionError>;
}

interface ManagedRelaySessionControl {
  readonly updateReadClerkToken: (
    readClerkToken: ManagedRelaySessionInput["readClerkToken"],
  ) => void;
}

export interface ManagedRelaySnapshotState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly errorTraceId: string | null;
  readonly isPending: boolean;
}

export interface ManagedRelayQueryEvent {
  readonly operation: "environments" | "devices" | "environment-status";
  readonly stage: "clerk-token" | "relay-request" | "validation";
  readonly phase: "start" | "success" | "failure";
  readonly accountId: string;
  readonly environmentId?: string;
  readonly message?: string;
  readonly traceId?: string | null;
}

export class ManagedRelaySessionTokenReadError extends Schema.TaggedErrorClass<ManagedRelaySessionTokenReadError>()(
  "ManagedRelaySessionTokenReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not obtain the T3 Cloud session token.";
  }
}

export class ManagedRelaySessionTokenUnavailableError extends Schema.TaggedErrorClass<ManagedRelaySessionTokenUnavailableError>()(
  "ManagedRelaySessionTokenUnavailableError",
  { reason: Schema.Literals(["missing-session", "missing-token"]) },
) {
  override get message(): string {
    return this.reason === "missing-session"
      ? "Sign in to T3 Cloud before loading relay data."
      : "The T3 Cloud session token is unavailable.";
  }
}

export const ManagedRelaySessionError = Schema.Union([
  ManagedRelaySessionTokenReadError,
  ManagedRelaySessionTokenUnavailableError,
]);
export type ManagedRelaySessionError = typeof ManagedRelaySessionError.Type;

export class ManagedRelaySnapshotError extends Schema.TaggedErrorClass<ManagedRelaySnapshotError>()(
  "ManagedRelaySnapshotError",
  { message: Schema.String },
) {}

export const managedRelaySessionAtom = Atom.make<ManagedRelaySession | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("managed-relay:session"),
);

const managedRelaySessionControls = new WeakMap<ManagedRelaySession, ManagedRelaySessionControl>();

interface CachedClerkToken {
  readonly token: string;
  readonly expiresAtMillis: number;
}

interface PendingClerkTokenRead {
  readonly deferred: Deferred.Deferred<Option.Option<string>, ManagedRelaySessionError>;
}

interface ManagedRelaySessionCacheState {
  readonly readClerkToken: ManagedRelaySessionInput["readClerkToken"];
  readonly generation: number;
  readonly cachedToken: Option.Option<CachedClerkToken>;
  readonly pendingToken: Option.Option<PendingClerkTokenRead>;
}

function isFreshCachedToken(cachedToken: CachedClerkToken, nowMillis: number): boolean {
  return (
    cachedToken.expiresAtMillis >
    nowMillis + Duration.toMillis(CLERK_TOKEN_EXPIRY_SKEW)
  );
}

function decodeCachedToken(token: string): Option.Option<CachedClerkToken> {
  try {
    const expiresAtSeconds = decodeRelayJwt(token).exp;
    return typeof expiresAtSeconds === "number"
      ? Option.some({ token, expiresAtMillis: expiresAtSeconds * 1_000 })
      : Option.none();
  } catch {
    return Option.none();
  }
}

export function createManagedRelaySession(input: ManagedRelaySessionInput): ManagedRelaySession {
  let state: ManagedRelaySessionCacheState = {
    readClerkToken: input.readClerkToken,
    generation: 0,
    cachedToken: Option.none(),
    pendingToken: Option.none(),
  };

  const session: ManagedRelaySession = {
    accountId: input.accountId,
    readClerkToken: Effect.fn("clientRuntime.managedRelaySession.readClerkToken")(function* () {
      const nowMillis = yield* Clock.currentTimeMillis;
      const current = state;
      if (
        Option.isSome(current.cachedToken) &&
        isFreshCachedToken(current.cachedToken.value, nowMillis)
      ) {
        return Option.some(current.cachedToken.value.token);
      }
      if (Option.isSome(current.pendingToken)) {
        return yield* Deferred.await(current.pendingToken.value.deferred);
      }

      const deferred = yield* Deferred.make<Option.Option<string>, ManagedRelaySessionError>();
      state = {
        ...state,
        pendingToken: Option.some({ deferred }),
      };

      const readExit = yield* Effect.exit(current.readClerkToken());
      if (Exit.isSuccess(readExit)) {
        if (state.generation === current.generation) {
          state = {
            ...state,
            cachedToken: Option.isSome(readExit.value)
              ? decodeCachedToken(readExit.value.value)
              : Option.none(),
          };
        }
        yield* Deferred.succeed(deferred, readExit.value).pipe(Effect.orDie);
      } else {
        yield* Deferred.failCause(deferred, readExit.cause).pipe(Effect.orDie);
      }

      if (
        Option.isSome(state.pendingToken) &&
        state.pendingToken.value.deferred === deferred
      ) {
        state = {
          ...state,
          pendingToken: Option.none(),
        };
      }

      if (Exit.isSuccess(readExit)) {
        return readExit.value;
      }
      return yield* Effect.failCause(readExit.cause);
    }),
  };
  managedRelaySessionControls.set(session, {
    updateReadClerkToken: (nextReadClerkToken) => {
      state = {
        readClerkToken: nextReadClerkToken,
        generation: state.generation + 1,
        cachedToken: Option.none(),
        pendingToken: Option.none(),
      };
    },
  });
  return session;
}

export function setManagedRelaySession(
  registry: AtomRegistry.AtomRegistry,
  input: ManagedRelaySessionInput | null,
): void {
  const current = registry.get(managedRelaySessionAtom);
  if (input === null) {
    if (current !== null) {
      registry.set(managedRelaySessionAtom, null);
    }
    return;
  }
  if (current?.accountId === input.accountId) {
    const control = managedRelaySessionControls.get(current);
    if (control) {
      // Clerk can replace its token reader during routine same-account refreshes.
      // Keep the session stable so those refreshes do not invalidate queries or reconnect leases.
      control.updateReadClerkToken(input.readClerkToken);
      return;
    }
  }
  registry.set(managedRelaySessionAtom, createManagedRelaySession(input));
}

export function managedRelayAccountChanges(
  registry: AtomRegistry.AtomRegistry,
): Stream.Stream<string | null> {
  return AtomRegistry.toStream(registry, managedRelaySessionAtom).pipe(
    Stream.map((session) => session?.accountId ?? null),
    Stream.changes,
    Stream.drop(1),
  );
}

function readSessionClerkToken(
  session: ManagedRelaySession,
): Effect.Effect<string, ManagedRelaySessionError> {
  return session.readClerkToken().pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(new ManagedRelaySessionTokenUnavailableError({ reason: "missing-token" })),
        onSome: Effect.succeed,
      }),
    ),
  );
}

export const waitForManagedRelayClerkToken = Effect.fn(
  "clientRuntime.managedRelaySession.waitForClerkToken",
)(function* (registry: AtomRegistry.AtomRegistry) {
  return yield* Effect.callback<string, ManagedRelaySessionError>((resume) => {
    let unsubscribe: (() => void) | undefined;
    let completed = false;
    const readCurrentSession = () => {
      if (completed) {
        return true;
      }
      const session = registry.get(managedRelaySessionAtom);
      if (!session) {
        return false;
      }
      completed = true;
      unsubscribe?.();
      resume(readSessionClerkToken(session));
      return true;
    };

    if (readCurrentSession()) {
      return;
    }

    unsubscribe = registry.subscribe(managedRelaySessionAtom, readCurrentSession);
    readCurrentSession();
    return Effect.sync(() => unsubscribe?.());
  });
});

function requireClerkToken(
  get: Atom.AtomContext,
  accountId: string,
): Effect.Effect<string, ManagedRelaySessionError> {
  const session = get(managedRelaySessionAtom);
  if (!session || session.accountId !== accountId) {
    return Effect.fail(
      new ManagedRelaySessionTokenUnavailableError({ reason: "missing-session" }),
    );
  }
  return readSessionClerkToken(session);
}

function statusKey(input: {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
}): string {
  return JSON.stringify(input);
}

function parseStatusKey(key: string): {
  readonly accountId: string;
  readonly environment: RelayClientEnvironmentRecord;
} {
  return JSON.parse(key) as {
    readonly accountId: string;
    readonly environment: RelayClientEnvironmentRecord;
  };
}

function endpointMatches(
  left: RelayClientEnvironmentRecord["endpoint"],
  right: RelayClientEnvironmentRecord["endpoint"],
): boolean {
  return (
    left.httpBaseUrl === right.httpBaseUrl &&
    left.wsBaseUrl === right.wsBaseUrl &&
    left.providerKind === right.providerKind
  );
}

function validateEnvironmentStatus(
  environment: RelayClientEnvironmentRecord,
  status: RelayEnvironmentStatusResponse,
): Effect.Effect<RelayEnvironmentStatusResponse, ManagedRelaySnapshotError> {
  if (status.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status for a different environment.",
      }),
    );
  }
  if (!endpointMatches(status.endpoint, environment.endpoint)) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status for a different endpoint.",
      }),
    );
  }
  if (status.descriptor && status.descriptor.environmentId !== environment.environmentId) {
    return Effect.fail(
      new ManagedRelaySnapshotError({
        message: "Relay returned status descriptor for a different environment.",
      }),
    );
  }
  return Effect.succeed(status);
}

export function readManagedRelaySnapshotState<A>(
  result: AsyncResult.AsyncResult<A, unknown>,
): ManagedRelaySnapshotState<A> {
  let error: string | null = null;
  let errorTraceId: string | null = null;
  if (result._tag === "Failure") {
    const cause = Cause.squash(result.cause);
    error = cause instanceof Error ? cause.message : "Could not load T3 Cloud data.";
    errorTraceId = findErrorTraceId(cause);
  }
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error,
    errorTraceId,
    isPending: result.waiting,
  };
}

export function createManagedRelayQueryManager(
  runtime: Atom.AtomRuntime<ManagedRelay.ManagedRelayClient>,
  options?: {
    readonly staleTimeMs?: number;
    readonly idleTtlMs?: number;
    readonly onQueryEvent?: (event: ManagedRelayQueryEvent) => void;
  },
) {
  const staleTime = options?.staleTimeMs ?? Duration.toMillis(DEFAULT_STALE_TIME);
  const idleTtl = options?.idleTtlMs ?? Duration.toMillis(DEFAULT_IDLE_TTL);
  const observe = <A, E, R>(
    input: Omit<ManagedRelayQueryEvent, "phase" | "message" | "traceId">,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      options?.onQueryEvent?.({ ...input, phase: "start" });
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (exit._tag === "Success") {
              options?.onQueryEvent?.({ ...input, phase: "success" });
              return;
            }
            const error = Cause.squash(exit.cause);
            options?.onQueryEvent?.({
              ...input,
              phase: "failure",
              message: error instanceof Error ? error.message : String(error),
              traceId: findErrorTraceId(error),
            });
          }),
        ),
      );
    });

  const environmentsAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "environments" as const, accountId };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.listEnvironments({ clerkToken }),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:environments:${accountId}`),
      ),
  );

  const devicesAtom = Atom.family((accountId: string) =>
    runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = { operation: "devices" as const, accountId };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          return yield* observe(
            { ...base, stage: "relay-request" },
            relay.listDevices({ clerkToken }),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:devices:${accountId}`),
      ),
  );

  const environmentStatusAtom = Atom.family((key: string) => {
    const { accountId, environment } = parseStatusKey(key);
    return runtime
      .atom((get) =>
        Effect.gen(function* () {
          const base = {
            operation: "environment-status" as const,
            accountId,
            environmentId: environment.environmentId,
          };
          const clerkToken = yield* observe(
            { ...base, stage: "clerk-token" },
            requireClerkToken(get, accountId),
          );
          const relay = yield* ManagedRelay.ManagedRelayClient;
          const status = yield* observe(
            { ...base, stage: "relay-request" },
            relay.getEnvironmentStatus({
              clerkToken,
              scopes: [RelayEnvironmentStatusScope, RelayEnvironmentConnectScope],
              environmentId: environment.environmentId,
            }),
          );
          return yield* observe(
            { ...base, stage: "validation" },
            validateEnvironmentStatus(environment, status),
          );
        }),
      )
      .pipe(
        Atom.swr({ staleTime, revalidateOnMount: true }),
        Atom.setIdleTTL(idleTtl),
        Atom.withLabel(`managed-relay:environment-status:${key}`),
      );
  });

  return {
    environmentsAtom,
    devicesAtom,
    environmentStatusAtom: (input: {
      readonly accountId: string;
      readonly environment: RelayClientEnvironmentRecord;
    }) => environmentStatusAtom(statusKey(input)),
    refreshEnvironments(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(environmentsAtom(accountId));
    },
    refreshDevices(registry: AtomRegistry.AtomRegistry, accountId: string): void {
      registry.refresh(devicesAtom(accountId));
    },
    refreshEnvironmentStatus(
      registry: AtomRegistry.AtomRegistry,
      input: {
        readonly accountId: string;
        readonly environment: RelayClientEnvironmentRecord;
      },
    ): void {
      registry.refresh(environmentStatusAtom(statusKey(input)));
    },
  };
}
