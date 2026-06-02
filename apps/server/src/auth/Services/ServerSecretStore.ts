import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class SecretStoreError extends Schema.TaggedErrorClass<SecretStoreError>()(
  "SecretStoreError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface ServerSecretStoreShape {
  readonly get: (name: string) => Effect.Effect<Option.Option<Uint8Array>, SecretStoreError>;
  readonly set: (name: string, value: Uint8Array) => Effect.Effect<void, SecretStoreError>;
  readonly getOrCreateRandom: (
    name: string,
    bytes: number,
  ) => Effect.Effect<Uint8Array, SecretStoreError>;
  readonly remove: (name: string) => Effect.Effect<void, SecretStoreError>;
}

export class ServerSecretStore extends Context.Service<ServerSecretStore, ServerSecretStoreShape>()(
  "t3/auth/Services/ServerSecretStore",
) {}
