import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SecureStore from "expo-secure-store";

const MANAGED_RELAY_TOKEN_CACHE_KEY = "t3code.cloud.relay-access-tokens";
const MANAGED_RELAY_TOKEN_CACHE_VERSION = 1;

const ManagedRelayAccessTokenCacheEntrySchema = Schema.Struct({
  accountId: Schema.String,
  clientId: Schema.Literals(["t3-mobile", "t3-web"]),
  relayUrl: Schema.String,
  thumbprint: Schema.String,
  scopes: Schema.Array(
    Schema.Literals(["environment:connect", "environment:status", "mobile:registration"]),
  ),
  accessToken: Schema.String,
  expiresAtMillis: Schema.Number,
});

const ManagedRelayAccessTokenCacheSchema = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(MANAGED_RELAY_TOKEN_CACHE_VERSION),
    entries: Schema.Array(ManagedRelayAccessTokenCacheEntrySchema),
  }),
);

const decodeManagedRelayAccessTokenCache = Schema.decodeUnknownEffect(
  ManagedRelayAccessTokenCacheSchema,
);
const encodeManagedRelayAccessTokenCache = Schema.encodeEffect(ManagedRelayAccessTokenCacheSchema);

export class ManagedRelayTokenStoreError extends Schema.TaggedErrorClass<ManagedRelayTokenStoreError>()(
  "ManagedRelayTokenStoreError",
  {
    operation: Schema.Literals([
      "read-cache",
      "decode-cache",
      "encode-cache",
      "write-cache",
      "clear-cache",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Managed relay token store operation "${this.operation}" failed.`;
  }
}

export const isManagedRelayTokenStoreError = Schema.is(ManagedRelayTokenStoreError);

function logStoreFailure(error: ManagedRelayTokenStoreError) {
  return Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      error,
      errorTag: error._tag,
      operation: error.operation,
    }),
  );
}

const loadManagedRelayAccessTokens = Effect.tryPromise({
  try: () => SecureStore.getItemAsync(MANAGED_RELAY_TOKEN_CACHE_KEY),
  catch: (cause) => new ManagedRelayTokenStoreError({ operation: "read-cache", cause }),
}).pipe(
  Effect.flatMap((encoded) =>
    encoded === null
      ? Effect.succeed<ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry>>([])
      : decodeManagedRelayAccessTokenCache(encoded).pipe(
          Effect.map((cache) => cache.entries),
          Effect.mapError(
            (cause) => new ManagedRelayTokenStoreError({ operation: "decode-cache", cause }),
          ),
        ),
  ),
);

const saveManagedRelayAccessTokens = (
  entries: ReadonlyArray<ManagedRelay.ManagedRelayAccessTokenCacheEntry>,
) =>
  encodeManagedRelayAccessTokenCache({
    version: MANAGED_RELAY_TOKEN_CACHE_VERSION,
    entries,
  }).pipe(
    Effect.mapError(
      (cause) => new ManagedRelayTokenStoreError({ operation: "encode-cache", cause }),
    ),
    Effect.flatMap((encoded) =>
      Effect.tryPromise({
        try: () => SecureStore.setItemAsync(MANAGED_RELAY_TOKEN_CACHE_KEY, encoded),
        catch: (cause) => new ManagedRelayTokenStoreError({ operation: "write-cache", cause }),
      }),
    ),
  );

const clearManagedRelayAccessTokens = Effect.tryPromise({
  try: () => SecureStore.deleteItemAsync(MANAGED_RELAY_TOKEN_CACHE_KEY),
  catch: (cause) => new ManagedRelayTokenStoreError({ operation: "clear-cache", cause }),
});

export const managedRelayAccessTokenStore: ManagedRelay.ManagedRelayAccessTokenStore = {
  load: loadManagedRelayAccessTokens.pipe(
    Effect.tapError(logStoreFailure),
    Effect.orElseSucceed(() => []),
    Effect.withSpan("mobile.managedRelayTokenStore.load"),
  ),
  save: Effect.fn("mobile.managedRelayTokenStore.save")((entries) =>
    saveManagedRelayAccessTokens(entries).pipe(Effect.tapError(logStoreFailure), Effect.ignore),
  ),
  clear: clearManagedRelayAccessTokens.pipe(
    Effect.tapError(logStoreFailure),
    Effect.ignore,
    Effect.withSpan("mobile.managedRelayTokenStore.clear"),
  ),
};
