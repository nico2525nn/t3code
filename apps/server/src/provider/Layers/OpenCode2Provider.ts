/**
 * OpenCode2Provider — status probe and model inventory for the OpenCode 2
 * (`opencode2`) provider.
 *
 * The probe drives the V2 HTTP API directly (`/api/health`, `/api/model`,
 * `/api/provider`, `/api/agent`) against either a managed `opencode2 serve`
 * child spawned for the probe lifetime or a pre-configured external server.
 * Model slug convention mirrors OpenCode v1: `<providerID>/<modelID>`.
 *
 * @module provider/Layers/OpenCode2Provider
 */
import { type OpenCode2Settings, type ServerProviderModel } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  nonEmptyTrimmed,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  makeOpenCode2ApiClient,
  openCode2RuntimeErrorDetail,
  OpenCode2Runtime,
  OpenCode2RuntimeError,
  type OpenCode2Model,
} from "../opencode2Runtime.ts";

const OPENCODE2_PRESENTATION = {
  displayName: "OpenCode 2",
  showInteractionModeToggle: false,
} as const;

const DEFAULT_OPENCODE2_MODEL_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});

function openCode2CapabilitiesForModel(input: { readonly model: OpenCode2Model }) {
  const variants = input.model.variants ?? [];
  const defaultVariant = variants[0]?.id;
  return createModelCapabilities({
    optionDescriptors: [
      ...(variants.length > 0
        ? [
            {
              id: "variant",
              label: "Variant",
              type: "select" as const,
              options: variants.map((variant) =>
                defaultVariant === variant.id
                  ? { id: variant.id, label: variant.id, isDefault: true as const }
                  : { id: variant.id, label: variant.id },
              ),
              ...(defaultVariant ? { currentValue: defaultVariant } : {}),
            },
          ]
        : []),
    ],
  });
}

function flattenOpenCode2Models(input: {
  readonly models: ReadonlyArray<OpenCode2Model>;
  readonly providerNames: ReadonlyMap<string, string>;
  readonly defaultModel: { readonly id: string; readonly providerID: string } | null | undefined;
}): ReadonlyArray<ServerProviderModel> {
  const connected = new Set<string>(input.providerNames.keys());
  const models: Array<ServerProviderModel> = [];

  for (const model of input.models) {
    if (!connected.has(model.providerID)) {
      continue;
    }
    const name = nonEmptyTrimmed(model.name);
    if (!name) {
      continue;
    }
    const subProvider = nonEmptyTrimmed(input.providerNames.get(model.providerID));
    const isDefault =
      input.defaultModel !== null &&
      input.defaultModel !== undefined &&
      input.defaultModel.providerID === model.providerID &&
      input.defaultModel.id === model.id;
    models.push({
      slug: `${model.providerID}/${model.id}`,
      name,
      ...(subProvider ? { subProvider } : {}),
      ...(isDefault ? { isDefault } : {}),
      isCustom: false,
      capabilities: openCode2CapabilitiesForModel({ model }),
    });
  }

  return models.toSorted((left, right) => left.name.localeCompare(right.name));
}

export const makePendingOpenCode2Provider = (
  openCode2Settings: OpenCode2Settings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      [],
      openCode2Settings.customModels,
      DEFAULT_OPENCODE2_MODEL_CAPABILITIES,
    );

    if (!openCode2Settings.enabled) {
      return buildServerProvider({
        presentation: OPENCODE2_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message:
            openCode2Settings.serverUrl.trim().length > 0
              ? "OpenCode 2 is disabled in T3 Code settings. A server URL is configured."
              : "OpenCode 2 is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "OpenCode 2 provider status has not been checked in this session yet.",
      },
    });
  });

/**
 * Probe the configured OpenCode 2 installation. Runs a short-lived managed
 * server (or reuses the configured external one) inside a scoped region so
 * spawned children are torn down when the probe completes.
 */
export const checkOpenCode2ProviderStatus = Effect.fn("checkOpenCode2ProviderStatus")(function* (
  openCode2Settings: OpenCode2Settings,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, OpenCode2Runtime> {
  const openCode2Runtime = yield* OpenCode2Runtime;
  const resolvedEnvironment = environment ?? process.env;
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const customModels = openCode2Settings.customModels;
  const isExternalServer = openCode2Settings.serverUrl.trim().length > 0;

  const fallback = (cause: unknown, version: string | null = null) =>
    buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: openCode2Settings.enabled,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE2_MODEL_CAPABILITIES),
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: `Failed to probe OpenCode 2: ${openCode2RuntimeErrorDetail(cause)}`,
      },
    });

  if (!openCode2Settings.enabled) {
    return buildServerProvider({
      presentation: OPENCODE2_PRESENTATION,
      enabled: false,
      checkedAt,
      models: providerModelsFromSettings([], customModels, DEFAULT_OPENCODE2_MODEL_CAPABILITIES),
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: isExternalServer
          ? "OpenCode 2 is disabled in T3 Code settings. A server URL is configured."
          : "OpenCode 2 is disabled in T3 Code settings.",
      },
    });
  }

  let version: string | null = null;
  if (!isExternalServer) {
    const versionExit = yield* Effect.exit(
      openCode2Runtime
        .runOpenCode2Command({
          binaryPath: openCode2Settings.binaryPath,
          args: ["--version"],
          environment: resolvedEnvironment,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OpenCode2RuntimeError({
                operation: "opencode2 --version",
                detail: openCode2RuntimeErrorDetail(cause),
                cause,
              }),
          ),
        ),
    );
    if (versionExit._tag === "Failure") {
      const squashed = Cause.squash(versionExit.cause);
      const detail = openCode2RuntimeErrorDetail(squashed);
      if (/enoent|not found|notfound/i.test(detail)) {
        return buildServerProvider({
          presentation: OPENCODE2_PRESENTATION,
          enabled: true,
          checkedAt,
          models: providerModelsFromSettings(
            [],
            customModels,
            DEFAULT_OPENCODE2_MODEL_CAPABILITIES,
          ),
          probe: {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "OpenCode 2 CLI (`opencode2`) is not installed or not on PATH.",
          },
        });
      }
      return fallback(squashed);
    }
    if (versionExit.value.code !== 0) {
      return fallback(
        new Error(
          `\`opencode2 --version\` exited with code ${versionExit.value.code}: ${versionExit.value.stderr.trim()}`,
        ),
      );
    }
    version = nonEmptyTrimmed(versionExit.value.stdout.split("\n")[0]) ?? null;
  }

  const inventoryExit = yield* Effect.exit(
    Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* openCode2Runtime.connectToOpenCode2Server({
          binaryPath: openCode2Settings.binaryPath,
          serverUrl: openCode2Settings.serverUrl,
          serverPassword: openCode2Settings.serverPassword,
          environment: resolvedEnvironment,
        });
        const api = makeOpenCode2ApiClient({
          connection,
          request: openCode2Runtime.request,
        });
        const health = yield* api.health();
        if (!health.healthy) {
          return yield* new OpenCode2RuntimeError({
            operation: "health",
            detail: "OpenCode 2 server reported unhealthy.",
          });
        }
        if (version === null) {
          version = health.version;
        }
        const [models, providers, defaultModel] = yield* Effect.all(
          [api.listModels(), api.listProviders(), api.defaultModel()],
          { concurrency: "unbounded" },
        );
        const providerNames = new Map(
          providers.map((provider) => [provider.id, provider.name ?? provider.id]),
        );
        return { models, providerNames, defaultModel };
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new OpenCode2RuntimeError({
            operation: "probe",
            detail: openCode2RuntimeErrorDetail(cause),
            cause,
          }),
      ),
    ),
  );
  if (inventoryExit._tag === "Failure") {
    return fallback(Cause.squash(inventoryExit.cause), version);
  }

  const { models, providerNames, defaultModel } = inventoryExit.value;
  const connectedCount = providerNames.size;
  return buildServerProvider({
    presentation: OPENCODE2_PRESENTATION,
    enabled: true,
    checkedAt,
    models: providerModelsFromSettings(
      flattenOpenCode2Models({
        models,
        providerNames,
        defaultModel:
          defaultModel !== null && defaultModel !== undefined
            ? { id: defaultModel.id, providerID: defaultModel.providerID }
            : null,
      }),
      customModels,
      DEFAULT_OPENCODE2_MODEL_CAPABILITIES,
    ),
    probe: {
      installed: true,
      version,
      status: connectedCount > 0 ? "ready" : "warning",
      auth: {
        status: connectedCount > 0 ? "authenticated" : "unknown",
        type: "opencode2",
      },
      message:
        connectedCount > 0
          ? `${connectedCount} upstream provider${connectedCount === 1 ? "" : "s"} connected through ${isExternalServer ? "the configured OpenCode 2 server" : "OpenCode 2"}.`
          : isExternalServer
            ? "Connected to the configured OpenCode 2 server, but it did not report any connected upstream providers."
            : "OpenCode 2 is available, but it did not report any connected upstream providers.",
    },
  });
});
