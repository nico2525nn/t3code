import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  TerminalEvent,
} from "@t3tools/contracts";

import type { KnownEnvironment } from "./knownEnvironment";
import type { WsRpcClient } from "./wsRpcClient";

export interface EnvironmentConnection {
  readonly kind: "primary" | "saved";
  readonly environmentId: EnvironmentId;
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly ensureBootstrapped: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly dispose: () => Promise<void>;
}

interface OrchestrationHandlers {
  readonly applyShellEvent: (
    event: OrchestrationShellStreamEvent,
    environmentId: EnvironmentId,
  ) => void;
  readonly syncShellSnapshot: (
    snapshot: OrchestrationShellSnapshot,
    environmentId: EnvironmentId,
  ) => void;
  readonly applyTerminalEvent: (event: TerminalEvent, environmentId: EnvironmentId) => void;
}

interface EnvironmentConnectionInput extends OrchestrationHandlers {
  readonly kind: "primary" | "saved";
  readonly knownEnvironment: KnownEnvironment;
  readonly client: WsRpcClient;
  readonly refreshMetadata?: () => Promise<void>;
  readonly onConfigSnapshot?: (config: ServerConfig) => void;
  readonly onWelcome?: (payload: ServerLifecycleWelcomePayload) => void;
}

export function createEnvironmentConnection(
  input: EnvironmentConnectionInput,
): EnvironmentConnection {
  const environmentId = input.knownEnvironment.environmentId;

  if (!environmentId) {
    throw new Error(
      `Known environment ${input.knownEnvironment.label} is missing its environmentId.`,
    );
  }

  let disposed = false;
  let bootstrapped = false;
  let bootstrapResolve: (() => void) | null = null;
  let bootstrapPromise: Promise<void> | null = null;

  const resetBootstrapGate = () => {
    bootstrapped = false;
    bootstrapPromise = new Promise<void>((resolve) => {
      bootstrapResolve = resolve;
    });
  };

  // Initialize the bootstrap gate so ensureBootstrapped can await it.
  resetBootstrapGate();

  const observeEnvironmentIdentity = (nextEnvironmentId: EnvironmentId, source: string) => {
    if (environmentId !== nextEnvironmentId) {
      throw new Error(
        `Environment connection ${environmentId} changed identity to ${nextEnvironmentId} via ${source}.`,
      );
    }
  };

  const unsubLifecycle = input.client.server.subscribeLifecycle((event) => {
    if (event.type !== "welcome") {
      return;
    }

    observeEnvironmentIdentity(event.payload.environment.environmentId, "server lifecycle welcome");
    input.onWelcome?.(event.payload);
  });

  const unsubConfig = input.client.server.subscribeConfig((event) => {
    if (event.type !== "snapshot") {
      return;
    }

    observeEnvironmentIdentity(event.config.environment.environmentId, "server config snapshot");
    input.onConfigSnapshot?.(event.config);
  });

  const unsubShell = input.client.orchestration.subscribeShell(
    (item) => {
      if (disposed) {
        return;
      }

      if (item.kind === "snapshot") {
        input.syncShellSnapshot(item.snapshot, environmentId);
        bootstrapped = true;
        bootstrapResolve?.();
        bootstrapResolve = null;
        return;
      }

      input.applyShellEvent(item, environmentId);
    },
    {
      onResubscribe: () => {
        if (disposed) {
          return;
        }

        // The server will re-emit a snapshot on resubscribe, so reset the
        // bootstrap gate so reconnect callers can await the fresh snapshot.
        resetBootstrapGate();
      },
    },
  );

  const unsubTerminalEvent = input.client.terminal.onEvent((event) => {
    input.applyTerminalEvent(event, environmentId);
  });

  const cleanup = () => {
    disposed = true;
    unsubShell();
    unsubTerminalEvent();
    unsubLifecycle();
    unsubConfig();
  };

  return {
    kind: input.kind,
    environmentId,
    knownEnvironment: input.knownEnvironment,
    client: input.client,
    ensureBootstrapped: () => {
      if (bootstrapped) {
        return Promise.resolve();
      }
      return bootstrapPromise ?? Promise.resolve();
    },
    reconnect: async () => {
      await input.client.reconnect();
      await input.refreshMetadata?.();
      // After reconnect the shell subscription's onResubscribe fires, which
      // resets the bootstrap gate. Wait for the server to push a fresh snapshot.
      if (bootstrapPromise) {
        await bootstrapPromise;
      }
    },
    dispose: async () => {
      cleanup();
      await input.client.dispose();
    },
  };
}
