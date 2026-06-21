import { createClerkClient, verifyToken } from "@clerk/backend";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import {
  RelayEnvironmentAuth,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayInternalError,
} from "@t3tools/contracts/relay";

import {
  ClerkBearerTokenVerificationError,
  ClerkTokenVerificationError,
  mapErrorTags,
  mapRelayCommonApiErrors,
  relayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  traceRelayHttpRequestWith,
  verifyRelayDpopTokenExchangeSubject,
  verifyRelayClientBearerToken,
  withoutCapturedParentSpan,
} from "./Api.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as EnvironmentConnector from "../environments/EnvironmentConnector.ts";

vi.mock("@clerk/backend", () => ({
  createClerkClient: vi.fn(),
  verifyToken: vi.fn(),
}));

const relaySettings: RelayConfiguration.RelayConfiguration["Service"] = {
  relayIssuer: "https://relay.example.test",
  apns: {
    teamId: "apns-team",
    keyId: "apns-key",
    privateKey: Redacted.make("apns-private-key"),
    bundleId: "com.example.t3",
    environment: "sandbox",
  },
  clerkSecretKey: Redacted.make("clerk-secret-key"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "t3-code-relay",
  apnsDeliveryJobSigningSecret: Redacted.make("apns-delivery-secret"),
  cloudMintPrivateKey: Redacted.make("cloud-mint-private-key"),
  cloudMintPublicKey: "cloud-mint-public-key",
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
};

const projectionTraceId = "00000000000000000000000000000042";
const projectionParentSpan = Tracer.externalSpan({
  traceId: projectionTraceId,
  spanId: "0000000000000042",
  sampled: true,
});

interface CapturedLog {
  readonly message: unknown;
  readonly cause: Cause.Cause<unknown>;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("relay client authentication", () => {
  it.effect("preserves the existing Clerk session JWT path", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockResolvedValue({
        sub: "user_session",
        aud: relaySettings.clerkJwtAudience,
      } as never);

      expect(yield* verifyRelayClientBearerToken(relaySettings, "session-token")).toEqual({
        sub: "user_session",
        mode: "clerk_session_bearer",
      });
      expect(verifyToken).toHaveBeenCalledWith("session-token", {
        secretKey: "clerk-secret-key",
        audience: relaySettings.clerkJwtAudience,
      });
      expect(createClerkClient).not.toHaveBeenCalled();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );

  it.effect("falls back to Clerk OAuth token verification for the headless CLI", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(new Error("not a session JWT"));
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: true,
          toAuth: () => ({ userId: "user_oauth" }),
        }),
      } as never);

      expect(yield* verifyRelayClientBearerToken(relaySettings, "oauth-token")).toEqual({
        sub: "user_oauth",
        mode: "clerk_oauth_bearer",
      });
      expect(createClerkClient).toHaveBeenCalledWith({
        secretKey: "clerk-secret-key",
        publishableKey: "pk_test_test",
      });
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );

  it.effect("preserves both Clerk failures when session and OAuth verification fail", () => {
    const sessionCause = Object.assign(new Error("private session verification detail"), {
      reason: "session_invalid",
    });
    const oauthCause = Object.assign(new Error("private OAuth verification detail"), {
      reason: "oauth_invalid",
    });

    return Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(sessionCause);
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi.fn().mockRejectedValue(oauthCause),
      } as never);

      const error = yield* Effect.flip(
        verifyRelayClientBearerToken(relaySettings, "invalid-token"),
      );

      expect(error).toBeInstanceOf(ClerkBearerTokenVerificationError);
      expect(error.sessionFailure).toBeInstanceOf(ClerkTokenVerificationError);
      expect(error.sessionFailure).toMatchObject({
        stage: "session-token-verification",
        reason: "session_invalid",
        cause: sessionCause,
      });
      expect(error.cause).toBeInstanceOf(ClerkTokenVerificationError);
      expect(error.cause).toMatchObject({
        stage: "oauth-request-authentication",
        reason: "oauth_invalid",
        cause: oauthCause,
      });
      expect(error.message).toBe(
        "Clerk bearer token verification failed after session stage 'session-token-verification' (session_invalid) and OAuth stage 'oauth-request-authentication' (oauth_invalid).",
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    );
  });

  it.effect("models an unauthenticated Clerk OAuth state as a structured failure", () =>
    Effect.gen(function* () {
      vi.mocked(verifyToken).mockRejectedValue(
        Object.assign(new Error("not a session JWT"), { reason: "session_invalid" }),
      );
      vi.mocked(createClerkClient).mockReturnValue({
        authenticateRequest: vi.fn().mockResolvedValue({
          isAuthenticated: false,
          toAuth: () => ({ userId: null }),
        }),
      } as never);

      const error = yield* Effect.flip(
        verifyRelayClientBearerToken(relaySettings, "unauthenticated-token"),
      );

      expect(error).toBeInstanceOf(ClerkBearerTokenVerificationError);
      expect(error.sessionFailure).toMatchObject({
        stage: "session-token-verification",
        reason: "session_invalid",
      });
      expect(error.cause).toBeInstanceOf(ClerkTokenVerificationError);
      expect(error.cause).toMatchObject({
        stage: "oauth-auth-state-validation",
        reason: "not_authenticated",
      });
      expect(error.cause.cause).toBeUndefined();
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    ),
  );
});

describe("relay DPoP token exchange authentication", () => {
  it.effect("records safe Clerk verification diagnostics before returning invalid bearer", () => {
    const verificationCause = Object.assign(new Error("private token verification detail"), {
      reason: "session_invalid",
    });

    return Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      vi.mocked(verifyToken).mockRejectedValue(verificationCause);

      const error = yield* Effect.flip(
        verifyRelayDpopTokenExchangeSubject(relaySettings, "private-subject-token").pipe(
          Effect.provideService(Tracer.Tracer, tracer),
        ),
      );

      expect(Predicate.isTagged(error, "RelayAuthInvalidError")).toBe(true);
      if (Predicate.isTagged(error, "RelayAuthInvalidError")) {
        expect(error.reason).toBe("invalid_bearer");
      }
      const exchangeSpan = spans.find(
        (span) => span.name === "relay.auth.dpop_token_exchange_subject",
      );
      expect(exchangeSpan?.attributes.get("relay.auth.clerk_verification_failure")).toBe(
        "session_invalid",
      );
      expect(exchangeSpan?.attributes.get("relay.auth.clerk_verification_stage")).toBe(
        "session-token-verification",
      );
      for (const attribute of exchangeSpan?.attributes.values() ?? []) {
        expect(String(attribute)).not.toContain("private-subject-token");
        expect(String(attribute)).not.toContain("private token verification detail");
      }
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          vi.mocked(verifyToken).mockReset();
          vi.mocked(createClerkClient).mockReset();
        }),
      ),
    );
  });
});

describe("relay environment authentication", () => {
  it.effect("preserves credential lookup persistence failures as internal errors", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ cause, fiber, message }) => {
      logs.push({
        message,
        cause,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });
    const failure = new EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError({
      stage: "lookup-credential",
      cause: "database unavailable",
    });
    const credentials: EnvironmentCredentials.EnvironmentCredentials["Service"] = {
      create: () => Effect.die("unused create"),
      authenticate: () => Effect.fail(failure),
      revokeForEnvironmentPublicKey: () => Effect.die("unused revoke"),
    };

    return Effect.gen(function* () {
      const auth = yield* RelayEnvironmentAuth;
      const error = yield* Effect.flip(
        auth.environmentBearer(Effect.succeed(HttpServerResponse.empty()), {
          credential: Redacted.make("environment-credential"),
          endpoint: {} as never,
          group: {} as never,
        }),
      );

      expect(Predicate.isTagged(error, "RelayInternalError")).toBe(true);
      if (Predicate.isTagged(error, "RelayInternalError")) {
        expect(error.reason).toBe("persistence_failed");
        expect(error.traceId).toBe(projectionTraceId);
        expect(error).not.toHaveProperty("cause");
      }
      expect(logs).toEqual([
        {
          message: ["relay API failure projected to wire response"],
          cause: Cause.fail(failure),
          annotations: expect.objectContaining({
            traceId: projectionTraceId,
            sourceErrorTag: "EnvironmentCredentialAuthenticatePersistenceError",
            responseErrorTag: "RelayInternalError",
            responseCode: "internal_error",
            responseReason: "persistence_failed",
          }),
        },
      ]);
    }).pipe(
      Effect.provideService(Tracer.ParentSpan, projectionParentSpan),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(
        HttpServerRequest.HttpServerRequest,
        HttpServerRequest.fromWeb(new Request("https://relay.test/v1/server/link")),
      ),
      Effect.provideService(HttpServerRequest.ParsedSearchParams, {}),
      Effect.provideService(HttpRouter.RouteContext, {
        params: {},
        route: {} as never,
      }),
      Effect.provide(
        relayEnvironmentAuthLayer.pipe(
          Layer.provide(Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, credentials)),
        ),
      ),
      Effect.scoped,
    );
  });
});

describe("relay API error projection", () => {
  it.effect("logs common persistence failures with the wire response trace", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ cause, fiber, message }) => {
      logs.push({
        message,
        cause,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });
    const databaseCause = new Error("database connection refused");
    const failure = new EnvironmentCredentials.EnvironmentCredentialRevokePersistenceError({
      environmentId: "env-test",
      cause: databaseCause,
    });

    return Effect.gen(function* () {
      const error = yield* Effect.fail(failure).pipe(
        mapRelayCommonApiErrors("not_authorized"),
        Effect.flip,
      );

      expect(error).toBeInstanceOf(RelayInternalError);
      expect(error).toMatchObject({
        code: "internal_error",
        reason: "persistence_failed",
        traceId: projectionTraceId,
      });
      expect(error).not.toHaveProperty("cause");
      expect(logs).toEqual([
        {
          message: ["relay API failure projected to wire response"],
          cause: Cause.fail(failure),
          annotations: expect.objectContaining({
            traceId: projectionTraceId,
            sourceErrorTag: "EnvironmentCredentialRevokePersistenceError",
            responseErrorTag: "RelayInternalError",
            responseCode: "internal_error",
            responseReason: "persistence_failed",
          }),
        },
      ]);
      expect(failure.cause).toBe(databaseCause);
    }).pipe(
      Effect.provideService(Tracer.ParentSpan, projectionParentSpan),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });

  it.effect("logs selected server failures but not expected authorization projections", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ cause, fiber, message }) => {
      logs.push({
        message,
        cause,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });
    const serverCause = new Error("mint request transport failed");
    const serverFailure = EnvironmentConnector.EnvironmentMintRequestFailed.fromEndpoint({
      userId: "user-test",
      environmentId: "env-test",
      operation: "connect",
      stage: "send_request",
      httpBaseUrl: "https://environment.example.test",
      cause: serverCause,
    });
    const authorizationFailure = new EnvironmentConnector.EnvironmentConnectNotAuthorized({
      environmentId: "env-test",
      operation: "connect",
      reason: "environment_link_not_found",
    });

    return Effect.gen(function* () {
      const serverError = yield* Effect.fail(serverFailure).pipe(
        mapErrorTags({
          EnvironmentMintRequestFailed: (_error, traceId) =>
            new RelayInternalError({
              code: "internal_error",
              reason: "upstream_unavailable",
              traceId,
            }),
        }),
        Effect.flip,
      );
      const authorizationError = yield* Effect.fail(authorizationFailure).pipe(
        mapErrorTags({
          EnvironmentConnectNotAuthorized: (_error, traceId) =>
            new RelayEnvironmentConnectNotAuthorizedError({
              code: "environment_connect_not_authorized",
              traceId,
            }),
        }),
        Effect.flip,
      );

      expect(serverError).toMatchObject({
        reason: "upstream_unavailable",
        traceId: projectionTraceId,
      });
      expect(authorizationError.traceId).toBe(projectionTraceId);
      expect(logs).toEqual([
        {
          message: ["relay API failure projected to wire response"],
          cause: Cause.fail(serverFailure),
          annotations: expect.objectContaining({
            traceId: projectionTraceId,
            sourceErrorTag: "EnvironmentMintRequestFailed",
            responseErrorTag: "RelayInternalError",
            responseCode: "internal_error",
            responseReason: "upstream_unavailable",
          }),
        },
      ]);
      expect(serverFailure.cause).toBe(serverCause);
    }).pipe(
      Effect.provideService(Tracer.ParentSpan, projectionParentSpan),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
    );
  });
});

describe("relay request tracing", () => {
  it.effect(
    "does not parent endpoint spans to an ambient parent captured while building handlers",
    () =>
      Effect.gen(function* () {
        const spans: Array<Tracer.NativeSpan> = [];
        const tracer = Tracer.make({
          span: (options) => {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const ambientParent = Tracer.externalSpan({
          traceId: "00000000000000000000000000000001",
          spanId: "0000000000000001",
          sampled: true,
        });
        const endpoint = yield* withoutCapturedParentSpan(
          Effect.context<never>().pipe(
            Effect.map((capturedContext: Context.Context<never>) =>
              Effect.succeed(HttpServerResponse.empty({ status: 204 })).pipe(
                Effect.withSpan("relay.test.endpoint"),
                Effect.provideContext(capturedContext),
              ),
            ),
          ),
        ).pipe(Effect.provideService(Tracer.ParentSpan, ambientParent));
        const request = HttpServerRequest.fromWeb(
          new Request("https://relay.test/v1/mobile/devices?client=mobile", {
            method: "POST",
            headers: {
              authorization: "Bearer secret",
              dpop: "signed-proof",
            },
          }),
        );

        yield* traceRelayHttpRequestWith(endpoint, Layer.succeed(Tracer.Tracer, tracer)).pipe(
          Effect.provideService(HttpServerRequest.HttpServerRequest, request),
        );

        expect(spans.map((span) => span.name)).toEqual(["http.server POST", "relay.test.endpoint"]);
        expect(spans[0]?.kind).toBe("server");
        expect(spans[0]?.attributes.get("url.path")).toBe("/v1/mobile/devices");
        expect(spans[0]?.attributes.get("http.response.status_code")).toBe(204);
        expect(spans[0]?.attributes.get("http.request.header.authorization")).toBe("<redacted>");
        expect(spans[0]?.attributes.get("http.request.header.dpop")).toBe("<redacted>");
        expect(Option.isNone(spans[0]!.parent)).toBe(true);
        expect(Option.getOrUndefined(spans[1]!.parent)?.spanId).toBe(spans[0]?.spanId);
      }),
  );
});

describe("relay routing fallback", () => {
  it.effect("redirects the relay root to the API docs", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(new Request("https://relay.test/"));
      const httpEffect = yield* HttpRouter.toHttpEffect(
        Layer.mergeAll(relayDocsRedirectRoute, relayNotFoundRoute, relayCors),
      );
      const response = yield* httpEffect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );

      expect(response.status).toBe(302);
      expect(response.headers.location).toBe("/docs");
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    }).pipe(Effect.scoped),
  );

  it.effect("returns a CORS-compatible 404 response for unmatched paths", () =>
    Effect.gen(function* () {
      const request = HttpServerRequest.fromWeb(
        new Request("https://relay.test/v1/environmentsd", { method: "GET" }),
      );
      const httpEffect = yield* HttpRouter.toHttpEffect(Layer.merge(relayNotFoundRoute, relayCors));
      const response = yield* httpEffect.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      );

      expect(response.status).toBe(404);
      expect(response.headers["access-control-allow-origin"]).toBe("*");
    }).pipe(Effect.scoped),
  );
});
