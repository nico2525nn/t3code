import { join } from "node:path";
import {
  AuthStorage,
  loadSkills,
  ModelRegistry,
  VERSION,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import {
  type ModelCapabilities,
  PiSettings,
  ProviderDriverKind,
  type ServerProviderModel,
  type ServerProviderSkill,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { Effect } from "effect";

import { expandHomePath } from "../../pathExpansion.ts";
import {
  buildSelectOptionDescriptor,
  buildServerProvider,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import { PI_BUILT_IN_SLASH_COMMANDS } from "../pi/PiSlashCommands.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Full Access",
  showInteractionModeToggle: false,
} as const;

const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
type PiThinkingLevel = (typeof PI_THINKING_LEVELS)[number];

const PI_THINKING_LABELS: Record<PiThinkingLevel, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
};

const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = "medium";

const DEFAULT_PI_MODEL_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    buildSelectOptionDescriptor({
      id: "reasoningEffort",
      label: "Reasoning",
      options: PI_THINKING_LEVELS.map((level) => ({
        value: level,
        label: PI_THINKING_LABELS[level],
        isDefault: level === DEFAULT_PI_THINKING_LEVEL,
      })),
    }),
  ],
});

export function resolvePiAgentDir(settings: PiSettings): string | undefined {
  const configured = settings.agentDir.trim();
  return configured.length > 0 ? expandHomePath(configured) : undefined;
}

export function resolvePiSessionDir(settings: PiSettings): string | undefined {
  const configured = settings.sessionDir.trim();
  return configured.length > 0 ? expandHomePath(configured) : undefined;
}

function makePiAuthStorage(settings: PiSettings): AuthStorage {
  const agentDir = resolvePiAgentDir(settings);
  return AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
}

function makePiModelRegistry(settings: PiSettings): ModelRegistry {
  const agentDir = resolvePiAgentDir(settings);
  const authStorage = makePiAuthStorage(settings);
  return ModelRegistry.create(authStorage, agentDir ? join(agentDir, "models.json") : undefined);
}

type PiModel = ReturnType<ModelRegistry["getAll"]>[number];

function getPiSupportedThinkingLevels(model: PiModel): ReadonlyArray<PiThinkingLevel> {
  if (!model.reasoning) {
    return ["off"];
  }
  return PI_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) {
      return false;
    }
    return level !== "xhigh" || mapped !== undefined;
  });
}

function piModelCapabilities(model: PiModel): ModelCapabilities {
  const levels = getPiSupportedThinkingLevels(model);
  if (levels.length === 0) {
    return createModelCapabilities({ optionDescriptors: [] });
  }
  const defaultLevel = levels.includes(DEFAULT_PI_THINKING_LEVEL)
    ? DEFAULT_PI_THINKING_LEVEL
    : levels[0];
  return createModelCapabilities({
    optionDescriptors: [
      buildSelectOptionDescriptor({
        id: "reasoningEffort",
        label: "Reasoning",
        options: levels.map((level) => ({
          value: level,
          label: PI_THINKING_LABELS[level],
          isDefault: level === defaultLevel,
        })),
      }),
    ],
  });
}

function piModelToServerModel(model: PiModel): ServerProviderModel {
  const slug = `${model.provider}/${model.id}`;
  return {
    slug,
    name: model.name.trim() || slug,
    shortName: model.id,
    subProvider: model.provider,
    isCustom: false,
    capabilities: piModelCapabilities(model),
  };
}

function piSkillToServerSkill(skill: Skill): ServerProviderSkill | undefined {
  const name = skill.name.trim();
  if (!name) {
    return undefined;
  }
  const description = skill.description.trim();
  return {
    name,
    path: skill.filePath,
    enabled: !skill.disableModelInvocation,
    displayName: name,
    ...(description ? { description } : {}),
    ...(description ? { shortDescription: description } : {}),
  };
}

function getPiSkills(settings: PiSettings): ReadonlyArray<ServerProviderSkill> {
  try {
    return loadSkills({
      cwd: process.cwd(),
      agentDir: resolvePiAgentDir(settings) ?? "",
      skillPaths: [],
      includeDefaults: true,
    })
      .skills.map(piSkillToServerSkill)
      .filter((skill) => skill !== undefined);
  } catch {
    return [];
  }
}

export function makePendingPiProvider(settings: PiSettings): ServerProviderDraft {
  return buildServerProvider({
    driver: DRIVER_KIND,
    presentation: PI_PRESENTATION,
    enabled: settings.enabled,
    checkedAt: new Date().toISOString(),
    models: providerModelsFromSettings(
      [],
      DRIVER_KIND,
      settings.customModels,
      DEFAULT_PI_MODEL_CAPABILITIES,
    ),
    slashCommands: PI_BUILT_IN_SLASH_COMMANDS,
    skills: [],
    probe: {
      installed: true,
      version: VERSION,
      status: "warning",
      auth: {
        status: "unknown",
        type: "pi",
        label: "Pi",
      },
      message: "Checking Pi configuration...",
    },
  });
}

export const checkPiProviderStatus = (settings: PiSettings) =>
  Effect.sync(() => {
    try {
      const modelRegistry = makePiModelRegistry(settings);
      const availableModels = modelRegistry.getAvailable();
      const authenticated = availableModels.some((model) => modelRegistry.hasConfiguredAuth(model));
      const builtInModels = availableModels.map(piModelToServerModel);
      const message = authenticated ? undefined : "Pi has no configured authenticated model.";

      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: PI_PRESENTATION,
        enabled: settings.enabled,
        checkedAt: new Date().toISOString(),
        models: providerModelsFromSettings(
          builtInModels,
          DRIVER_KIND,
          settings.customModels,
          DEFAULT_PI_MODEL_CAPABILITIES,
        ),
        slashCommands: PI_BUILT_IN_SLASH_COMMANDS,
        skills: getPiSkills(settings),
        probe: {
          installed: true,
          version: VERSION,
          status: authenticated ? "ready" : "warning",
          auth: {
            status: authenticated ? "authenticated" : "unauthenticated",
            type: "pi",
            label: "Pi",
          },
          ...(message ? { message } : {}),
        },
      });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: PI_PRESENTATION,
        enabled: settings.enabled,
        checkedAt: new Date().toISOString(),
        models: providerModelsFromSettings(
          [],
          DRIVER_KIND,
          settings.customModels,
          DEFAULT_PI_MODEL_CAPABILITIES,
        ),
        slashCommands: PI_BUILT_IN_SLASH_COMMANDS,
        skills: [],
        probe: {
          installed: true,
          version: VERSION,
          status: "error",
          auth: {
            status: "unknown",
            type: "pi",
            label: "Pi",
          },
          message: `Failed to read Pi configuration: ${message}`,
        },
      });
    }
  });
