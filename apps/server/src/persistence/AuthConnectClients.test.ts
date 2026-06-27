import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AuthConnectClients from "./AuthConnectClients.ts";
import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";

const layer = AuthConnectClients.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

const client = {
  label: "Client",
  ipAddress: null,
  userAgent: null,
  deviceType: "desktop",
  os: "macOS",
  browser: null,
} satisfies AuthConnectClients.AuthConnectClientMetadataRecord;

it.effect("clears stale last-seen timestamps when a revoked client re-registers", () =>
  Effect.gen(function* () {
    const clients = yield* AuthConnectClients.AuthConnectClientRepository;
    const clientProofKeyThumbprint = "client-thumbprint";

    yield* clients.upsertRequest({
      clientProofKeyThumbprint,
      cloudUserId: "cloud-user",
      deviceId: "device-1",
      client,
      requestedAt: DateTime.makeUnsafe("2026-06-27T12:00:00.000Z"),
    });
    yield* clients.updateStatus({
      clientProofKeyThumbprint,
      status: "approved",
      decidedAt: DateTime.makeUnsafe("2026-06-27T12:01:00.000Z"),
    });
    const seen = yield* clients.markSeen({
      clientProofKeyThumbprint,
      seenAt: DateTime.makeUnsafe("2026-06-27T12:02:00.000Z"),
    });
    expect(Option.isSome(seen) ? seen.value.lastSeenAt : null).not.toBeNull();

    yield* clients.revoke({
      clientProofKeyThumbprint,
      revokedAt: DateTime.makeUnsafe("2026-06-27T12:03:00.000Z"),
    });
    const reregistered = yield* clients.upsertRequest({
      clientProofKeyThumbprint,
      cloudUserId: "cloud-user",
      deviceId: "device-1",
      client,
      requestedAt: DateTime.makeUnsafe("2026-06-27T12:04:00.000Z"),
    });

    expect(reregistered.status).toBe("pending");
    expect(reregistered.lastSeenAt).toBeNull();
  }).pipe(Effect.provide(layer)),
);
