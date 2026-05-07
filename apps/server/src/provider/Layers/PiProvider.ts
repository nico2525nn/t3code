import { join } from "node:path";
import {
  AuthStorage,
  DefaultResourceLoader,
  ExtensionRunner,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  VERSION,
  type Skill,
} from "@mariozechner/pi-coding-agent";
import {
  type ModelCapabilities,
  type PiExtensionConfiguredPayload,
  PiSettings,
  ProviderDriverKind,
  type ServerProvider,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
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
import { toPiJsonValue } from "../pi/jsonSafe.ts";

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

function resolveEffectivePiAgentDir(settings: PiSettings): string {
  return resolvePiAgentDir(settings) ?? getAgentDir();
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

export function piModelToServerModel(model: PiModel): ServerProviderModel {
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

type PiResolvedCommand = ReturnType<ExtensionRunner["getRegisteredCommands"]>[number];
type PiRegisteredTool = ReturnType<ExtensionRunner["getAllRegisteredTools"]>[number];

export interface PiExtensionInventory {
  readonly extensionPaths: ReadonlyArray<string>;
  readonly slashCommands: PiExtensionConfiguredPayload["slashCommands"];
  readonly tools: PiExtensionConfiguredPayload["tools"];
  readonly flags: ReadonlyArray<string>;
}

interface PiProviderResources {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
  readonly pi: NonNullable<ServerProvider["pi"]>;
}

function optionalTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function piExtensionCommandToSnapshot(
  command: PiResolvedCommand,
): PiExtensionInventory["slashCommands"][number] {
  const commandRecord = Object(command) as Record<string, unknown>;
  const input =
    commandRecord.input && typeof commandRecord.input === "object"
      ? (commandRecord.input as { readonly hint?: unknown })
      : undefined;
  const name =
    typeof commandRecord.invocationName === "string" ? commandRecord.invocationName : command.name;
  const description = optionalTrimmed(command.description);
  const sourceInfo = toPiJsonValue(command.sourceInfo);
  const snapshot = {
    name,
    source: "extension",
    ...(sourceInfo !== undefined ? { sourceInfo } : {}),
    ...(description ? { description } : {}),
  };
  return typeof input?.hint === "string"
    ? Object.assign(snapshot, { input: { hint: input.hint } })
    : snapshot;
}

export function piExtensionToolToSnapshot(
  tool: PiRegisteredTool,
): PiExtensionInventory["tools"][number] {
  const description = optionalTrimmed(tool.definition.description);
  const sourceInfo = toPiJsonValue(tool.sourceInfo);
  return {
    name: tool.definition.name,
    ...(description ? { description } : {}),
    ...(sourceInfo !== undefined ? { sourceInfo } : {}),
  };
}

export function getPiExtensionInventoryFromRunner(
  runner: ExtensionRunner | undefined,
): PiExtensionInventory {
  if (!runner) {
    return {
      extensionPaths: [],
      slashCommands: [],
      tools: [],
      flags: [],
    };
  }

  return {
    extensionPaths: runner.getExtensionPaths(),
    slashCommands: runner.getRegisteredCommands().map(piExtensionCommandToSnapshot),
    tools: runner.getAllRegisteredTools().map(piExtensionToolToSnapshot),
    flags: [...runner.getFlags().keys()],
  };
}

function mergePiSlashCommands(
  baseCommands: ReadonlyArray<ServerProviderSlashCommand>,
  extensionCommands: ReadonlyArray<ServerProviderSlashCommand>,
): ReadonlyArray<ServerProviderSlashCommand> {
  const commands = [...baseCommands];
  const seen = new Set(commands.map((command) => command.name));
  for (const command of extensionCommands) {
    if (seen.has(command.name)) continue;
    commands.push(command);
    seen.add(command.name);
  }
  return commands;
}

function piSnapshotCommandToServerSlashCommand(
  command: PiExtensionInventory["slashCommands"][number],
): ServerProviderSlashCommand {
  const description = optionalTrimmed(command.description);
  const input =
    command.input && typeof command.input === "object"
      ? (command.input as { readonly hint?: unknown })
      : undefined;
  const hint = typeof input?.hint === "string" ? optionalTrimmed(input.hint) : undefined;
  return {
    name: command.name,
    ...(description ? { description } : {}),
    ...(hint ? { input: { hint } } : {}),
  };
}

async function loadPiProviderResources(
  settings: PiSettings,
  cwd: string,
): Promise<PiProviderResources> {
  const agentDir = resolveEffectivePiAgentDir(settings);
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
  });
  await loader.reload();

  const extensions = loader.getExtensions();
  const runner = new ExtensionRunner(
    extensions.extensions,
    extensions.runtime,
    cwd,
    SessionManager.inMemory(cwd),
    makePiModelRegistry(settings),
  );
  const inventory = getPiExtensionInventoryFromRunner(runner);
  const extensionCommands = inventory.slashCommands.map(piSnapshotCommandToServerSlashCommand);

  return {
    slashCommands: mergePiSlashCommands(PI_BUILT_IN_SLASH_COMMANDS, extensionCommands),
    skills: loader
      .getSkills()
      .skills.map(piSkillToServerSkill)
      .filter((skill) => skill !== undefined),
    pi: {
      extensionPaths: [...inventory.extensionPaths],
      tools: [...inventory.tools],
      flags: [...inventory.flags],
    },
  };
}

function fallbackPiProviderResources(): PiProviderResources {
  return {
    slashCommands: PI_BUILT_IN_SLASH_COMMANDS,
    skills: [],
    pi: {
      extensionPaths: [],
      tools: [],
      flags: [],
    },
  };
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

export const checkPiProviderStatus = (settings: PiSettings, cwd = process.cwd()) =>
  Effect.promise(async () => {
    try {
      const modelRegistry = makePiModelRegistry(settings);
      const availableModels = modelRegistry.getAvailable();
      const authenticated = availableModels.some((model) => modelRegistry.hasConfiguredAuth(model));
      const builtInModels = availableModels.map(piModelToServerModel);
      let resources = fallbackPiProviderResources();
      let resourceMessage: string | undefined;
      try {
        resources = await loadPiProviderResources(settings, cwd);
      } catch (cause) {
        resourceMessage = cause instanceof Error ? cause.message : String(cause);
      }
      const message = authenticated
        ? resourceMessage
          ? `Failed to read Pi extensions or skills: ${resourceMessage}`
          : undefined
        : "Pi has no configured authenticated model.";

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
        slashCommands: resources.slashCommands,
        skills: resources.skills,
        pi: resources.pi,
        probe: {
          installed: true,
          version: VERSION,
          status: authenticated && !resourceMessage ? "ready" : "warning",
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
