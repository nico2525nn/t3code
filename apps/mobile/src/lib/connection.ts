import {
  bootstrapRemoteBearerSession,
  fetchRemoteEnvironmentDescriptor,
  resolveRemotePairingTarget,
} from "@t3tools/shared/remote";

export interface RemoteConnectionInput {
  readonly pairingUrl: string;
}

export interface SavedRemoteConnection {
  readonly environmentId: string;
  readonly environmentLabel: string;
  readonly pairingUrl: string;
  readonly displayUrl: string;
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
  readonly bearerToken: string;
}

export async function bootstrapRemoteConnection(
  input: RemoteConnectionInput,
): Promise<SavedRemoteConnection> {
  const target = resolveRemotePairingTarget({
    pairingUrl: input.pairingUrl,
  });

  const descriptor = await fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  });

  const bootstrap = await bootstrapRemoteBearerSession({
    httpBaseUrl: target.httpBaseUrl,
    credential: target.credential,
  });

  return {
    environmentId: descriptor.environmentId,
    environmentLabel: descriptor.label,
    pairingUrl: input.pairingUrl.trim(),
    displayUrl: target.httpBaseUrl,
    httpBaseUrl: target.httpBaseUrl,
    wsBaseUrl: target.wsBaseUrl,
    bearerToken: bootstrap.sessionToken,
  };
}
