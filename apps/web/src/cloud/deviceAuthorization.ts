import { ManagedRelay } from "@t3tools/client-runtime/relay";
import type {
  RelayDeviceApprovalResponse,
  RelayDeviceAuthorizationDetails,
  RelayOkResponse,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";

import { runtime } from "../lib/runtime";

export type DeviceAuthorizationResult<A> =
  | { readonly _tag: "success"; readonly value: A }
  | { readonly _tag: "not-found" }
  | { readonly _tag: "failed"; readonly message: string };

function mapFailure(error: ManagedRelay.ManagedRelayClientError): DeviceAuthorizationResult<never> {
  if (
    error._tag === "ManagedRelayRequestFailedError" &&
    error.relayError?._tag === "RelayDeviceAuthorizationNotFoundError"
  ) {
    return { _tag: "not-found" };
  }
  return { _tag: "failed", message: error.message };
}

function runDeviceAuthorizationRequest<A>(
  run: (
    client: ManagedRelay.ManagedRelayClient["Service"],
  ) => Effect.Effect<A, ManagedRelay.ManagedRelayClientError>,
): Promise<DeviceAuthorizationResult<A>> {
  return runtime.runPromise(
    ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap(run),
      Effect.map((value) => ({ _tag: "success", value }) as DeviceAuthorizationResult<A>),
      Effect.catch((error) => Effect.succeed(mapFailure(error))),
    ),
  );
}

export function getDeviceAuthorization(
  clerkToken: string,
  userCode: string,
): Promise<DeviceAuthorizationResult<RelayDeviceAuthorizationDetails>> {
  return runDeviceAuthorizationRequest((client) =>
    client.getDeviceAuthorization({ clerkToken, userCode }),
  );
}

export function approveDeviceAuthorization(
  clerkToken: string,
  userCode: string,
): Promise<DeviceAuthorizationResult<RelayDeviceApprovalResponse>> {
  return runDeviceAuthorizationRequest((client) =>
    client.approveDeviceAuthorization({ clerkToken, userCode }),
  );
}

export function denyDeviceAuthorization(
  clerkToken: string,
  userCode: string,
): Promise<DeviceAuthorizationResult<RelayOkResponse>> {
  return runDeviceAuthorizationRequest((client) =>
    client.denyDeviceAuthorization({ clerkToken, userCode }),
  );
}

export function completeDeviceAuthorization(
  clerkToken: string,
  input: { readonly state: string; readonly code: string },
): Promise<DeviceAuthorizationResult<RelayOkResponse>> {
  return runDeviceAuthorizationRequest((client) =>
    client.completeDeviceAuthorization({ clerkToken, payload: input }),
  );
}

export function formatDeviceUserCodeInput(raw: string): string {
  const normalized = raw
    .toUpperCase()
    .replaceAll(/[^A-Z0-9]/gu, "")
    .slice(0, 8);
  return normalized.length > 4 ? `${normalized.slice(0, 4)}-${normalized.slice(4)}` : normalized;
}

export function isCompleteDeviceUserCode(value: string): boolean {
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}$/u.test(value);
}
