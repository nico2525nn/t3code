import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ExpoCrypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { p256 } from "@noble/curves/nist";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  DpopPublicJwk,
  normalizeDpopHtu,
} from "@t3tools/shared/dpop";
import * as Layer from "effect/Layer";

export class CloudDpopError extends Schema.TaggedErrorClass<CloudDpopError>()("CloudDpopError", {
  operation: Schema.Literals([
    "generate-key-randomness",
    "derive-public-key",
    "read-key",
    "decode-key",
    "validate-key",
    "encode-key",
    "store-key",
    "normalize-proof-url",
    "import-private-key",
    "generate-proof-id",
    "encode-proof-header",
    "encode-proof-payload",
    "hash-signing-input",
    "sign-proof",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Cloud DPoP operation "${this.operation}" failed.`;
  }
}

export class DpopPublicKeyFormatError extends Schema.TaggedErrorClass<DpopPublicKeyFormatError>()(
  "DpopPublicKeyFormatError",
  {
    byteLength: Schema.Number,
    firstByte: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    const prefix =
      this.firstByte === undefined
        ? "no prefix byte"
        : `prefix 0x${this.firstByte.toString(16).padStart(2, "0")}`;
    return `Expected a 65-byte uncompressed P-256 public key beginning with 0x04; received ${this.byteLength} bytes with ${prefix}.`;
  }
}

export class DpopStoredPublicKeyMismatchError extends Schema.TaggedErrorClass<DpopStoredPublicKeyMismatchError>()(
  "DpopStoredPublicKeyMismatchError",
  {},
) {
  override get message(): string {
    return "Stored DPoP private and public key material do not match.";
  }
}

const DpopPrivateJwkSchema = Schema.Struct({
  ...DpopPublicJwk.fields,
  d: Schema.String,
});

const DpopPrivateJwkJson = Schema.fromJsonString(DpopPrivateJwkSchema);
const decodeDpopPrivateJwkJson = Schema.decodeUnknownEffect(DpopPrivateJwkJson);
const encodeDpopPrivateJwkJson = Schema.encodeEffect(DpopPrivateJwkJson);

const DpopJwtHeaderJson = Schema.fromJsonString(
  Schema.Struct({
    typ: Schema.Literal("dpop+jwt"),
    alg: Schema.Literal("ES256"),
    jwk: DpopPublicJwk,
  }),
);

const DpopJwtPayloadJson = Schema.fromJsonString(
  Schema.Struct({
    htm: Schema.String,
    htu: Schema.String,
    jti: Schema.String,
    iat: Schema.Int,
    ath: Schema.optionalKey(Schema.String),
  }),
);

const encodeDpopJwtHeaderJson = Schema.encodeEffect(DpopJwtHeaderJson);
const encodeDpopJwtPayloadJson = Schema.encodeEffect(DpopJwtPayloadJson);

function toExpoDigestAlgorithm(
  algorithm: Crypto.DigestAlgorithm,
): ExpoCrypto.CryptoDigestAlgorithm {
  switch (algorithm) {
    case "SHA-1":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA1;
    case "SHA-256":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA256;
    case "SHA-384":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA384;
    case "SHA-512":
      return ExpoCrypto.CryptoDigestAlgorithm.SHA512;
  }
}

export const cryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: ExpoCrypto.getRandomBytes,
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await ExpoCrypto.digest(toExpoDigestAlgorithm(algorithm), input));
      }),
  }),
);

type DpopPrivateJwk = typeof DpopPrivateJwkSchema.Type;

export interface DpopProofKeyPair {
  readonly privateJwk: DpopPrivateJwk;
  readonly publicJwk: DpopPublicJwk;
  readonly thumbprint: string;
}

const DPOP_PROOF_KEY_STORAGE_KEY = "t3code.cloud.dpop-proof-key";

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Encoding.decodeBase64Url(value));
}

function sha256Digest(data: Uint8Array): Effect.Effect<Uint8Array, CloudDpopError, Crypto.Crypto> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.digest("SHA-256", data)),
    Effect.mapError((cause) => new CloudDpopError({ operation: "hash-signing-input", cause })),
  );
}

function secureRandomBytes(
  byteCount: number,
): Effect.Effect<Uint8Array, CloudDpopError, Crypto.Crypto> {
  return Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomBytes(byteCount)),
    Effect.mapError((cause) => new CloudDpopError({ operation: "generate-key-randomness", cause })),
  );
}

function publicJwkFromUncompressedPublicKey(publicKey: Uint8Array): DpopPublicJwk {
  if (publicKey.length !== 65 || publicKey[0] !== 0x04) {
    throw new DpopPublicKeyFormatError({
      byteLength: publicKey.length,
      ...(publicKey[0] === undefined ? {} : { firstByte: publicKey[0] }),
    });
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: Encoding.encodeBase64Url(publicKey.slice(1, 33)),
    y: Encoding.encodeBase64Url(publicKey.slice(33, 65)),
  };
}

function privateJwkFromPrivateKey(
  privateKey: Uint8Array,
  publicJwk: DpopPublicJwk,
): DpopPrivateJwk {
  return { ...publicJwk, d: Encoding.encodeBase64Url(privateKey) };
}

export function generateDpopProofKeyPair(): Effect.Effect<
  DpopProofKeyPair,
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    let privateKey: Uint8Array;
    do {
      privateKey = yield* secureRandomBytes(p256.CURVE.nByteLength);
    } while (!p256.utils.isValidPrivateKey(privateKey));
    const publicJwk = yield* Effect.try({
      try: () => publicJwkFromUncompressedPublicKey(p256.getPublicKey(privateKey, false)),
      catch: (cause) => new CloudDpopError({ operation: "derive-public-key", cause }),
    });
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    return {
      privateJwk: privateJwkFromPrivateKey(privateKey, publicJwk),
      publicJwk,
      thumbprint,
    };
  });
}

export function loadOrCreateDpopProofKeyPair(): Effect.Effect<
  DpopProofKeyPair,
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    const stored = yield* Effect.tryPromise({
      try: () => SecureStore.getItemAsync(DPOP_PROOF_KEY_STORAGE_KEY),
      catch: (cause) => new CloudDpopError({ operation: "read-key", cause }),
    });
    if (stored) {
      const storedPrivateJwk = yield* decodeDpopPrivateJwkJson(stored).pipe(
        Effect.mapError((cause) => new CloudDpopError({ operation: "decode-key", cause })),
      );
      const restored = yield* Effect.try({
        try: () => {
          const privateKey = base64UrlToBytes(storedPrivateJwk.d);
          const publicJwk = publicJwkFromUncompressedPublicKey(
            p256.getPublicKey(privateKey, false),
          );
          if (publicJwk.x !== storedPrivateJwk.x || publicJwk.y !== storedPrivateJwk.y) {
            throw new DpopStoredPublicKeyMismatchError();
          }
          return { privateJwk: storedPrivateJwk, publicJwk };
        },
        catch: (cause) => new CloudDpopError({ operation: "validate-key", cause }),
      });
      return {
        ...restored,
        thumbprint: computeDpopJwkThumbprint(restored.publicJwk),
      };
    }
    const generated = yield* generateDpopProofKeyPair();
    const encodedPrivateJwk = yield* encodeDpopPrivateJwkJson(generated.privateJwk).pipe(
      Effect.mapError((cause) => new CloudDpopError({ operation: "encode-key", cause })),
    );
    yield* Effect.tryPromise({
      try: () => SecureStore.setItemAsync(DPOP_PROOF_KEY_STORAGE_KEY, encodedPrivateJwk),
      catch: (cause) => new CloudDpopError({ operation: "store-key", cause }),
    });
    return generated;
  });
}

function normalizeHtu(url: string): Effect.Effect<string, CloudDpopError> {
  const normalized = normalizeDpopHtu(url);
  return normalized
    ? Effect.succeed(normalized)
    : Effect.fail(new CloudDpopError({ operation: "normalize-proof-url" }));
}

export function createDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string;
  readonly proofKey?: DpopProofKeyPair;
}): Effect.Effect<
  { readonly proof: string; readonly thumbprint: string },
  CloudDpopError,
  Crypto.Crypto
> {
  return Effect.gen(function* () {
    const keyPair = input.proofKey ?? (yield* generateDpopProofKeyPair());
    const privateKey = yield* Effect.try({
      try: () => base64UrlToBytes(keyPair.privateJwk.d),
      catch: (cause) => new CloudDpopError({ operation: "import-private-key", cause }),
    });
    const nowMs = yield* Clock.currentTimeMillis;
    const jti = yield* Crypto.Crypto.pipe(
      Effect.flatMap((crypto) => crypto.randomUUIDv4),
      Effect.mapError((cause) => new CloudDpopError({ operation: "generate-proof-id", cause })),
    );
    const htu = yield* normalizeHtu(input.url);
    const header = yield* encodeDpopJwtHeaderJson({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: keyPair.publicJwk,
    }).pipe(
      Effect.map(Encoding.encodeBase64Url),
      Effect.mapError((cause) => new CloudDpopError({ operation: "encode-proof-header", cause })),
    );
    const ath = input.accessToken ? computeDpopAccessTokenHash(input.accessToken) : null;
    const payload = yield* encodeDpopJwtPayloadJson({
      htm: input.method.toUpperCase(),
      htu,
      jti,
      iat: Math.floor(nowMs / 1_000),
      ...(ath ? { ath } : {}),
    }).pipe(
      Effect.map(Encoding.encodeBase64Url),
      Effect.mapError((cause) => new CloudDpopError({ operation: "encode-proof-payload", cause })),
    );
    const signatureInputHash = yield* sha256Digest(
      new TextEncoder().encode(`${header}.${payload}`),
    );
    const signature = yield* Effect.try({
      try: () => p256.sign(signatureInputHash, privateKey, { prehash: false }).toCompactRawBytes(),
      catch: (cause) => new CloudDpopError({ operation: "sign-proof", cause }),
    });
    return {
      proof: `${header}.${payload}.${Encoding.encodeBase64Url(signature)}`,
      thumbprint: keyPair.thumbprint,
    };
  });
}
