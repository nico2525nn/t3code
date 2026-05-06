# Pi Provider Integration Plan

This plan adds Pi as a first-class T3 Code provider while preserving Pi's own semantics: Pi runs full-access, loads the user's Pi config/extensions/skills/prompts, and does not inherit Codex-style approval gates. Guardrails belong in Pi extensions, not in the T3 adapter.

Reference points:

- T3 provider SPI: `apps/server/src/provider/ProviderDriver.ts`
- T3 provider runtime contract: `apps/server/src/provider/Services/ProviderAdapter.ts`
- Built-in driver registry: `apps/server/src/provider/builtInDrivers.ts`
- Server settings/contracts: `packages/contracts/src/settings.ts`
- Provider presentation shape: `packages/contracts/src/server.ts`
- Pi SDK clone inspected at `/tmp/pi-mono.jzAggk`
- Pi SDK package: `@mariozechner/pi-coding-agent`

## 0. Core Decisions

1. Use Pi's TypeScript SDK.
   - Do not shell out to `pi --mode rpc` for the main provider path.
   - RPC remains a useful reference for headless UI binding behavior.

2. Pi is always full-access.
   - Do not wrap `bash`, `edit`, `write`, or file tools with T3 approval requests.
   - Do not force T3's `approval-required` or read-only behavior onto Pi.
   - The UI can still display tool activity after the fact.
   - Policy gates are implemented by Pi extensions and loaded through Pi's normal extension system.

3. Load Pi resources through Pi's own SDK.
   - Use `agentDir` explicitly.
   - Let Pi load global/project extensions, skills, prompts, settings, auth, models, and sessions.

4. Built-in slash commands need a T3 dispatcher.
   - Pi SDK prompts handle extension commands, skills, and prompt templates.
   - Pi built-ins like `/new`, `/compact`, `/model`, `/reload`, `/fork`, and `/tree` are implemented by Pi's interactive/RPC modes, so T3 must map them to SDK/runtime calls.

## 1. Add The SDK Dependency

Install the SDK into the server package:

```bash
bun add @mariozechner/pi-coding-agent --filter t3
```

Only add direct dependencies that are imported directly. If event/model types from `@mariozechner/pi-ai` or `@mariozechner/pi-agent-core` are needed at compile time and are not re-exported by `@mariozechner/pi-coding-agent`, add those with `bun add` too.

## 2. Contracts And Settings

Add `PiSettings` beside the other provider settings in `packages/contracts/src/settings.ts`.

Key choices:

- `enabled` defaults to `true`, like Codex/OpenCode.
- `agentDir` is optional and defaults to empty string. Empty means Pi's normal default `~/.pi/agent`.
- `sessionDir` can be added now or later. If omitted, Pi's default session directory under the agent dir is used.
- `customModels` stays hidden for consistency, but Pi's real model list should come from `ModelRegistry`.

```ts
export const PiSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(true)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    agentDir: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Pi agent directory",
        description: "Custom Pi agent config directory.",
        providerSettingsForm: {
          placeholder: "~/.pi/agent",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    sessionDir: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Pi session directory",
        description: "Optional custom Pi session directory.",
        providerSettingsForm: {
          placeholder: "~/.pi/agent/sessions",
          clearWhenEmpty: "omit",
        },
      }),
    ),
    customModels: Schema.Array(Schema.String).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["agentDir", "sessionDir"],
  },
);
export type PiSettings = typeof PiSettings.Type;
```

Then wire it into legacy provider settings and patches:

```ts
providers: Schema.Struct({
  codex: CodexSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  claudeAgent: ClaudeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  cursor: CursorSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  opencode: OpenCodeSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
  pi: PiSettings.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({}))),
```

```ts
const PiSettingsPatch = Schema.Struct({
  enabled: Schema.optionalKey(Schema.Boolean),
  agentDir: Schema.optionalKey(Schema.String),
  sessionDir: Schema.optionalKey(Schema.String),
  customModels: Schema.optionalKey(Schema.Array(Schema.String)),
});
```

```ts
providers: Schema.optionalKey(
  Schema.Struct({
    codex: Schema.optionalKey(CodexSettingsPatch),
    claudeAgent: Schema.optionalKey(ClaudeSettingsPatch),
    cursor: Schema.optionalKey(CursorSettingsPatch),
    opencode: Schema.optionalKey(OpenCodeSettingsPatch),
    pi: Schema.optionalKey(PiSettingsPatch),
  }),
),
```

Update `packages/contracts/src/model.ts`:

```ts
const PI_DRIVER_KIND = ProviderDriverKind.make("pi");

export const DEFAULT_MODEL_BY_PROVIDER: Partial<Record<ProviderDriverKind, string>> = {
  [CODEX_DRIVER_KIND]: DEFAULT_MODEL,
  [CLAUDE_DRIVER_KIND]: "claude-sonnet-4-6",
  [CURSOR_DRIVER_KIND]: "auto",
  [OPENCODE_DRIVER_KIND]: "openai/gpt-5",
  [PI_DRIVER_KIND]: "auto",
};

export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Partial<
  Record<ProviderDriverKind, string>
> = {
  [CODEX_DRIVER_KIND]: DEFAULT_GIT_TEXT_GENERATION_MODEL,
  [CLAUDE_DRIVER_KIND]: "claude-haiku-4-5",
  [CURSOR_DRIVER_KIND]: "composer-2",
  [OPENCODE_DRIVER_KIND]: "openai/gpt-5",
  [PI_DRIVER_KIND]: "auto",
};

export const PROVIDER_DISPLAY_NAMES: Partial<Record<ProviderDriverKind, string>> = {
  [CODEX_DRIVER_KIND]: "Codex",
  [CLAUDE_DRIVER_KIND]: "Claude",
  [CURSOR_DRIVER_KIND]: "Cursor",
  [OPENCODE_DRIVER_KIND]: "OpenCode",
  [PI_DRIVER_KIND]: "Pi",
};
```

## 3. Web Provider Metadata

Update `apps/web/src/components/settings/providerDriverMeta.ts`.

```ts
import {
  ClaudeSettings,
  CodexSettings,
  CursorSettings,
  OpenCodeSettings,
  PiSettings,
  ProviderDriverKind,
} from "@t3tools/contracts";
```

```ts
{
  value: ProviderDriverKind.make("pi"),
  label: "Pi",
  icon: PiIcon,
  settingsSchema: PiSettings,
},
```

If there is no Pi icon yet, add a simple icon in `apps/web/src/components/Icons` and use that consistently in:

- `providerDriverMeta.ts`
- `apps/web/src/session-logic.ts`
- `apps/web/src/components/chat/providerIconUtils.ts`

Update the provider picker:

```ts
export const PROVIDER_OPTIONS = [
  { value: ProviderDriverKind.make("codex"), label: "Codex", available: true },
  { value: ProviderDriverKind.make("claudeAgent"), label: "Claude", available: true },
  {
    value: ProviderDriverKind.make("opencode"),
    label: "OpenCode",
    available: true,
    pickerSidebarBadge: "new",
  },
  {
    value: ProviderDriverKind.make("cursor"),
    label: "Cursor",
    available: true,
    pickerSidebarBadge: "new",
  },
  { value: ProviderDriverKind.make("pi"), label: "Pi", available: true, pickerSidebarBadge: "new" },
];
```

Because Pi is always full-access, any interaction-mode UI should treat Pi as full-access. The clean version is to use the provider snapshot to hide the interaction-mode toggle for Pi.

## 4. Server Provider Snapshot

Create `apps/server/src/provider/Layers/PiProvider.ts`.

Responsibilities:

- Resolve `agentDir`.
- Create `AuthStorage` and `ModelRegistry`.
- Build a `ServerProviderDraft`.
- Expose Pi models as T3 `ServerProviderModel`s.
- Expose Pi skills and static slash commands.
- Report version from Pi's `VERSION` export.

Sketch:

```ts
import { join } from "node:path";
import { AuthStorage, ModelRegistry, VERSION, type Skill } from "@mariozechner/pi-coding-agent";
import { PiSettings, ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { Effect } from "effect";
import { buildServerProvider } from "../providerSnapshot.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");

function resolvePiAgentDir(settings: PiSettings): string | undefined {
  const configured = settings.agentDir.trim();
  return configured.length > 0 ? expandHome(configured) : undefined;
}

function piModelToServerModel(model: {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}): ServerProviderModel {
  const slug = `${model.provider}/${model.id}`;
  return {
    slug,
    name: model.name ?? slug,
    shortName: model.id,
    subProvider: model.provider,
    isCustom: false,
    capabilities: null,
  };
}

export const checkPiProviderStatus = (settings: PiSettings) =>
  Effect.try({
    try: () => {
      const agentDir = resolvePiAgentDir(settings);
      const authStorage = AuthStorage.create(agentDir ? join(agentDir, "auth.json") : undefined);
      const modelRegistry = ModelRegistry.create(
        authStorage,
        agentDir ? join(agentDir, "models.json") : undefined,
      );
      const availableModels = modelRegistry.getAvailable();
      const authenticated = availableModels.some((model) => modelRegistry.hasConfiguredAuth(model));

      return buildServerProvider({
        driver: DRIVER_KIND,
        presentation: {
          displayName: "Pi",
          badgeLabel: "Full Access",
          showInteractionModeToggle: false,
        },
        enabled: settings.enabled,
        checkedAt: new Date().toISOString(),
        models: availableModels.map(piModelToServerModel),
        slashCommands: getPiSlashCommands(),
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
          message: authenticated ? undefined : "Pi has no configured authenticated model.",
        },
      });
    },
    catch: (cause) => cause,
  });
```

Notes:

- If Pi's public package does not export the exact built-in command list, mirror it locally with a test that catches drift when the SDK export appears.
- Skills are cwd-sensitive. Provider snapshots can show global/default skills, but per-thread slash completion should eventually refresh after `startSession`.

## 5. Driver Registration

Create `apps/server/src/provider/Drivers/PiDriver.ts`.

Pi should follow the `CodexDriver`/`OpenCodeDriver` shape: a plain `ProviderDriver` value that returns a `ProviderInstance`.

```ts
import { PiSettings, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { Duration, Effect, Path, Schema, Stream } from "effect";
import { HttpClient } from "effect/unstable/http";
import { makePiTextGeneration } from "../../textGeneration/PiTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePiAdapter } from "../Layers/PiAdapter.ts";
import { checkPiProviderStatus, makePendingPiProvider } from "../Layers/PiProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import type { ProviderDriver, ProviderInstance } from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";

const DRIVER_KIND = ProviderDriverKind.make("pi");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type PiDriverEnv = HttpClient.HttpClient | Path.Path | ProviderEventLoggers;

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

export const PiDriver: ProviderDriver<PiSettings, PiDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Pi",
    supportsMultipleInstances: true,
  },
  configSchema: PiSettings,
  defaultConfig: (): PiSettings => Schema.decodeSync(PiSettings)({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies PiSettings;
      const continuationIdentity = piContinuationIdentity(effectiveConfig, instanceId);
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const adapter = yield* makePiAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
      });
      const textGeneration = yield* makePiTextGeneration(effectiveConfig, processEnv);

      const snapshot = yield* makeManagedServerProvider<PiSettings>({
        maintenanceCapabilities: { check: "unsupported", update: "unsupported" },
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) => stampIdentity(makePendingPiProvider(settings)),
        checkProvider: checkPiProviderStatus(effectiveConfig).pipe(Effect.map(stampIdentity)),
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Pi snapshot: ${cause.message ?? String(cause)}`,
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
```

Continuation identity should group the same Pi config together:

```ts
function piContinuationIdentity(settings: PiSettings, instanceId: ProviderInstanceId) {
  const agentDir = settings.agentDir.trim() || "~/.pi/agent";
  return {
    driverKind: DRIVER_KIND,
    continuationKey: `pi:agent-dir:${agentDir}:instance:${instanceId}`,
  };
}
```

Register it in `apps/server/src/provider/builtInDrivers.ts`:

```ts
import { PiDriver, type PiDriverEnv } from "./Drivers/PiDriver.ts";

export type BuiltInDriversEnv =
  | ClaudeDriverEnv
  | CodexDriverEnv
  | CursorDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv;

export const BUILT_IN_DRIVERS = [CodexDriver, ClaudeDriver, CursorDriver, OpenCodeDriver, PiDriver];
```

## 6. Adapter And Session Runtime

Create `apps/server/src/provider/Layers/PiAdapter.ts`.

Use one SDK-backed context per T3 thread:

```ts
interface PiResumeCursor {
  readonly schemaVersion: 1;
  readonly sessionFile: string;
  readonly sessionId: string;
  readonly leafId?: string;
  readonly cwd: string;
  readonly agentDir?: string;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly runtime: AgentSessionRuntime;
  readonly session: AgentSession;
  readonly unsubscribe: () => void;
  readonly turnLeafIds: Map<TurnId, { before?: string; after?: string }>;
  activeTurnId: TurnId | null;
  resumeCursor: PiResumeCursor | null;
}
```

Session start:

```ts
const startSession = (input: ProviderSessionStartInput) =>
  Effect.tryPromise({
    try: async () => {
      const cwd = input.cwd;
      const agentDir = resolvePiAgentDir(config);
      const sessionManager = await openOrCreatePiSessionManager({
        cwd,
        agentDir,
        sessionDir: config.sessionDir,
        resume: decodePiResumeCursor(input.resume),
      });

      const { session, extensionsResult } = await createAgentSession({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent: {
          source: "t3",
          cwd,
        },
        // Important: omit tools/noTools so Pi enables its native full-access defaults.
      });

      const runtime = new AgentSessionRuntime(session, {
        createSession: makeRuntimeSessionFactory({ cwd, agentDir }),
      });

      await bindPiExtensions({
        context,
        runtime,
        session,
        extensionsResult,
      });

      const unsubscribe = session.subscribe((event) => {
        publishPiRuntimeEvents(context, event);
      });

      sessions.set(input.threadId, context);
      publishSessionStarted(context);

      return {
        threadId: input.threadId,
        providerThreadId: sessionManager.getSessionId(),
        resume: context.resumeCursor,
      };
    },
    catch: (cause) => toProviderAdapterError(cause),
  });
```

Turn start:

```ts
const sendTurn = (input: ProviderSendTurnInput) =>
  Effect.tryPromise({
    try: async () => {
      const context = requirePiSession(input.threadId);
      const turnId = input.turnId ?? TurnId.make(crypto.randomUUID());
      context.activeTurnId = turnId;
      context.turnLeafIds.set(turnId, {
        before: context.session.sessionManager.getLeafId(),
      });

      publishTurnStarted(context, turnId);

      void context.session
        .prompt(input.message, {
          images: await resolvePiImages(input.attachments),
          source: "t3",
          preflightResult: (accepted) => {
            if (!accepted) publishTurnFailed(context, turnId, "Pi rejected the prompt preflight.");
          },
        })
        .then(() => {
          context.turnLeafIds.set(turnId, {
            ...context.turnLeafIds.get(turnId),
            after: context.session.sessionManager.getLeafId(),
          });
          context.resumeCursor = buildPiResumeCursor(context);
        })
        .catch((cause) => publishTurnFailed(context, turnId, cause));

      return {
        turnId,
        resume: context.resumeCursor,
      };
    },
    catch: (cause) => toProviderAdapterError(cause),
  });
```

Important adapter rules:

- `interruptTurn` calls `session.abort()`.
- `stopSession` unsubscribes, disposes the Pi runtime/session, and removes the context map entry.
- `respondToRequest` should return a clear stale/unsupported error because Pi does not use T3 approval requests.
- `respondToUserInput` resolves pending extension UI requests created by the headless extension binding.
- `rollbackThread` should navigate Pi's session tree using saved `turnLeafIds`; if the target leaf is missing, return a structured provider error instead of mutating local state.

## 7. Full-Access Safety Semantics

Pi is full-access regardless of T3 runtime mode.

Implementation consequences:

```ts
function normalizePiRuntimeMode() {
  return "full-access" as const;
}
```

When starting Pi sessions:

- Do not pass `noTools`.
- Do not pass a restricted `tools` allowlist.
- Do not wrap Pi built-in tools.
- Do not emit `request.opened` approval events for Pi tool calls.
- Keep `ProviderAdapterShape.respondToRequest` only for interface compatibility.

Provider snapshot should hide or neutralize the interaction-mode toggle:

```ts
presentation: {
  displayName: "Pi",
  badgeLabel: "Full Access",
  showInteractionModeToggle: false,
}
```

If the orchestration layer stores `approval-required` on a thread that later switches to Pi, the Pi adapter still runs full-access. A small UI copy pass should make that explicit so the picker does not imply Pi is sandboxed.

## 8. Event Mapping

Add `pi.sdk.event` to `RuntimeEventRawSource` in `packages/contracts/src/providerRuntime.ts`:

```ts
const RuntimeEventRawSource = Schema.Union([
  Schema.Literal("codex.app-server.notification"),
  Schema.Literal("codex.app-server.request"),
  Schema.Literal("codex.eventmsg"),
  Schema.Literal("claude.sdk.message"),
  Schema.Literal("claude.sdk.permission"),
  Schema.Literal("codex.sdk.thread-event"),
  Schema.Literal("opencode.sdk.event"),
  Schema.Literal("pi.sdk.event"),
  Schema.Literal("acp.jsonrpc"),
  Schema.TemplateLiteral(["acp.", Schema.String, ".extension"]),
]);
```

Create `apps/server/src/provider/pi/PiRuntimeEvents.ts` or keep the mapper next to the adapter.

```ts
function mapPiEvent(input: {
  readonly context: PiSessionContext;
  readonly event: AgentSessionEvent;
}): ReadonlyArray<ProviderRuntimeEvent> {
  const { context, event } = input;
  const base = makePiRuntimeBase(context, event);

  switch (event.type) {
    case "agent_start":
      return [{ ...base, type: "session.state.changed", payload: { state: "running" } }];

    case "agent_end":
      return [{ ...base, type: "session.state.changed", payload: { state: "ready" } }];

    case "turn_start":
      return [{ ...base, type: "turn.started", payload: {} }];

    case "turn_end":
      return [
        {
          ...base,
          type: "turn.completed",
          payload: { state: piTurnEndState(event) },
        },
      ];

    case "message_update":
      return mapPiAssistantMessageEvent(base, event.assistantMessageEvent);

    case "tool_execution_start":
      return [makePiToolStarted(base, event)];

    case "tool_execution_update":
      return [makePiToolUpdated(base, event)];

    case "tool_execution_end":
      return [makePiToolCompleted(base, event)];

    default:
      return [
        {
          ...base,
          type: "runtime.warning",
          payload: {
            message: `Unhandled Pi event: ${event.type}`,
          },
        },
      ];
  }
}
```

Assistant stream mapping:

```ts
function mapPiAssistantMessageEvent(
  base: ProviderRuntimeEventBase,
  event: PiAssistantMessageEvent,
): ReadonlyArray<ProviderRuntimeEvent> {
  switch (event.type) {
    case "text_delta":
      return [
        {
          ...base,
          type: "content.delta",
          payload: {
            kind: "assistant_text",
            delta: event.text,
          },
        },
      ];

    case "thinking_delta":
      return [
        {
          ...base,
          type: "content.delta",
          payload: {
            kind: "reasoning_text",
            delta: event.text,
          },
        },
      ];

    case "error":
      return [
        {
          ...base,
          type: "runtime.error",
          payload: {
            errorClass: "provider_error",
            message: event.errorMessage ?? "Pi provider error",
          },
        },
      ];

    default:
      return [];
  }
}
```

Tool item classification:

```ts
function piToolItemType(toolName: string): ToolLifecycleItemType {
  switch (toolName) {
    case "bash":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    case "read":
    case "grep":
    case "find":
    case "ls":
    default:
      return "dynamic_tool_call";
  }
}
```

## 9. Slash Commands

Create `apps/server/src/provider/pi/PiSlashCommands.ts`.

Static command list:

```ts
export const PI_BUILT_IN_SLASH_COMMANDS = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model" },
  { name: "scoped-models", description: "Enable or disable scoped models" },
  { name: "export", description: "Export session" },
  { name: "import", description: "Import and resume a session" },
  { name: "share", description: "Share session" },
  { name: "copy", description: "Copy last agent message" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "fork", description: "Create a session fork" },
  { name: "clone", description: "Duplicate current session" },
  { name: "tree", description: "Navigate session tree" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload extensions, skills, prompts, and themes" },
  { name: "quit", description: "Quit Pi" },
] satisfies ReadonlyArray<ServerProviderSlashCommand>;
```

Dispatcher sketch:

```ts
export async function dispatchPiSlashCommand(input: {
  readonly context: PiSessionContext;
  readonly name: string;
  readonly args: string;
}) {
  const { context, name, args } = input;

  switch (name) {
    case "new":
      await context.runtime.newSession({ label: args || undefined });
      return { handled: true };

    case "compact":
      await context.session.compact({ customInstructions: args || undefined });
      return { handled: true };

    case "reload":
      await context.session.reload();
      return { handled: true };

    case "name":
      context.session.sessionManager.setSessionName(args.trim());
      return { handled: true };

    case "session":
      publishPiSessionStats(context);
      return { handled: true };

    case "model":
    case "scoped-models":
      publishPiModelPickerRequested(context);
      return { handled: true };

    case "fork":
    case "clone":
    case "tree":
    case "resume":
      publishPiTreeNavigationRequested(context, { command: name, args });
      return { handled: true };

    case "login":
    case "logout":
      publishPiAuthNotice(context, name);
      return { handled: true };

    case "settings":
    case "hotkeys":
    case "changelog":
    case "copy":
    case "quit":
      publishPiUiNotice(context, name);
      return { handled: true };

    default:
      return { handled: false };
  }
}
```

Command execution rule:

```ts
async function handlePiPromptText(context: PiSessionContext, text: string) {
  const parsed = parseSlashCommand(text);
  if (parsed) {
    const result = await dispatchPiSlashCommand({ context, ...parsed });
    if (result.handled) return;
  }

  // Extension commands, skills, and prompt templates should flow through Pi.
  await context.session.prompt(text, { source: "t3" });
}
```

This keeps Pi built-ins first-class without breaking custom slash commands.

## 10. Extensions

Bind Pi extensions after creating each session.

Use Pi's RPC mode as the model: support structured UI requests, no-op terminal UI.

```ts
async function bindPiExtensions(input: {
  readonly context: PiSessionContext;
  readonly runtime: AgentSessionRuntime;
  readonly session: AgentSession;
}) {
  const { context, runtime, session } = input;

  await session.bindExtensions({
    uiContext: createT3PiExtensionUiContext(context),
    commandContextActions: {
      waitForIdle: () => session.agent.waitForIdle(),
      newSession: (options) => runtime.newSession(options),
      fork: async (entryId, options) => {
        const result = await runtime.fork(entryId, options);
        return { cancelled: result.cancelled };
      },
      navigateTree: async (targetId, options) => {
        const result = await session.navigateTree(targetId, options);
        return { cancelled: result.cancelled };
      },
      switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
      reload: () => session.reload(),
    },
    shutdownHandler: () => publishPiUiNotice(context, "quit"),
    onError: (error) => publishPiExtensionError(context, error),
  });
}
```

Headless UI context:

```ts
function createT3PiExtensionUiContext(context: PiSessionContext): ExtensionUIContext {
  return {
    async select(options) {
      return await requestT3UserInput(context, {
        kind: "select",
        title: options.title,
        options: options.options,
      });
    },
    async confirm(options) {
      return await requestT3UserInput(context, {
        kind: "confirm",
        title: options.title,
        message: options.message,
      });
    },
    async input(options) {
      return await requestT3UserInput(context, {
        kind: "text",
        title: options.title,
        placeholder: options.placeholder,
      });
    },
    notify(notification) {
      publishPiNotification(context, notification);
    },
    setStatus(status) {
      publishPiStatus(context, status);
    },
    setWidget(widget) {
      publishPiWidget(context, widget);
    },

    // Terminal/TUI-only APIs are intentionally unsupported in T3 for v1.
    onTerminalInput() {
      return () => {};
    },
    setWorkingIndicator() {},
    setToolsExpanded() {},
    setHeader() {},
    setFooter() {},
    setTheme() {},
    setAutocompleteProvider() {},
  };
}
```

The adapter's `respondToUserInput` should resolve the pending promise created by `requestT3UserInput`. `respondToRequest` remains unsupported because Pi itself is not asking T3 for approvals.

## 11. Session Persistence And Resume

Let Pi own JSONL/session tree persistence. T3 stores only the cursor needed to reopen the Pi session.

```ts
function buildPiResumeCursor(context: PiSessionContext): PiResumeCursor {
  return {
    schemaVersion: 1,
    sessionFile: context.session.sessionManager.getSessionFile(),
    sessionId: context.session.sessionManager.getSessionId(),
    leafId: context.session.sessionManager.getLeafId(),
    cwd: context.cwd,
    agentDir: context.agentDir,
  };
}
```

Open resume:

```ts
async function openOrCreatePiSessionManager(input: {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly sessionDir?: string;
  readonly resume?: PiResumeCursor | null;
}) {
  if (input.resume?.sessionFile) {
    return SessionManager.open(input.resume.sessionFile, input.sessionDir, input.cwd);
  }

  return SessionManager.create(
    input.cwd,
    input.sessionDir?.trim() || getDefaultSessionDir(input.cwd, input.agentDir),
  );
}
```

Recovery rules:

- Missing session file: return a validation provider error that asks the user to start a new Pi session.
- Unknown/stale Pi provider instance from older settings: now resolves as the real `pi` driver instead of an unavailable shadow.
- Invalid resume cursor shape: ignore only if starting a fresh session is explicitly safe; otherwise fail with a clear provider error.

## 12. Text Generation

Add `apps/server/src/textGeneration/PiTextGeneration.ts`.

Use a short-lived Pi SDK session for title/branch/commit text generation so T3 features continue working when Pi is selected as the text-generation provider.

```ts
export const makePiTextGeneration = (settings: PiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.succeed({
    generateText: (input) =>
      Effect.tryPromise({
        try: async () => {
          const { session } = await createAgentSession({
            cwd: input.cwd,
            agentDir: resolvePiAgentDir(settings),
            sessionManager: SessionManager.inMemory(input.cwd),
          });

          try {
            const response = await session.prompt(input.prompt, {
              source: "t3-text-generation",
            });
            return extractLastAssistantText(response);
          } finally {
            await session.dispose();
          }
        },
        catch: (cause) => toTextGenerationError(cause),
      }),
  } satisfies TextGenerationShape);
```

If a no-persistence one-shot path is available in Pi's SDK, prefer that over creating a normal persisted session.

## 13. Testing Plan

Add focused tests. Use `bun run test`, never `bun test`.

Provider/status:

- Pi disabled snapshot.
- Pi installed/authenticated snapshot.
- Pi no configured auth warning.
- Pi model list maps `provider/id` without slug collisions.
- Pi built-in slash commands appear in `slashCommands`.

Registry/settings:

- `providers.pi` hydrates the default `pi` provider instance.
- `providerInstances.pi` wins over legacy settings.
- Existing persisted `pi` instance no longer renders as an unavailable unknown driver.

Adapter:

- start -> prompt -> text delta -> turn completed -> stop.
- thinking deltas map to reasoning text.
- bash/edit/write tool events map to tool lifecycle events without approval requests.
- `interruptTurn` calls `session.abort()`.
- `respondToRequest` returns unsupported/stale approval error.
- extension `input/select/confirm` maps to `user-input.requested` and resolves through `respondToUserInput`.
- stale/missing resume cursor returns a clear provider error.

Slash commands:

- `/new` calls runtime new session.
- `/compact` calls Pi compaction.
- `/reload` reloads Pi resources.
- unknown slash command falls through to `session.prompt()` for extension commands/skills/prompts.

Validation commands:

```bash
bun fmt
bun lint
bun typecheck
bun run test --filter=t3 -- Pi
```

If the final targeted test filter differs from this repo's Turbo/Vitest behavior, use the nearest package-local `bun run test ...` command that only runs the new Pi tests.

## 14. Implementation Order

1. Add SDK dependency.
2. Add settings/contracts/model display metadata.
3. Add web provider metadata and picker/icon plumbing.
4. Add `PiProvider` snapshot/status/model/skills/slash-command discovery.
5. Add `PiDriver` and register it in `BUILT_IN_DRIVERS`.
6. Add `PiAdapter` with start/stop/send/interrupt and full-access semantics.
7. Add Pi event mapper and `pi.sdk.event` raw source.
8. Add headless extension UI binding and `respondToUserInput`.
9. Add slash command dispatcher for Pi built-ins.
10. Add resume cursor and rollback/tree navigation support.
11. Add Pi text generation.
12. Add tests and run validation.

## 15. Non-Goals For V1

- Terminal UI extension rendering.
- Raw terminal input extension hooks.
- T3-managed approval gates for Pi tools.
- Read-only/approval-required Pi mode.
- Reimplementing Pi's session JSONL format.
- Reimplementing Pi's resource loader.

Pi should feel like Pi inside T3: full access, native config, native extensions, native skills, and T3 as the browser-native shell around it.
