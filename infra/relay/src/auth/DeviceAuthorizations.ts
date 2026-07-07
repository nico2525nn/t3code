import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { and, eq, gt, lt } from "drizzle-orm";

import * as RelayDb from "../db.ts";
import { relayDeviceAuthorizations } from "../persistence/schema.ts";

export class DeviceAuthorizationPersistenceError extends Schema.TaggedErrorClass<DeviceAuthorizationPersistenceError>()(
  "DeviceAuthorizationPersistenceError",
  {
    operation: Schema.Literals([
      "create",
      "find-by-user-code",
      "find-by-device-code",
      "begin-approval",
      "complete-approval",
      "deny",
      "stamp-polled",
      "take-approved",
      "delete",
      "prune-expired",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist device authorization state during '${this.operation}'`;
  }
}

export type DeviceAuthorizationRecord = typeof relayDeviceAuthorizations.$inferSelect;

export class DeviceAuthorizations extends Context.Service<
  DeviceAuthorizations,
  {
    readonly create: (input: {
      readonly deviceCodeHash: string;
      readonly userCode: string;
      readonly clientId: string;
      readonly scope: string;
      readonly codeChallenge: string;
      readonly deviceName: string | null;
      readonly devicePlatform: string | null;
      readonly clientVersion: string | null;
      readonly requestIp: string | null;
      readonly requestLocation: string | null;
      readonly pollIntervalSeconds: number;
      readonly expiresAt: DateTime.DateTime;
    }) => Effect.Effect<void, DeviceAuthorizationPersistenceError>;
    readonly findByUserCode: (
      userCode: string,
    ) => Effect.Effect<DeviceAuthorizationRecord | null, DeviceAuthorizationPersistenceError>;
    readonly findByDeviceCodeHash: (
      deviceCodeHash: string,
    ) => Effect.Effect<DeviceAuthorizationRecord | null, DeviceAuthorizationPersistenceError>;
    readonly beginApproval: (input: {
      readonly userCode: string;
      readonly callbackState: string;
      readonly redirectUri: string;
      readonly now: DateTime.DateTime;
    }) => Effect.Effect<DeviceAuthorizationRecord | null, DeviceAuthorizationPersistenceError>;
    readonly completeApproval: (input: {
      readonly callbackState: string;
      readonly authorizationCode: string;
      readonly userId: string;
      readonly now: DateTime.DateTime;
    }) => Effect.Effect<DeviceAuthorizationRecord | null, DeviceAuthorizationPersistenceError>;
    readonly deny: (input: {
      readonly userCode: string;
      readonly userId: string;
      readonly now: DateTime.DateTime;
    }) => Effect.Effect<DeviceAuthorizationRecord | null, DeviceAuthorizationPersistenceError>;
    readonly stampPolled: (input: {
      readonly deviceCodeHash: string;
      readonly now: DateTime.DateTime;
    }) => Effect.Effect<void, DeviceAuthorizationPersistenceError>;
    readonly takeApproved: (
      deviceCodeHash: string,
    ) => Effect.Effect<DeviceAuthorizationRecord | null, DeviceAuthorizationPersistenceError>;
    readonly deleteByDeviceCodeHash: (
      deviceCodeHash: string,
    ) => Effect.Effect<void, DeviceAuthorizationPersistenceError>;
    readonly pruneExpired: Effect.Effect<void, DeviceAuthorizationPersistenceError>;
  }
>()("t3code-relay/auth/DeviceAuthorizations") {}

const persistenceError =
  (operation: DeviceAuthorizationPersistenceError["operation"]) => (cause: unknown) =>
    new DeviceAuthorizationPersistenceError({ operation, cause });

const make = Effect.gen(function* () {
  const db = yield* RelayDb.RelayDb;

  const firstOrNull = (rows: ReadonlyArray<DeviceAuthorizationRecord>) => rows[0] ?? null;

  const create: DeviceAuthorizations["Service"]["create"] = Effect.fn(
    "relay.device_authorizations.create",
  )(function* (input) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* db
      .insert(relayDeviceAuthorizations)
      .values({
        deviceCodeHash: input.deviceCodeHash,
        userCode: input.userCode,
        clientId: input.clientId,
        scope: input.scope,
        codeChallenge: input.codeChallenge,
        status: "pending",
        deviceName: input.deviceName,
        devicePlatform: input.devicePlatform,
        clientVersion: input.clientVersion,
        requestIp: input.requestIp,
        requestLocation: input.requestLocation,
        pollIntervalSeconds: input.pollIntervalSeconds,
        expiresAt: DateTime.formatIso(input.expiresAt),
        createdAt: now,
        updatedAt: now,
      })
      .pipe(Effect.mapError(persistenceError("create")));
  });

  const findByUserCode: DeviceAuthorizations["Service"]["findByUserCode"] = Effect.fn(
    "relay.device_authorizations.find_by_user_code",
  )(function* (userCode) {
    return firstOrNull(
      yield* db
        .select()
        .from(relayDeviceAuthorizations)
        .where(eq(relayDeviceAuthorizations.userCode, userCode))
        .limit(1)
        .pipe(Effect.mapError(persistenceError("find-by-user-code"))),
    );
  });

  const findByDeviceCodeHash: DeviceAuthorizations["Service"]["findByDeviceCodeHash"] = Effect.fn(
    "relay.device_authorizations.find_by_device_code",
  )(function* (deviceCodeHash) {
    return firstOrNull(
      yield* db
        .select()
        .from(relayDeviceAuthorizations)
        .where(eq(relayDeviceAuthorizations.deviceCodeHash, deviceCodeHash))
        .limit(1)
        .pipe(Effect.mapError(persistenceError("find-by-device-code"))),
    );
  });

  const beginApproval: DeviceAuthorizations["Service"]["beginApproval"] = Effect.fn(
    "relay.device_authorizations.begin_approval",
  )(function* (input) {
    const now = DateTime.formatIso(input.now);
    return firstOrNull(
      yield* db
        .update(relayDeviceAuthorizations)
        .set({
          callbackState: input.callbackState,
          redirectUri: input.redirectUri,
          updatedAt: now,
        })
        .where(
          and(
            eq(relayDeviceAuthorizations.userCode, input.userCode),
            eq(relayDeviceAuthorizations.status, "pending"),
            gt(relayDeviceAuthorizations.expiresAt, now),
          ),
        )
        .returning()
        .pipe(Effect.mapError(persistenceError("begin-approval"))),
    );
  });

  const completeApproval: DeviceAuthorizations["Service"]["completeApproval"] = Effect.fn(
    "relay.device_authorizations.complete_approval",
  )(function* (input) {
    const now = DateTime.formatIso(input.now);
    return firstOrNull(
      yield* db
        .update(relayDeviceAuthorizations)
        .set({
          status: "approved",
          authorizationCode: input.authorizationCode,
          userId: input.userId,
          updatedAt: now,
        })
        .where(
          and(
            eq(relayDeviceAuthorizations.callbackState, input.callbackState),
            eq(relayDeviceAuthorizations.status, "pending"),
            gt(relayDeviceAuthorizations.expiresAt, now),
          ),
        )
        .returning()
        .pipe(Effect.mapError(persistenceError("complete-approval"))),
    );
  });

  const deny: DeviceAuthorizations["Service"]["deny"] = Effect.fn(
    "relay.device_authorizations.deny",
  )(function* (input) {
    const now = DateTime.formatIso(input.now);
    return firstOrNull(
      yield* db
        .update(relayDeviceAuthorizations)
        .set({
          status: "denied",
          userId: input.userId,
          updatedAt: now,
        })
        .where(
          and(
            eq(relayDeviceAuthorizations.userCode, input.userCode),
            eq(relayDeviceAuthorizations.status, "pending"),
            gt(relayDeviceAuthorizations.expiresAt, now),
          ),
        )
        .returning()
        .pipe(Effect.mapError(persistenceError("deny"))),
    );
  });

  const stampPolled: DeviceAuthorizations["Service"]["stampPolled"] = Effect.fn(
    "relay.device_authorizations.stamp_polled",
  )(function* (input) {
    yield* db
      .update(relayDeviceAuthorizations)
      .set({ lastPolledAt: DateTime.formatIso(input.now) })
      .where(eq(relayDeviceAuthorizations.deviceCodeHash, input.deviceCodeHash))
      .pipe(Effect.mapError(persistenceError("stamp-polled")));
  });

  const takeApproved: DeviceAuthorizations["Service"]["takeApproved"] = Effect.fn(
    "relay.device_authorizations.take_approved",
  )(function* (deviceCodeHash) {
    return firstOrNull(
      yield* db
        .delete(relayDeviceAuthorizations)
        .where(
          and(
            eq(relayDeviceAuthorizations.deviceCodeHash, deviceCodeHash),
            eq(relayDeviceAuthorizations.status, "approved"),
          ),
        )
        .returning()
        .pipe(Effect.mapError(persistenceError("take-approved"))),
    );
  });

  const deleteByDeviceCodeHash: DeviceAuthorizations["Service"]["deleteByDeviceCodeHash"] =
    Effect.fn("relay.device_authorizations.delete")(function* (deviceCodeHash) {
      yield* db
        .delete(relayDeviceAuthorizations)
        .where(eq(relayDeviceAuthorizations.deviceCodeHash, deviceCodeHash))
        .pipe(Effect.mapError(persistenceError("delete")));
    });

  const pruneExpired: DeviceAuthorizations["Service"]["pruneExpired"] = Effect.gen(function* () {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.annotateCurrentSpan({ "relay.device_authorization_prune.before": now });
    yield* db
      .delete(relayDeviceAuthorizations)
      .where(lt(relayDeviceAuthorizations.expiresAt, now))
      .pipe(Effect.mapError(persistenceError("prune-expired")));
  }).pipe(Effect.withSpan("relay.device_authorizations.prune_expired"));

  return DeviceAuthorizations.of({
    create,
    findByUserCode,
    findByDeviceCodeHash,
    beginApproval,
    completeApproval,
    deny,
    stampPolled,
    takeApproved,
    deleteByDeviceCodeHash,
    pruneExpired,
  });
});

export const layer = Layer.effect(DeviceAuthorizations, make);
