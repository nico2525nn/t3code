import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import {
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import { stripPairingTokenFromUrl } from "@t3tools/shared/remote";
import {
  type RelayEnvironmentConnectResponse as RelayEnvironmentConnectResponseType,
  type RelayEnvironmentLinkResponse as RelayEnvironmentLinkResponseType,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  type RelayDpopAccessTokenScope,
  type RelayClientEnvironmentRecord,
  type RelayEnvironmentStatusResponse as RelayEnvironmentStatusResponseType,
  RelayManagedEndpointProviderKind,
  RelayProtectedError,
} from "@t3tools/contracts/relay";
import { exchangeRemoteDpopAccessToken } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { findErrorTraceId } from "@t3tools/client-runtime/errors";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { makeEnvironmentHttpApiClient } from "@t3tools/client-runtime/rpc";
import { getUrlDiagnostics } from "@t3tools/shared/urlDiagnostics";

import { authClientMetadata } from "../../lib/authClientMetadata";
import type { SavedRemoteConnection } from "../../lib/connection";
import { loadOrCreateAgentAwarenessDeviceId, loadPreferences } from "../../lib/storage";
import { resolveCloudPublicConfig } from "./publicConfig";

const RELAY_STATUS_AND_CONNECT_SCOPES = [
  RelayEnvironmentStatusScope,
  RelayEnvironmentConnectScope,
] satisfies ReadonlyArray<RelayDpopAccessTokenScope>;

export function normalizeRelayBaseUrl(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.replace(/\/+$/g, "");
}

function readRelayUrl(): string | null {
  return resolveCloudPublicConfig().relay.url;
}

const EnvironmentCloudApiError = Schema.Union([
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpConflictError,
  EnvironmentHttpInternalServerError,
  EnvironmentCloudEndpointUnavailableError,
]);
type EnvironmentCloudApiError = typeof EnvironmentCloudApiError.Type;
const isEnvironmentCloudApiError = Schema.is(EnvironmentCloudApiError);
const isManagedRelayRequestFailedError = Schema.is(ManagedRelay.ManagedRelayRequestFailedError);

export const CloudEnvironmentLinkAction = Schema.Literals([
  "load the mobile device id",
  "load mobile notification preferences",
  "create an environment link challenge",
  "obtain an environment link proof",
  "link the environment",
  "configure environment relay access",
  "list cloud environments",
  "read cloud environment status",
  "connect to the cloud environment",
  "fetch the connected environment descriptor",
  "create a bootstrap DPoP proof",
  "exchange a managed endpoint DPoP access token",
  "derive the environment endpoint origin",
  "initialize the environment HTTP client",
  "parse the managed endpoint URL",
]);
export type CloudEnvironmentLinkAction = typeof CloudEnvironmentLinkAction.Type;

function relayUrlDiagnosticFields(relayUrl: string | undefined) {
  if (relayUrl === undefined) {
    return {};
  }
  const diagnostics = getUrlDiagnostics(relayUrl);
  return {
    relayUrlInputLength: diagnostics.inputLength,
    ...(diagnostics.protocol === undefined ? {} : { relayUrlProtocol: diagnostics.protocol }),
    ...(diagnostics.hostname === undefined ? {} : { relayUrlHostname: diagnostics.hostname }),
  };
}

function httpBaseUrlDiagnosticFields(httpBaseUrl: string | undefined) {
  if (httpBaseUrl === undefined) {
    return {};
  }
  const diagnostics = getUrlDiagnostics(httpBaseUrl);
  return {
    httpBaseUrlInputLength: diagnostics.inputLength,
    ...(diagnostics.protocol === undefined ? {} : { httpBaseUrlProtocol: diagnostics.protocol }),
    ...(diagnostics.hostname === undefined ? {} : { httpBaseUrlHostname: diagnostics.hostname }),
  };
}

export class CloudEnvironmentLinkOperationError extends Schema.TaggedErrorClass<CloudEnvironmentLinkOperationError>()(
  "CloudEnvironmentLinkOperationError",
  {
    action: CloudEnvironmentLinkAction,
    environmentId: Schema.optionalKey(Schema.String),
    relayUrlInputLength: Schema.optionalKey(Schema.Number),
    relayUrlProtocol: Schema.optionalKey(Schema.String),
    relayUrlHostname: Schema.optionalKey(Schema.String),
    httpBaseUrlInputLength: Schema.optionalKey(Schema.Number),
    httpBaseUrlProtocol: Schema.optionalKey(Schema.String),
    httpBaseUrlHostname: Schema.optionalKey(Schema.String),
    traceId: Schema.optionalKey(Schema.String),
    relayError: Schema.optionalKey(RelayProtectedError),
    environmentError: Schema.optionalKey(EnvironmentCloudApiError),
    cause: Schema.Defect(),
  },
) {
  static fromCause(input: {
    readonly action: CloudEnvironmentLinkAction;
    readonly cause: unknown;
    readonly environmentId?: string;
    readonly relayUrl?: string;
    readonly httpBaseUrl?: string;
  }): CloudEnvironmentLinkOperationError {
    const relayFailure = isManagedRelayRequestFailedError(input.cause) ? input.cause : undefined;
    const environmentError = CloudEnvironmentLinkOperationError.findEnvironmentApiError(
      input.cause,
    );
    const traceId = relayFailure?.traceId ?? findErrorTraceId(input.cause);
    return new CloudEnvironmentLinkOperationError({
      action: input.action,
      cause: input.cause,
      ...(input.environmentId === undefined ? {} : { environmentId: input.environmentId }),
      ...relayUrlDiagnosticFields(input.relayUrl),
      ...httpBaseUrlDiagnosticFields(input.httpBaseUrl),
      ...(traceId === null || traceId === undefined ? {} : { traceId }),
      ...(relayFailure?.relayError === undefined ? {} : { relayError: relayFailure.relayError }),
      ...(environmentError === undefined ? {} : { environmentError }),
    });
  }

  private static findEnvironmentApiError(cause: unknown): EnvironmentCloudApiError | undefined {
    const seen = new Set<unknown>();
    let current = cause;
    while (typeof current === "object" && current !== null && !seen.has(current)) {
      if (isEnvironmentCloudApiError(current)) {
        return current;
      }
      seen.add(current);
      current = "cause" in current ? current.cause : undefined;
    }
    return undefined;
  }

  override get message(): string {
    const environment =
      this.environmentId === undefined ? "" : ` for environment "${this.environmentId}"`;
    return `Could not ${this.action}${environment}.`;
  }
}

export class CloudRelayUrlNotConfiguredError extends Schema.TaggedErrorClass<CloudRelayUrlNotConfiguredError>()(
  "CloudRelayUrlNotConfiguredError",
  {},
) {
  override get message(): string {
    return "Relay URL is not configured.";
  }
}

export class CloudEnvironmentLocalBearerRequiredError extends Schema.TaggedErrorClass<CloudEnvironmentLocalBearerRequiredError>()(
  "CloudEnvironmentLocalBearerRequiredError",
  {
    environmentId: Schema.String,
    httpBaseUrlInputLength: Schema.Number,
    httpBaseUrlProtocol: Schema.optionalKey(Schema.String),
    httpBaseUrlHostname: Schema.optionalKey(Schema.String),
  },
) {
  static fromConnection(input: {
    readonly environmentId: string;
    readonly httpBaseUrl: string;
  }): CloudEnvironmentLocalBearerRequiredError {
    const diagnostics = getUrlDiagnostics(input.httpBaseUrl);
    return new CloudEnvironmentLocalBearerRequiredError({
      environmentId: input.environmentId,
      httpBaseUrlInputLength: diagnostics.inputLength,
      ...(diagnostics.protocol === undefined ? {} : { httpBaseUrlProtocol: diagnostics.protocol }),
      ...(diagnostics.hostname === undefined ? {} : { httpBaseUrlHostname: diagnostics.hostname }),
    });
  }

  override get message(): string {
    return "Only a locally paired bearer connection can be linked to the cloud.";
  }
}

export class CloudEnvironmentIdMismatchError extends Schema.TaggedErrorClass<CloudEnvironmentIdMismatchError>()(
  "CloudEnvironmentIdMismatchError",
  {
    source: Schema.Literals([
      "environment link response",
      "environment status response",
      "environment status descriptor",
      "environment connect response",
      "connected environment descriptor",
    ]),
    expectedEnvironmentId: Schema.String,
    actualEnvironmentId: Schema.String,
  },
) {
  override get message(): string {
    return `The ${this.source} identified environment "${this.actualEnvironmentId}" instead of "${this.expectedEnvironmentId}".`;
  }
}

export class CloudEnvironmentEndpointMismatchError extends Schema.TaggedErrorClass<CloudEnvironmentEndpointMismatchError>()(
  "CloudEnvironmentEndpointMismatchError",
  {
    source: Schema.Literals(["environment status response", "environment connect response"]),
    environmentId: Schema.String,
    expectedProviderKind: RelayManagedEndpointProviderKind,
    expectedHttpBaseUrlInputLength: Schema.Number,
    expectedHttpBaseUrlProtocol: Schema.optionalKey(Schema.String),
    expectedHttpBaseUrlHostname: Schema.optionalKey(Schema.String),
    expectedWsBaseUrlInputLength: Schema.Number,
    expectedWsBaseUrlProtocol: Schema.optionalKey(Schema.String),
    expectedWsBaseUrlHostname: Schema.optionalKey(Schema.String),
    actualProviderKind: RelayManagedEndpointProviderKind,
    actualHttpBaseUrlInputLength: Schema.Number,
    actualHttpBaseUrlProtocol: Schema.optionalKey(Schema.String),
    actualHttpBaseUrlHostname: Schema.optionalKey(Schema.String),
    actualWsBaseUrlInputLength: Schema.Number,
    actualWsBaseUrlProtocol: Schema.optionalKey(Schema.String),
    actualWsBaseUrlHostname: Schema.optionalKey(Schema.String),
  },
) {
  static fromEndpoints(input: {
    readonly source: "environment status response" | "environment connect response";
    readonly environmentId: string;
    readonly expectedEndpoint: RelayClientEnvironmentRecord["endpoint"];
    readonly actualEndpoint: RelayClientEnvironmentRecord["endpoint"];
  }): CloudEnvironmentEndpointMismatchError {
    const expectedHttp = getUrlDiagnostics(input.expectedEndpoint.httpBaseUrl);
    const expectedWs = getUrlDiagnostics(input.expectedEndpoint.wsBaseUrl);
    const actualHttp = getUrlDiagnostics(input.actualEndpoint.httpBaseUrl);
    const actualWs = getUrlDiagnostics(input.actualEndpoint.wsBaseUrl);
    return new CloudEnvironmentEndpointMismatchError({
      source: input.source,
      environmentId: input.environmentId,
      expectedProviderKind: input.expectedEndpoint.providerKind,
      expectedHttpBaseUrlInputLength: expectedHttp.inputLength,
      ...(expectedHttp.protocol === undefined
        ? {}
        : { expectedHttpBaseUrlProtocol: expectedHttp.protocol }),
      ...(expectedHttp.hostname === undefined
        ? {}
        : { expectedHttpBaseUrlHostname: expectedHttp.hostname }),
      expectedWsBaseUrlInputLength: expectedWs.inputLength,
      ...(expectedWs.protocol === undefined
        ? {}
        : { expectedWsBaseUrlProtocol: expectedWs.protocol }),
      ...(expectedWs.hostname === undefined
        ? {}
        : { expectedWsBaseUrlHostname: expectedWs.hostname }),
      actualProviderKind: input.actualEndpoint.providerKind,
      actualHttpBaseUrlInputLength: actualHttp.inputLength,
      ...(actualHttp.protocol === undefined
        ? {}
        : { actualHttpBaseUrlProtocol: actualHttp.protocol }),
      ...(actualHttp.hostname === undefined
        ? {}
        : { actualHttpBaseUrlHostname: actualHttp.hostname }),
      actualWsBaseUrlInputLength: actualWs.inputLength,
      ...(actualWs.protocol === undefined ? {} : { actualWsBaseUrlProtocol: actualWs.protocol }),
      ...(actualWs.hostname === undefined ? {} : { actualWsBaseUrlHostname: actualWs.hostname }),
    });
  }

  override get message(): string {
    return `The ${this.source} returned a different endpoint for environment "${this.environmentId}".`;
  }
}

export class CloudEnvironmentEndpointProviderMismatchError extends Schema.TaggedErrorClass<CloudEnvironmentEndpointProviderMismatchError>()(
  "CloudEnvironmentEndpointProviderMismatchError",
  {
    environmentId: Schema.String,
    expectedProviderKind: RelayManagedEndpointProviderKind,
    actualProviderKind: RelayManagedEndpointProviderKind,
  },
) {
  override get message(): string {
    return `Relay returned link credentials with endpoint provider "${this.actualProviderKind}" instead of "${this.expectedProviderKind}".`;
  }
}

export const CloudEnvironmentLinkError = Schema.Union([
  CloudEnvironmentLinkOperationError,
  CloudRelayUrlNotConfiguredError,
  CloudEnvironmentLocalBearerRequiredError,
  CloudEnvironmentIdMismatchError,
  CloudEnvironmentEndpointMismatchError,
  CloudEnvironmentEndpointProviderMismatchError,
]);
export type CloudEnvironmentLinkError = typeof CloudEnvironmentLinkError.Type;
export const isCloudEnvironmentLinkError = Schema.is(CloudEnvironmentLinkError);

export interface CloudEnvironmentRecordWithStatus {
  readonly environment: RelayClientEnvironmentRecord;
  readonly status: RelayEnvironmentStatusResponseType | null;
  readonly statusError: string | null;
}

const MANAGED_ENDPOINT_PROVIDER_KIND =
  "cloudflare_tunnel" satisfies RelayManagedEndpointProviderKind;

function requireRelayUrl(): Effect.Effect<string, CloudEnvironmentLinkError> {
  const relayUrl = readRelayUrl();
  return relayUrl ? Effect.succeed(relayUrl) : Effect.fail(new CloudRelayUrlNotConfiguredError());
}

function endpointOrigin(input: { readonly environmentId: string; readonly httpBaseUrl: string }) {
  return Effect.try({
    try: () => {
      const url = new URL(input.httpBaseUrl);
      return {
        localHttpHost: "127.0.0.1",
        localHttpPort: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
      };
    },
    catch: (cause) =>
      CloudEnvironmentLinkOperationError.fromCause({
        action: "derive the environment endpoint origin",
        environmentId: input.environmentId,
        httpBaseUrl: input.httpBaseUrl,
        cause,
      }),
  });
}

function makeCloudEnvironmentHttpApiClient(input: {
  readonly environmentId: string;
  readonly httpBaseUrl: string;
}) {
  return Effect.try({
    try: () => makeEnvironmentHttpApiClient(input.httpBaseUrl),
    catch: (cause) =>
      CloudEnvironmentLinkOperationError.fromCause({
        action: "initialize the environment HTTP client",
        environmentId: input.environmentId,
        httpBaseUrl: input.httpBaseUrl,
        cause,
      }),
  }).pipe(Effect.flatten);
}

function ensureLinkedEnvironmentMatches(input: {
  readonly expectedEnvironmentId: string;
  readonly expectedProviderKind: RelayManagedEndpointProviderKind;
  readonly link: RelayEnvironmentLinkResponseType;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (input.link.environmentId !== input.expectedEnvironmentId) {
    return new CloudEnvironmentIdMismatchError({
      source: "environment link response",
      expectedEnvironmentId: input.expectedEnvironmentId,
      actualEnvironmentId: input.link.environmentId,
    });
  }
  if (input.link.endpoint.providerKind !== input.expectedProviderKind) {
    return new CloudEnvironmentEndpointProviderMismatchError({
      environmentId: input.expectedEnvironmentId,
      expectedProviderKind: input.expectedProviderKind,
      actualProviderKind: input.link.endpoint.providerKind,
    });
  }
  return Effect.void;
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

function ensureStatusMatchesEnvironment(input: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly status: RelayEnvironmentStatusResponseType;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (input.status.environmentId !== input.environment.environmentId) {
    return new CloudEnvironmentIdMismatchError({
      source: "environment status response",
      expectedEnvironmentId: input.environment.environmentId,
      actualEnvironmentId: input.status.environmentId,
    });
  }
  if (!endpointMatches(input.status.endpoint, input.environment.endpoint)) {
    return CloudEnvironmentEndpointMismatchError.fromEndpoints({
      source: "environment status response",
      environmentId: input.environment.environmentId,
      expectedEndpoint: input.environment.endpoint,
      actualEndpoint: input.status.endpoint,
    });
  }
  if (
    input.status.descriptor &&
    input.status.descriptor.environmentId !== input.environment.environmentId
  ) {
    return new CloudEnvironmentIdMismatchError({
      source: "environment status descriptor",
      expectedEnvironmentId: input.environment.environmentId,
      actualEnvironmentId: input.status.descriptor.environmentId,
    });
  }
  return Effect.void;
}

function ensureConnectEndpointMatchesEnvironment(input: {
  readonly environment: RelayClientEnvironmentRecord;
  readonly connect: RelayEnvironmentConnectResponseType;
}): Effect.Effect<void, CloudEnvironmentLinkError> {
  if (!endpointMatches(input.connect.endpoint, input.environment.endpoint)) {
    return CloudEnvironmentEndpointMismatchError.fromEndpoints({
      source: "environment connect response",
      environmentId: input.environment.environmentId,
      expectedEndpoint: input.environment.endpoint,
      actualEndpoint: input.connect.endpoint,
    });
  }
  return Effect.void;
}

export function linkEnvironmentToCloud(input: {
  readonly connection: SavedRemoteConnection;
  readonly clerkToken: string;
}): Effect.Effect<
  void,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    if (!input.connection.bearerToken) {
      return yield* CloudEnvironmentLocalBearerRequiredError.fromConnection({
        environmentId: input.connection.environmentId,
        httpBaseUrl: input.connection.httpBaseUrl,
      });
    }
    const localBearerToken = input.connection.bearerToken;
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    const deviceId = yield* Effect.tryPromise({
      try: () => loadOrCreateAgentAwarenessDeviceId(),
      catch: (cause) =>
        CloudEnvironmentLinkOperationError.fromCause({
          action: "load the mobile device id",
          environmentId: input.connection.environmentId,
          cause,
        }),
    });
    const preferences = yield* Effect.tryPromise({
      try: () => loadPreferences(),
      catch: (cause) =>
        CloudEnvironmentLinkOperationError.fromCause({
          action: "load mobile notification preferences",
          environmentId: input.connection.environmentId,
          cause,
        }),
    });
    const liveActivitiesEnabled = preferences.liveActivitiesEnabled !== false;
    const challenge = yield* relayClient
      .createEnvironmentLinkChallenge({
        clerkToken: input.clerkToken,
        payload: {
          notificationsEnabled: true,
          liveActivitiesEnabled,
          managedTunnelsEnabled: true,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromCause({
            action: "create an environment link challenge",
            environmentId: input.connection.environmentId,
            relayUrl,
            cause,
          }),
        ),
      );
    const origin = yield* endpointOrigin({
      environmentId: input.connection.environmentId,
      httpBaseUrl: input.connection.httpBaseUrl,
    });
    const environmentClient = yield* makeCloudEnvironmentHttpApiClient({
      environmentId: input.connection.environmentId,
      httpBaseUrl: input.connection.httpBaseUrl,
    });
    const proof = yield* environmentClient.connect
      .linkProof({
        headers: { authorization: `Bearer ${localBearerToken}` },
        payload: {
          challenge: challenge.challenge,
          relayIssuer: relayUrl,
          endpoint: {
            httpBaseUrl: input.connection.httpBaseUrl,
            wsBaseUrl: input.connection.wsBaseUrl,
            providerKind: MANAGED_ENDPOINT_PROVIDER_KIND,
          },
          origin,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromCause({
            action: "obtain an environment link proof",
            environmentId: input.connection.environmentId,
            httpBaseUrl: input.connection.httpBaseUrl,
            cause,
          }),
        ),
      );
    const link = yield* relayClient
      .linkEnvironment({
        clerkToken: input.clerkToken,
        payload: {
          deviceId,
          proof,
          notificationsEnabled: true,
          liveActivitiesEnabled,
          managedTunnelsEnabled: true,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromCause({
            action: "link the environment",
            environmentId: input.connection.environmentId,
            relayUrl,
            cause,
          }),
        ),
      );
    yield* ensureLinkedEnvironmentMatches({
      expectedEnvironmentId: input.connection.environmentId,
      expectedProviderKind: MANAGED_ENDPOINT_PROVIDER_KIND,
      link,
    });

    yield* environmentClient.connect
      .relayConfig({
        headers: { authorization: `Bearer ${localBearerToken}` },
        payload: {
          relayUrl,
          relayIssuer: link.relayIssuer,
          cloudUserId: link.cloudUserId,
          environmentCredential: link.environmentCredential,
          cloudMintPublicKey: link.cloudMintPublicKey,
          endpointRuntime: link.endpointRuntime,
        },
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromCause({
            action: "configure environment relay access",
            environmentId: input.connection.environmentId,
            httpBaseUrl: input.connection.httpBaseUrl,
            cause,
          }),
        ),
      );
  });
}

export function listCloudEnvironments(input: {
  readonly clerkToken: string;
}): Effect.Effect<
  ReadonlyArray<RelayClientEnvironmentRecord>,
  CloudEnvironmentLinkError,
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelay.ManagedRelayClient;

    return yield* relayClient.listEnvironments({ clerkToken: input.clerkToken }).pipe(
      Effect.mapError((cause) =>
        CloudEnvironmentLinkOperationError.fromCause({
          action: "list cloud environments",
          relayUrl,
          cause,
        }),
      ),
    );
  });
}

export function getCloudEnvironmentStatus(input: {
  readonly clerkToken: string;
  readonly environment: RelayClientEnvironmentRecord;
  readonly relayScopes?: ReadonlyArray<RelayDpopAccessTokenScope>;
}): Effect.Effect<
  RelayEnvironmentStatusResponseType,
  CloudEnvironmentLinkError,
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelay.ManagedRelayClient;
    const status = yield* relayClient
      .getEnvironmentStatus({
        clerkToken: input.clerkToken,
        scopes: input.relayScopes ?? [RelayEnvironmentStatusScope],
        environmentId: input.environment.environmentId,
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromCause({
            action: "read cloud environment status",
            environmentId: input.environment.environmentId,
            relayUrl,
            cause,
          }),
        ),
      );
    yield* ensureStatusMatchesEnvironment({ environment: input.environment, status });
    return status;
  });
}

export function cloudEnvironmentsPendingStatus(
  environments: ReadonlyArray<RelayClientEnvironmentRecord>,
): ReadonlyArray<CloudEnvironmentRecordWithStatus> {
  return environments.map((environment) => ({
    environment,
    status: null,
    statusError: "Checking status...",
  }));
}

export function loadCloudEnvironmentStatuses(input: {
  readonly clerkToken: string;
  readonly environments: ReadonlyArray<RelayClientEnvironmentRecord>;
}): Effect.Effect<
  ReadonlyArray<CloudEnvironmentRecordWithStatus>,
  CloudEnvironmentLinkError,
  ManagedRelay.ManagedRelayClient
> {
  return Effect.forEach(
    input.environments,
    (environment) =>
      getCloudEnvironmentStatus({
        clerkToken: input.clerkToken,
        environment,
        relayScopes: RELAY_STATUS_AND_CONNECT_SCOPES,
      }).pipe(
        Effect.match({
          onFailure: (error) => ({
            environment,
            status: null,
            statusError: error.message,
          }),
          onSuccess: (status) => ({
            environment,
            status,
            statusError: null,
          }),
        }),
      ),
    { concurrency: "unbounded" },
  );
}

export function listCloudEnvironmentsWithStatus(input: {
  readonly clerkToken: string;
}): Effect.Effect<
  ReadonlyArray<CloudEnvironmentRecordWithStatus>,
  CloudEnvironmentLinkError,
  ManagedRelay.ManagedRelayClient
> {
  return Effect.gen(function* () {
    const environments = yield* listCloudEnvironments(input);
    return yield* loadCloudEnvironmentStatuses({
      clerkToken: input.clerkToken,
      environments,
    });
  });
}

const loadAgentAwarenessDeviceId = Effect.fn("mobile.cloud.loadAgentAwarenessDeviceId")(function* (
  environmentId: string,
) {
  return yield* Effect.tryPromise({
    try: () => loadOrCreateAgentAwarenessDeviceId(),
    catch: (cause) =>
      CloudEnvironmentLinkOperationError.fromCause({
        action: "load the mobile device id",
        environmentId,
        cause,
      }),
  });
});

const connectRelayManagedEnvironment = Effect.fn("mobile.cloud.connectRelayManagedEnvironment")(
  function* (input: {
    readonly clerkToken: string;
    readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
    readonly expectedEnvironment?: RelayClientEnvironmentRecord;
  }) {
    yield* Effect.annotateCurrentSpan({ "environment.id": input.environmentId });
    const relayUrl = yield* requireRelayUrl();
    const relayClient = yield* ManagedRelay.ManagedRelayClient;

    const deviceId = yield* loadAgentAwarenessDeviceId(input.environmentId);
    const connect = yield* relayClient
      .connectEnvironment({
        clerkToken: input.clerkToken,
        scopes: [RelayEnvironmentConnectScope],
        environmentId: input.environmentId,
        deviceId,
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromCause({
            action: "connect to the cloud environment",
            environmentId: input.environmentId,
            relayUrl,
            cause,
          }),
        ),
      );
    if (connect.environmentId !== input.environmentId) {
      return yield* new CloudEnvironmentIdMismatchError({
        source: "environment connect response",
        expectedEnvironmentId: input.environmentId,
        actualEnvironmentId: connect.environmentId,
      });
    }
    if (input.expectedEnvironment) {
      yield* ensureConnectEndpointMatchesEnvironment({
        environment: input.expectedEnvironment,
        connect,
      });
    }

    const descriptor = yield* fetchRemoteEnvironmentDescriptor({
      httpBaseUrl: connect.endpoint.httpBaseUrl,
    }).pipe(
      Effect.mapError((cause) =>
        CloudEnvironmentLinkOperationError.fromCause({
          action: "fetch the connected environment descriptor",
          environmentId: input.environmentId,
          httpBaseUrl: connect.endpoint.httpBaseUrl,
          cause,
        }),
      ),
    );
    if (descriptor.environmentId !== connect.environmentId) {
      return yield* new CloudEnvironmentIdMismatchError({
        source: "connected environment descriptor",
        expectedEnvironmentId: connect.environmentId,
        actualEnvironmentId: descriptor.environmentId,
      });
    }
    const endpointUrl = yield* Effect.try({
      try: () => new URL(connect.endpoint.httpBaseUrl),
      catch: (cause) =>
        CloudEnvironmentLinkOperationError.fromCause({
          action: "parse the managed endpoint URL",
          environmentId: input.environmentId,
          httpBaseUrl: connect.endpoint.httpBaseUrl,
          cause,
        }),
    });
    const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
    const bootstrapDpop = yield* signer
      .createProof({
        method: "POST",
        url: new URL("/oauth/token", endpointUrl).toString(),
      })
      .pipe(
        Effect.mapError((cause) =>
          CloudEnvironmentLinkOperationError.fromCause({
            action: "create a bootstrap DPoP proof",
            environmentId: input.environmentId,
            httpBaseUrl: connect.endpoint.httpBaseUrl,
            cause,
          }),
        ),
      );
    const bootstrap = yield* exchangeRemoteDpopAccessToken({
      httpBaseUrl: connect.endpoint.httpBaseUrl,
      credential: connect.credential,
      dpopProof: bootstrapDpop,
      clientMetadata: authClientMetadata(),
    }).pipe(
      Effect.mapError((cause) =>
        CloudEnvironmentLinkOperationError.fromCause({
          action: "exchange a managed endpoint DPoP access token",
          environmentId: input.environmentId,
          httpBaseUrl: connect.endpoint.httpBaseUrl,
          cause,
        }),
      ),
    );
    endpointUrl.hash = new URLSearchParams([["token", connect.credential]]).toString();

    return {
      environmentId: descriptor.environmentId,
      environmentLabel: descriptor.label,
      pairingUrl: stripPairingTokenFromUrl(endpointUrl).toString(),
      displayUrl: connect.endpoint.httpBaseUrl,
      httpBaseUrl: connect.endpoint.httpBaseUrl,
      wsBaseUrl: connect.endpoint.wsBaseUrl,
      bearerToken: null,
      authenticationMethod: "dpop",
      dpopAccessToken: bootstrap.access_token,
      relayManaged: true,
    } satisfies SavedRemoteConnection;
  },
);

export function connectCloudEnvironment(input: {
  readonly clerkToken: string;
  readonly environment: RelayClientEnvironmentRecord;
}): Effect.Effect<
  SavedRemoteConnection,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelay.ManagedRelayClient | ManagedRelay.ManagedRelayDpopSigner
> {
  return connectRelayManagedEnvironment({
    clerkToken: input.clerkToken,
    environmentId: input.environment.environmentId,
    expectedEnvironment: input.environment,
  });
}

export function refreshCloudEnvironmentConnection(input: {
  readonly clerkToken: string;
  readonly connection: SavedRemoteConnection;
}): Effect.Effect<
  SavedRemoteConnection,
  CloudEnvironmentLinkError,
  HttpClient.HttpClient | ManagedRelay.ManagedRelayClient | ManagedRelay.ManagedRelayDpopSigner
> {
  return connectRelayManagedEnvironment({
    clerkToken: input.clerkToken,
    environmentId: input.connection.environmentId,
  });
}
