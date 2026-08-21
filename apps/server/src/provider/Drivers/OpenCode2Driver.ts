/**
 * OpenCode2Driver — `ProviderDriver` for the OpenCode 2 (`opencode2`)
 * preview runtime.
 *
 * Mirrors the OpenCode/Codex drivers: a plain value whose `create()` bundles
 * `snapshot` / `adapter` / `textGeneration` closures over the per-instance
 * `OpenCode2Settings`. Two instances with different `serverUrl`s talk to
 * independent OpenCode 2 servers; when no `serverUrl` is set, the adapter and
 * text-generation shares spawn their own scoped child processes.
 *
 * @module provider/Drivers/OpenCode2Driver
 */
import { OpenCode2Settings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

import { makeOpenCode2TextGeneration } from "../../textGeneration/OpenCode2TextGeneration.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCode2Adapter } from "../Layers/OpenCode2Adapter.ts";
import {
  checkOpenCode2ProviderStatus,
  makePendingOpenCode2Provider,
} from "../Layers/OpenCode2Provider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { OpenCode2Runtime } from "../opencode2Runtime.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
const decodeOpenCode2Settings = Schema.decodeSync(OpenCode2Settings);

const DRIVER_KIND = ProviderDriverKind.make("opencode2");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

// The V2 preview has no stable update channel: it ships no `upgrade`
// subcommand, and its `0.0.0-beta-*` builds do not track the v1
// `opencode-ai` npm line. Advertising `opencode-ai@latest` against a beta
// version would produce a permanent, wrong "update available" badge, so
// update checks are intentionally opt-out until V2 has a real release
// channel.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: () =>
    ({
      provider: DRIVER_KIND,
      packageName: null,
      update: null,
    }) satisfies ProviderMaintenanceCapabilities,
};

export type OpenCode2DriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCode2Runtime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const OpenCode2Driver: ProviderDriver<OpenCode2Settings, OpenCode2DriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode 2",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCode2Settings,
  defaultConfig: (): OpenCode2Settings => decodeOpenCode2Settings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const openCode2Runtime = yield* OpenCode2Runtime;
      const serverConfig = yield* ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies OpenCode2Settings;
      const maintenanceCapabilities = yield* resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
      });

      const adapter = yield* makeOpenCode2Adapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makeOpenCode2TextGeneration(effectiveConfig, processEnv);

      const checkProvider = checkOpenCode2ProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        processEnv,
      ).pipe(Effect.map(stampIdentity), Effect.provideService(OpenCode2Runtime, openCode2Runtime));

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OpenCode2Settings>
      >({
        maintenanceCapabilities,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          makePendingOpenCode2Provider(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
            enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
          }).pipe(
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode 2 snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
