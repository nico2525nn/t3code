import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { stableStringify } from "./relaySigning.ts";

const DPOP_TYP = "dpop+jwt";
const DPOP_ALG = "ES256";
const DEFAULT_MAX_AGE_SECONDS = 300;
const decodeJsonStringOption = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const DpopPublicJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String.check(Schema.isNonEmpty()),
  y: Schema.String.check(Schema.isNonEmpty()),
});
export type DpopPublicJwk = typeof DpopPublicJwk.Type;

const DpopJwtHeader = Schema.Struct({
  typ: Schema.Literal(DPOP_TYP),
  alg: Schema.Literal(DPOP_ALG),
  jwk: DpopPublicJwk,
});
type DpopJwtHeader = typeof DpopJwtHeader.Type;
const decodeDpopJwtHeaderOption = Schema.decodeUnknownOption(DpopJwtHeader);

const DpopJwtPayload = Schema.Struct({
  htm: Schema.String.check(Schema.isNonEmpty()),
  htu: Schema.String.check(Schema.isNonEmpty()),
  jti: Schema.String.check(Schema.isNonEmpty()),
  iat: Schema.Int,
  ath: Schema.optional(Schema.String),
});
type DpopJwtPayload = typeof DpopJwtPayload.Type;
const decodeDpopJwtPayloadOption = Schema.decodeUnknownOption(DpopJwtPayload);

export type DpopVerificationResult =
  | {
      readonly ok: true;
      readonly thumbprint: string;
      readonly jti: string;
      readonly iat: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

function base64UrlToBytes(value: string): Uint8Array {
  return Result.getOrThrow(Encoding.decodeBase64Url(value));
}

function decodeBase64UrlJson(value: string): Option.Option<unknown> {
  return Result.match(Encoding.decodeBase64UrlString(value), {
    onFailure: () => Option.none(),
    onSuccess: decodeJsonStringOption,
  });
}

function hasPrivateJwkMaterial(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.jwk === "object" && record.jwk !== null && "d" in record.jwk;
}

function decodeDpopJwtHeader(value: unknown): Option.Option<DpopJwtHeader> {
  return hasPrivateJwkMaterial(value) ? Option.none() : decodeDpopJwtHeaderOption(value);
}

function dpopThumbprintInput(jwk: DpopPublicJwk): string {
  return stableStringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

export function normalizeDpopHtu(url: string): string | null {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.search = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function computeDpopJwkThumbprint(jwk: DpopPublicJwk): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(dpopThumbprintInput(jwk))));
}

export function computeDpopAccessTokenHash(accessToken: string): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(accessToken)));
}

function publicKeyBytesFromJwk(jwk: DpopPublicJwk): Uint8Array {
  const x = base64UrlToBytes(jwk.x);
  const y = base64UrlToBytes(jwk.y);
  if (x.length !== 32 || y.length !== 32) {
    throw new Error("Invalid P-256 public key coordinate length.");
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(x, 1);
  publicKey.set(y, 33);
  return publicKey;
}

export function verifyDpopProof(input: {
  readonly proof: string | null | undefined;
  readonly method: string;
  readonly url: string;
  readonly nowEpochSeconds: number;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
  readonly maxAgeSeconds?: number;
}): DpopVerificationResult {
  if (!input.proof?.trim()) {
    return { ok: false, reason: "Missing DPoP proof." };
  }

  const parts = input.proof.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    return { ok: false, reason: "Invalid DPoP compact JWT." };
  }

  try {
    const header = Option.flatMap(decodeBase64UrlJson(parts[0]), decodeDpopJwtHeader);
    const payload = Option.flatMap(decodeBase64UrlJson(parts[1]), decodeDpopJwtPayloadOption);
    if (Option.isNone(header)) {
      return { ok: false, reason: "Invalid DPoP JWT header." };
    }
    if (Option.isNone(payload)) {
      return { ok: false, reason: "Invalid DPoP JWT payload." };
    }

    const thumbprint = computeDpopJwkThumbprint(header.value.jwk);
    if (input.expectedThumbprint && thumbprint !== input.expectedThumbprint) {
      return { ok: false, reason: "DPoP key thumbprint mismatch." };
    }
    if (payload.value.htm.toUpperCase() !== input.method.toUpperCase()) {
      return { ok: false, reason: "DPoP method mismatch." };
    }
    const normalizedHtu = normalizeDpopHtu(input.url);
    if (normalizedHtu === null || payload.value.htu !== normalizedHtu) {
      return { ok: false, reason: "DPoP URL mismatch." };
    }
    if (input.expectedAccessToken) {
      const expectedAth = computeDpopAccessTokenHash(input.expectedAccessToken);
      if (payload.value.ath !== expectedAth) {
        return { ok: false, reason: "DPoP access token hash mismatch." };
      }
    }

    const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
    if (
      payload.value.iat > input.nowEpochSeconds + 5 ||
      input.nowEpochSeconds - payload.value.iat > maxAgeSeconds
    ) {
      return { ok: false, reason: "DPoP proof is outside the allowed time window." };
    }

    const signature = base64UrlToBytes(parts[2]);
    const signatureInputHash = sha256(new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
    const verified = p256.verify(
      signature,
      signatureInputHash,
      publicKeyBytesFromJwk(header.value.jwk),
      {
        prehash: false,
        format: "compact",
      },
    );
    return verified
      ? {
          ok: true,
          thumbprint,
          jti: payload.value.jti,
          iat: payload.value.iat,
        }
      : { ok: false, reason: "Invalid DPoP signature." };
  } catch {
    return { ok: false, reason: "Invalid DPoP proof." };
  }
}
