import { verifyDpopProof } from "@t3tools/shared/dpop";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decodeJwt } from "jose";
import { vi } from "vite-plus/test";

import {
  BrowserDpopError,
  type BrowserDpopKey,
  browserCryptoLayer,
  createBrowserDpopProof,
  generateBrowserDpopKey,
} from "./dpop";

describe("browser DPoP proofs", () => {
  it.effect("reports URL normalization failures structurally with their cause", () =>
    Effect.gen(function* () {
      const error = yield* createBrowserDpopProof({
        method: "POST",
        url: "not a URL",
        proofKey: {} as BrowserDpopKey,
      }).pipe(Effect.provide(browserCryptoLayer), Effect.flip);

      expect(error).toBeInstanceOf(BrowserDpopError);
      expect(error).toMatchObject({
        operation: "normalize-proof-url",
        cause: expect.any(TypeError),
      });
    }),
  );

  it.effect("signs relay resource proofs with an access-token hash", () =>
    Effect.gen(function* () {
      vi.stubGlobal("indexedDB", undefined);
      const proofKey = yield* generateBrowserDpopKey;
      const proof = yield* createBrowserDpopProof({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect?ignored=true",
        accessToken: "relay-access-token",
        proofKey,
      }).pipe(Effect.provide(browserCryptoLayer));
      const issuedAt = decodeJwt(proof.proof).iat;
      expect(issuedAt).toBeTypeOf("number");

      expect(
        verifyDpopProof({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.test/v1/environments/env-1/connect",
          expectedThumbprint: proof.thumbprint,
          expectedAccessToken: "relay-access-token",
          nowEpochSeconds: issuedAt!,
        }),
      ).toMatchObject({ ok: true });
    }),
  );
});
