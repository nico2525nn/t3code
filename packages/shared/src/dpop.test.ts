import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  normalizeDpopHtu,
  normalizeDpopHtuOption,
  type DpopPublicJwk,
  type DpopVerificationResult,
  verifyDpopProof,
} from "./dpop.ts";

function signDpopProof(input: {
  readonly method: string;
  readonly url: string;
  readonly iat: number;
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicJwk: DpopPublicJwk | (DpopPublicJwk & { readonly d: string });
  readonly accessToken?: string;
}) {
  const header = Buffer.from(
    JSON.stringify({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: input.publicJwk,
    }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      htm: input.method,
      htu: input.url,
      jti: "proof-1",
      iat: input.iat,
      ...(input.accessToken ? { ath: computeDpopAccessTokenHash(input.accessToken) } : {}),
    }),
  ).toString("base64url");
  const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
    key: input.privateKey,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

type DpopRejectedResult = Extract<DpopVerificationResult, { readonly ok: false }>;

function assertAccepted(result: DpopVerificationResult) {
  if (!result.ok) {
    assert.fail(`Expected accepted DPoP proof, got ${result.error._tag}`);
  }
  return result;
}

function assertRejected(result: DpopVerificationResult, tag: DpopRejectedResult["error"]["_tag"]) {
  if (result.ok) {
    assert.fail("Expected rejected DPoP proof.");
  }
  assert.equal(result.error._tag, tag);
  assert.equal(result.reason, result.error.message);
  return result;
}

describe("verifyDpopProof", () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  const proof = signDpopProof({
    method: "POST",
    url: "https://example.com/oauth/token",
    iat: 100,
    privateKey,
    publicJwk,
  });

  it("verifies an ES256 DPoP proof and returns the RFC 7638 thumbprint", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const result = assertAccepted(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
    );
    assert.equal(result.thumbprint, thumbprint);
    assert.equal(result.jti, "proof-1");
  });

  it("rejects method, URL, thumbprint, and time-window mismatches", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    assertRejected(
      verifyDpopProof({
        proof,
        method: "GET",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
      "DpopMethodMismatchError",
    );
    assertRejected(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/other",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
      "DpopUrlMismatchError",
    );
    assertRejected(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: "other-thumbprint",
      }),
      "DpopThumbprintMismatchError",
    );
    assertRejected(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 1_000,
        expectedThumbprint: thumbprint,
      }),
      "DpopTimeWindowError",
    );
  });

  it("requires the RFC 9449 access token hash when an access token is expected", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const accessTokenProof = signDpopProof({
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      iat: 100,
      privateKey,
      publicJwk,
      accessToken: "clerk-access-token",
    });

    assertAccepted(
      verifyDpopProof({
        proof: accessTokenProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
        expectedAccessToken: "clerk-access-token",
      }),
    );
    assertRejected(
      verifyDpopProof({
        proof,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
        expectedAccessToken: "clerk-access-token",
      }),
      "DpopAccessTokenHashMismatchError",
    );
    assertRejected(
      verifyDpopProof({
        proof: accessTokenProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
        expectedAccessToken: "other-access-token",
      }),
      "DpopAccessTokenHashMismatchError",
    );
  });

  it("normalizes htu by excluding query and fragment components per RFC 9449", () => {
    assert.equal(
      normalizeDpopHtu("https://example.com/v1/environments/env/connect?foo=bar#frag"),
      "https://example.com/v1/environments/env/connect",
    );
    assert.deepStrictEqual(
      normalizeDpopHtuOption("https://example.com/v1/environments/env/connect?foo=bar#frag"),
      Option.some("https://example.com/v1/environments/env/connect"),
    );
    assert.deepStrictEqual(normalizeDpopHtuOption("not a url"), Option.none());

    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const queryProof = signDpopProof({
      method: "POST",
      url: "https://example.com/v1/environments/env/connect",
      iat: 100,
      privateKey,
      publicJwk,
    });

    assertAccepted(
      verifyDpopProof({
        proof: queryProof,
        method: "POST",
        url: "https://example.com/v1/environments/env/connect?foo=bar#frag",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
    );
  });

  it("rejects DPoP public JWK headers that expose private key material", () => {
    const thumbprint = computeDpopJwkThumbprint(publicJwk);
    const privateJwk = privateKey.export({ format: "jwk" }) as DpopPublicJwk & {
      readonly d: string;
    };
    const proofWithPrivateJwk = signDpopProof({
      method: "POST",
      url: "https://example.com/oauth/token",
      iat: 100,
      privateKey,
      publicJwk: privateJwk,
    });

    assertRejected(
      verifyDpopProof({
        proof: proofWithPrivateJwk,
        method: "POST",
        url: "https://example.com/oauth/token",
        nowEpochSeconds: 101,
        expectedThumbprint: thumbprint,
      }),
      "InvalidDpopJwtHeaderError",
    );
  });
});
