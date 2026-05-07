# Pi Extension Support Plan

This implementation plan captures the current Pi extension-system findings and the first T3 Code
implementation target.

The provider/runtime reference and full Pi extension API mapping live in
[`docs/providers/pi.md`](../providers/pi.md). Treat that mapping as the source of truth for what
each `pi.*`, `ctx.*`, and `ctx.ui.*` call should do in T3.

Scope for this version: support the core extension contract first. Custom Pi TUI components can wait.

## Decisions From The Design Interview

- Custom components are out of scope for v1. If an extension calls `ctx.ui.custom(...)`, T3 should persist a UI-only activity entry that says `custom ui coming soon`, then resolve the call as unsupported/cancelled.
- Extension input requests should appear as a popup/card above the input box.
- `ctx.ui.notify(...)`, `ctx.ui.setStatus(...)`, and other transient UI calls should persist into the conversation/activity timeline, not disappear as toasts.
- Persisted extension activity is UI-only history. It must not be included in future model context.
- Extension-injected prompts from `pi.sendUserMessage(...)` should appear as normal user messages.
- Extension input answers are internal extension state. T3 should not automatically create user messages for answers unless the extension sends a user message itself.
- Extension-registered tools should be auto-enabled.
- Extension errors should be non-fatal by default: persist an error activity and keep the session alive unless the Pi session itself crashes.
- Extension commands can hydrate after Pi session init, but before the first message is sent if possible. A slight delay is fine.
- Pi extension commands should only appear in Pi threads.
- Project-local `.pi/extensions` should load automatically along with global/configured Pi extensions. No extra T3 permission prompt.
- Extension shell commands and side effects use Pi's permission model, not T3's approval/runtime-mode model.
- Runtime resolution preference should be:
  1. `~/.pi/agent/node_modules/@mariozechner/pi-coding-agent`
  2. T3's bundled `@mariozechner/pi-coding-agent`
  3. Persisted warning if neither can load.
- Extension-registered providers should surface in the normal model picker after Pi init.
- Provider auth prompts from extensions should use the same popup above the composer.
- Extension commands should be available both through slash autocomplete and a menu/action surface.
- In slash autocomplete, `Enter` on the highlighted extension command should run it immediately; `Tab` should fill it into the composer.
- Menu clicks should run the extension command immediately with no args.
- If the user types `/command arg text`, pass `arg text` to the extension as the raw argument string.
- Commands should fire immediately even while Pi is streaming. The extension owns waiting, queuing, follow-up, or warnings.
- `pi.sendUserMessage(...)` while streaming should appear immediately as a queued follow-up user message.

## Current T3 State

The current Pi adapter starts SDK sessions, maps assistant text/reasoning deltas, maps tool lifecycle events, and binds extensions. The key gap is that extension binding has no real UI context:

```ts
// apps/server/src/provider/Layers/PiAdapter.ts
await input.context.session.bindExtensions({
  commandContextActions,
  shutdownHandler: () => {
    void publishPiRuntimeWarning({
      context: input.context,
      publishRuntimeEvent: input.publishRuntimeEvent,
      message: "Pi extension requested shutdown; close the T3 thread or stop the session instead.",
    });
  },
  onError: (error) => {
    void publishPiRuntimeError({
      context: input.context,
      publishRuntimeEvent: input.publishRuntimeEvent,
      message: extensionErrorMessage(error),
      detail: error,
    });
  },
});
```

Because no `uiContext` is passed, Pi's runner sees `ctx.hasUI === false`, and most `ctx.ui.*` calls are no-ops. That means extensions can load and register commands/tools, but T3 is not hosting their interactive surface.

The current user-input contract is also option-only:

```ts
// packages/contracts/src/providerRuntime.ts
export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  options: Schema.Array(UserInputQuestionOption),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
```

That works for existing choice prompts, but not for Pi's `input(...)` and `editor(...)` dialogs.

Current `respondToUserInput` is a hard failure:

```ts
// apps/server/src/provider/Layers/PiAdapter.ts
const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = () =>
  Effect.fail(
    new ProviderAdapterRequestError({
      provider: PROVIDER,
      method: "item/tool/respondToUserInput",
      detail: "Pi extension user-input requests are not implemented yet.",
    }),
  );
```

Also important: current extension errors use `runtime.error`, and `ProviderRuntimeIngestion` treats that as a session error. That conflicts with the v1 decision that extension failures should be non-fatal.

## Pi SDK Contract To Mirror

Pi already has the right conceptual split in RPC mode:

- Dialog methods: `select`, `confirm`, `input`, `editor`. These block until a response arrives.
- Fire-and-forget methods: `notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`. These do not wait for a response.
- Degraded methods in headless/RPC-like hosts: `custom()` can return unsupported, TUI-only footers/headers/editor components can be no-op or persisted as activity.

The SDK `ExtensionUIContext` methods T3 should care about for v1:

```ts
interface ExtensionUIContext {
  select(
    title: string,
    options: string[],
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions,
  ): Promise<string | undefined>;
  editor(title: string, prefill?: string): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  setStatus(key: string, text: string | undefined): void;
  setWidget(key: string, content: string[] | undefined, options?: ExtensionWidgetOptions): void;
  setTitle(title: string): void;
  setEditorText(text: string): void;
  pasteToEditor(text: string): void;
  getEditorText(): string;
  custom<T>(factory: unknown, options?: unknown): Promise<T>;
}
```

## Local Extension Inventory

Observed global/configured extensions under `/Users/davis/.pi/agent/extensions`:

| Extension               | Main T3 needs                                                              |
| ----------------------- | -------------------------------------------------------------------------- |
| `copy-all.ts`           | slash command, `waitForIdle`, clipboard side effect, persisted notify      |
| `diff.ts`               | agent/tool events, `pi.exec`, select dialog, persisted notify              |
| `firecrawl-search.ts`   | extension tool registration, auto-enabled tools                            |
| `flow-title.ts`         | header/theme APIs can degrade to persisted activity or no-op               |
| `oc.ts`                 | command execution, `pi.sendUserMessage` as normal user message             |
| `usage.ts`              | command execution, `waitForIdle`, `pi.sendUserMessage`                     |
| `tx9/index.ts`          | command execution, streaming follow-up behavior, notify                    |
| `yeet.ts`               | command execution, streaming follow-up behavior, notify                    |
| `zsh-user-bash.ts`      | future `user_bash` path if T3 exposes Pi `!`/`!!` style bash               |
| `tps-tracker.ts`        | status updates persisted as individual activity entries                    |
| `update.ts`             | flags, command, `pi.exec`, reload, notify                                  |
| `opencode-zen-login.ts` | extension provider registration, auth/input popup, model picker refresh    |
| `ephemeral/*`           | command and custom UI. v1 should show `custom ui coming soon`              |
| `pi-mcp/*`              | commands, tool registration, OAuth/input popup, status, custom UI fallback |

The local Pi home uses `@mariozechner/pi-coding-agent@^0.66.1`; T3 currently bundles `@mariozechner/pi-coding-agent@^0.73.0`. This is a real design constraint, not just bookkeeping.

## Implementation Shape

Build a T3-side Pi extension host, not a TypeScript transformer. Extension TypeScript should still run through Pi's loader. T3 should provide compatible runtime objects and project their effects into T3 contracts/UI.

### Slice 1: Extension Activity Events

Add a non-fatal provider runtime event for extension UI/activity. Do not reuse `runtime.error` for extension failures, because that currently transitions the session to error.

Proposed contract:

```ts
// packages/contracts/src/providerRuntime.ts
const ExtensionActivityType = Schema.Literal("extension.activity");

const ExtensionActivityPayload = Schema.Struct({
  source: TrimmedNonEmptyStringSchema, // e.g. "pi.extension.ui"
  activityType: Schema.Literals([
    "notify",
    "status",
    "widget",
    "title",
    "editor",
    "custom-ui",
    "error",
  ]),
  message: TrimmedNonEmptyStringSchema,
  severity: Schema.optional(Schema.Literals(["info", "warning", "error"])),
  extensionPath: Schema.optional(TrimmedNonEmptyStringSchema),
  data: Schema.optional(Schema.Unknown),
  uiOnly: Schema.optional(Schema.Boolean).pipe(Schema.withConstructorDefault(Effect.succeed(true))),
});

const ProviderRuntimeExtensionActivityEvent = Schema.Struct({
  ...ProviderRuntimeEventBase.fields,
  type: ExtensionActivityType,
  payload: ExtensionActivityPayload,
});
```

In `ProviderRuntimeIngestion`, map it directly to an orchestration activity:

```ts
case "extension.activity": {
  return [
    {
      id: event.eventId,
      createdAt: event.createdAt,
      tone: event.payload.severity === "error" ? "error" : "info",
      kind: "extension.activity",
      summary: event.payload.message,
      payload: event.payload,
      turnId: toTurnId(event.turnId) ?? null,
      ...maybeSequence,
    },
  ];
}
```

This preserves notifications, status changes, unsupported custom UI, and extension errors as UI-only transcript activity.

### Slice 2: User Input Contract Upgrade

Extend `UserInputQuestion` instead of inventing a Pi-only popup path. That keeps existing `thread.user-input.respond` routing and the current composer plumbing.

Proposed shape:

```ts
export const UserInputQuestion = Schema.Struct({
  id: TrimmedNonEmptyStringSchema,
  header: TrimmedNonEmptyStringSchema,
  question: TrimmedNonEmptyStringSchema,
  inputKind: Schema.optional(Schema.Literals(["select", "confirm", "text", "textarea"])).pipe(
    Schema.withConstructorDefault(Effect.succeed("select")),
  ),
  options: Schema.Array(UserInputQuestionOption).pipe(
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  placeholder: Schema.optional(Schema.String),
  prefill: Schema.optional(Schema.String),
  multiSelect: Schema.optional(Schema.Boolean).pipe(
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
});
```

Rules:

- `select`: options required. Existing behavior.
- `confirm`: render two options, `Yes` and `No`, and resolve to boolean in the Pi bridge.
- `text`: render a one-line input.
- `textarea`: render a multiline editor.

Update `apps/web/src/session-logic.ts` so `parseUserInputQuestions` accepts empty options for `text` and `textarea`, and update `apps/web/src/pendingUserInput.ts` so text/textarea answers are valid without selected options.

The UI location already mostly matches the desired shape: `ComposerPendingUserInputPanel` is rendered above the composer. It needs text and textarea modes, but the anchoring is right.

### Slice 3: PiExtensionUiBridge

Add a server-side bridge owned by `PiAdapter`.

New file:

```txt
apps/server/src/provider/pi/PiExtensionUiBridge.ts
```

Core responsibilities:

- Implement `ExtensionUIContext`.
- Keep a `pendingDialogs` map from T3 `ApprovalRequestId` to Pi resolvers.
- Emit `user-input.requested` for Pi `select`, `confirm`, `input`, and `editor`.
- Resolve pending dialogs from `respondToUserInput`.
- Emit `extension.activity` for `notify`, `setStatus`, `setWidget`, `setTitle`, `setEditorText`, `pasteToEditor`, unsupported TUI methods, and non-fatal extension errors.
- Make `custom()` persist `custom ui coming soon` and resolve immediately as unsupported.

Skeleton:

```ts
interface PendingPiExtensionDialog {
  readonly kind: "select" | "confirm" | "input" | "editor";
  readonly createdAt: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
}

interface PiExtensionUiBridge {
  readonly uiContext: ExtensionUIContext;
  readonly respond: (
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ) => Promise<void>;
  readonly dispose: () => void;
}

function makePiExtensionUiBridge(input: {
  readonly context: PiSessionContext;
  readonly publishRuntimeEvent: PiRuntimeEventPublisher;
}): PiExtensionUiBridge {
  const pendingDialogs = new Map<ApprovalRequestId, PendingPiExtensionDialog>();

  const publishActivity = async (activity: {
    readonly activityType: ExtensionActivityPayload["activityType"];
    readonly message: string;
    readonly severity?: "info" | "warning" | "error";
    readonly data?: unknown;
  }) => {
    await input.publishRuntimeEvent({
      ...makeContextEventBase(input.context, input.context.activeTurnId),
      type: "extension.activity",
      payload: {
        source: "pi.extension.ui",
        activityType: activity.activityType,
        message: activity.message,
        ...(activity.severity ? { severity: activity.severity } : {}),
        ...(activity.data !== undefined ? { data: activity.data } : {}),
        uiOnly: true,
      },
    });
  };

  const openDialog = <T>(dialog: {
    readonly kind: PendingPiExtensionDialog["kind"];
    readonly title: string;
    readonly message?: string;
    readonly options?: readonly string[];
    readonly placeholder?: string;
    readonly prefill?: string;
    readonly timeout?: number;
    readonly signal?: AbortSignal;
  }) =>
    new Promise<T | undefined>((resolve, reject) => {
      const requestId = ApprovalRequestId.make(crypto.randomUUID());
      pendingDialogs.set(requestId, {
        kind: dialog.kind,
        createdAt: nowIso(),
        resolve,
        reject,
      });

      void input.publishRuntimeEvent({
        ...makeContextEventBase(input.context, input.context.activeTurnId),
        type: "user-input.requested",
        requestId,
        payload: {
          questions: [
            piDialogToUserInputQuestion({
              requestId,
              ...dialog,
            }),
          ],
        },
      });
    });

  const uiContext: ExtensionUIContext = {
    select: (title, options, opts) =>
      openDialog<string>({
        kind: "select",
        title,
        options,
        timeout: opts?.timeout,
        signal: opts?.signal,
      }),
    confirm: async (title, message, opts) => {
      const value = await openDialog<boolean>({
        kind: "confirm",
        title,
        message,
        timeout: opts?.timeout,
        signal: opts?.signal,
      });
      return value === true;
    },
    input: (title, placeholder, opts) =>
      openDialog<string>({
        kind: "input",
        title,
        placeholder,
        timeout: opts?.timeout,
        signal: opts?.signal,
      }),
    editor: (title, prefill) =>
      openDialog<string>({
        kind: "editor",
        title,
        prefill,
      }),
    notify: (message, type = "info") => {
      void publishActivity({ activityType: "notify", message, severity: type });
    },
    setStatus: (key, text) => {
      void publishActivity({
        activityType: "status",
        message: text ? `${key}: ${text}` : `${key}: cleared`,
        data: { key, text },
      });
    },
    setWidget: (key, content, options) => {
      if (Array.isArray(content)) {
        void publishActivity({
          activityType: "widget",
          message: `${key}: ${content.join("\\n")}`,
          data: { key, content, options },
        });
        return;
      }
      if (content) {
        void publishActivity({
          activityType: "custom-ui",
          message: "custom ui coming soon",
          data: { key, options },
        });
      }
    },
    setTitle: (title) => {
      void publishActivity({ activityType: "title", message: title });
    },
    custom: async () => {
      await publishActivity({
        activityType: "custom-ui",
        message: "custom ui coming soon",
      });
      return undefined as never;
    },
    // v1 degraded methods:
    onTerminalInput: () => () => {},
    setWorkingMessage: (message) => {
      if (message) void publishActivity({ activityType: "status", message });
    },
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setFooter: () => {},
    setHeader: () => {},
    pasteToEditor: (text) => {
      void publishActivity({ activityType: "editor", message: text, data: { action: "paste" } });
    },
    setEditorText: (text) => {
      void publishActivity({ activityType: "editor", message: text, data: { action: "set" } });
    },
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: makeT3FallbackPiTheme(),
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "T3 Pi theme switching is not implemented yet." }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  return {
    uiContext,
    respond: async (requestId, answers) => {
      const pending = pendingDialogs.get(requestId);
      if (!pending) {
        throw new Error(`Unknown pending Pi extension input request: ${requestId}`);
      }
      pendingDialogs.delete(requestId);
      pending.resolve(resolvePiDialogAnswer(pending.kind, answers));
    },
    dispose: () => {
      for (const pending of pendingDialogs.values()) {
        pending.resolve(undefined);
      }
      pendingDialogs.clear();
    },
  };
}
```

Actual implementation should avoid broad `unknown` payloads where the contract can be specific. The snippet is intentionally a shape, not final copy-paste code.

### Slice 4: Bind The Bridge

Extend the Pi session context:

```ts
interface PiSessionContext {
  // existing fields...
  extensionUiBridge?: PiExtensionUiBridge;
}
```

Then pass it into Pi:

```ts
const extensionUiBridge = makePiExtensionUiBridge({
  context: liveContext,
  publishRuntimeEvent,
});
liveContext.extensionUiBridge = extensionUiBridge;

await bindPiExtensions({
  context: liveContext,
  publishRuntimeEvent,
  uiContext: extensionUiBridge.uiContext,
});
```

And update `bindPiExtensions`:

```ts
async function bindPiExtensions(input: {
  readonly context: PiSessionContext;
  readonly publishRuntimeEvent: PiRuntimeEventPublisher;
  readonly uiContext: ExtensionUIContext;
}) {
  await input.context.session.bindExtensions({
    uiContext: input.uiContext,
    commandContextActions,
    shutdownHandler,
    onError: (error) => {
      void publishPiExtensionActivity({
        context: input.context,
        publishRuntimeEvent: input.publishRuntimeEvent,
        message: extensionErrorMessage(error),
        severity: "error",
        detail: error,
      });
    },
  });
}
```

Then `respondToUserInput` becomes real:

```ts
const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
  threadId,
  requestId,
  answers,
) =>
  Effect.gen(function* () {
    const context = yield* requireSession(threadId);
    const bridge = context.extensionUiBridge;
    if (!bridge) {
      return yield* new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "item/tool/respondToUserInput",
        detail: "Pi extension UI bridge is not available for this session.",
      });
    }
    yield* Effect.tryPromise({
      try: () => bridge.respond(requestId, answers),
      catch: (cause) => toAdapterError(PROVIDER, threadId, "item/tool/respondToUserInput", cause),
    });
  });
```

### Slice 5: Dynamic Commands, Tools, Providers, And Models

After `bindExtensions`, emit a session config/update event containing extension commands and tool metadata. Existing `session.configured` has `config: UnknownRecordSchema`, so it can carry the first version without a new event type:

```ts
function getPiExtensionConfigSnapshot(session: AgentSession) {
  const runner = session.extensionRunner;
  return {
    extensionPaths: runner.getExtensionPaths(),
    slashCommands: runner.getRegisteredCommands().map((command) => ({
      name: command.name,
      description: command.description,
      input: command.input ? { hint: command.input.hint } : undefined,
      source: "extension",
      sourceInfo: command.sourceInfo,
    })),
    tools: runner.getAllRegisteredTools().map((tool) => ({
      name: tool.definition.name,
      description: tool.definition.description,
      sourceInfo: tool.sourceInfo,
    })),
    flags: [...runner.getFlags().keys()],
  };
}
```

Publish it:

```ts
await publishRuntimeEvent({
  type: "session.configured",
  eventId: nextEventId(),
  provider: PROVIDER,
  providerInstanceId,
  threadId: input.threadId,
  createdAt: nowIso(),
  payload: {
    config: {
      piExtensions: getPiExtensionConfigSnapshot(session),
    },
  },
});
```

Then choose one of two UI hydration paths:

1. Preferred: let server provider snapshots refresh for the active Pi instance after session init/reload, so the existing composer reads `selectedProviderStatus.slashCommands`.
2. Faster first pass: store session-scoped `piExtensions.slashCommands` in thread activity/state and merge it into composer menu items only for the active Pi thread.

The preferred end state is provider snapshot refresh, because extension-registered providers/models also need the model picker. The first pass can still use `session.configured` for immediate command hydration.

Model/provider updates:

- After extension binding, call Pi model registry `getAvailable()` again.
- Rebuild Pi models with extension-registered providers included.
- Refresh the active Pi provider instance snapshot.
- The model picker already refreshes providers when opened, so the server side mostly needs an explicit "this instance changed" invalidation path.

### Slice 6: Slash Command Execution Semantics

Current selection behavior fills provider slash commands into the composer:

```ts
// apps/web/src/components/chat/ChatComposer.tsx
if (item.type === "provider-slash-command") {
  const replacement = `/${item.command.name} `;
  // ...
  applyPromptReplacement(...);
}
```

Need split behavior:

- `Tab` fills the highlighted item into the composer.
- `Enter` runs the highlighted provider slash command immediately.
- Clicking a provider command in the command menu runs it immediately with no args.
- If the user typed `/something some text` and submits, T3 passes the full text into Pi. `parsePiSlashCommand` already extracts `name` and raw `args`.

Suggested refactor:

```ts
type ComposerCommandActivation = "fill" | "run";

const onSelectComposerItem = useCallback(
  (item: ComposerCommandItem, activation: ComposerCommandActivation = "fill") => {
    // path, built-ins, skills keep current fill/open behavior.
    if (item.type === "provider-slash-command" && activation === "run") {
      const commandText = `/${item.command.name}`;
      applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
        expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
      });
      onSendWithPrompt(commandText);
      return;
    }

    if (item.type === "provider-slash-command") {
      fillProviderSlashCommand(item);
      return;
    }
  },
  [
    /* existing deps */
  ],
);

// key handling
if (key === "Enter" && selectedItem) {
  onSelectComposerItem(selectedItem, "run");
  return true;
}
if (key === "Tab" && selectedItem) {
  onSelectComposerItem(selectedItem, "fill");
  return true;
}
```

There may not be a clean `onSendWithPrompt` helper today. If so, add a small internal helper that mirrors the existing submit flow but accepts an override prompt.

Server-side, do not special-case extension commands in `dispatchPiSlashCommand`. Let `AgentSession.prompt(...)` execute registered extension commands immediately. Only built-in T3-handled Pi commands should stay in `dispatchPiSlashCommand`.

### Slice 7: Queued Follow-Up User Messages

Pi `AgentSession.prompt(...)` already knows that extension commands execute immediately even during streaming. Extension calls to `pi.sendUserMessage(...)` can queue follow-ups.

T3 still needs to project those queued/injected user messages:

- Listen to Pi `queue_update` and persist activity for follow-up queue changes.
- Map Pi user `message_start` or `message_end` events into real T3 user messages when the user message was created by Pi, not by T3's original `thread.turn.start`.
- Use a deterministic provider item id or Pi message id if available to avoid duplicates.
- Mark streaming-time injected messages as queued/follow-up immediately in the transcript, then let later Pi events transition naturally when processed.

This is essential for `/yeet`, `/usage`, `/oc`, and `/tx9`, because the user decision is that injected prompts should be normal user messages, not hidden automation.

### Slice 8: Tool Output Projection

Pi `tool_execution_*` events must render text outputs in the UI the same way other providers do.
This includes built-in tool calls such as `read`, `bash`/exec-style command execution, `grep`,
`find`, `ls`, `edit`, and `write`, plus extension-registered tools with text results.

Requirements:

- Continue using canonical `item.started`, `item.updated`, and `item.completed` events.
- Map Pi `bash`/exec-style tools to `itemType: "command_execution"`.
- Map Pi `edit` and `write` to `itemType: "file_change"`.
- Map Pi `read`, `grep`, `find`, `ls`, and extension tools to `itemType: "dynamic_tool_call"`
  unless a more precise canonical type exists.
- Put displayable text into `payload.detail` when it should appear in the transcript.
- Keep structured output in `payload.data`, including `rawOutput.stdout`, `rawOutput.stderr`,
  `rawOutput.content`, `command`, `exitCode`, and `toolCallId` when available.
- Make sure read-file contents, command stdout/stderr, grep/find/ls output, and extension tool text
  are visible without requiring the user to inspect raw JSON.
- For partial output, update the same work-log/tool row by `toolCallId`.
- Reuse existing T3 truncation/collapse behavior for long outputs.

Suggested helper shape:

```ts
function piToolDisplayPayload(event: Extract<AgentSessionEvent, { type: "tool_execution_end" }>) {
  const rawOutput = normalizePiToolRawOutput(event.toolName, event.result);
  const detail = summarizePiToolDisplayText(event.toolName, rawOutput);
  return {
    itemType: piToolItemType(event.toolName),
    status: event.isError ? "failed" : "completed",
    title: piToolTitle(event.toolName),
    ...(detail ? { detail } : {}),
    data: {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      rawOutput,
    },
  };
}
```

The important part is that `payload.detail` carries the text the timeline should print, while
`payload.data.rawOutput` keeps the fuller structured result for copy/debug/details views.

### Slice 9: Project-Local Extensions

Pi's loader should already discover:

- Global `~/.pi/agent/extensions`
- Configured extension paths from `settings.json`
- Workspace-local `.pi/extensions`

T3 must ensure session `cwd` is the actual thread workspace/worktree cwd before `createAgentSession` and `bindExtensions`. That makes project-local extension loading automatic and scoped to the active thread.

No extra permission prompt.

### Slice 10: Runtime Version Resolution

The desired resolution order is local Pi home first, then T3's bundled SDK. This likely cannot be solved by only changing imports inside `PiAdapter`, because the session, extension runner, model registry, and type contracts need to come from the same Pi runtime.

Recommended design:

- Add a thin Pi runtime loader module:

```txt
apps/server/src/provider/pi/PiRuntimeResolver.ts
```

- Resolve package candidates:

```ts
const candidates = [
  join(agentDir, "node_modules/@mariozechner/pi-coding-agent"),
  "@mariozechner/pi-coding-agent",
] as const;
```

- Import the first candidate that works.
- Keep one runtime module per Pi session context.
- Emit `extension.activity` or `config.warning` if local Pi runtime fails and T3 falls back.

Sketch:

```ts
interface PiRuntimeModule {
  readonly VERSION: string;
  readonly AuthStorage: typeof import("@mariozechner/pi-coding-agent").AuthStorage;
  readonly ModelRegistry: typeof import("@mariozechner/pi-coding-agent").ModelRegistry;
  readonly SessionManager: typeof import("@mariozechner/pi-coding-agent").SessionManager;
  readonly createAgentSession: typeof import("@mariozechner/pi-coding-agent").createAgentSession;
}

async function resolvePiRuntime(agentDir: string | undefined): Promise<{
  readonly runtime: PiRuntimeModule;
  readonly source: "agent-dir" | "bundled";
  readonly warning?: string;
}> {
  // Implementation should use dynamic import via pathToFileURL for the agent-dir package.
}
```

This is the riskiest slice because the rest of `PiAdapter.ts` currently imports Pi classes statically. A practical migration is:

1. Land UI bridge against the current bundled SDK.
2. Move Pi imports behind `PiRuntimeResolver`.
3. Verify local `~/.pi/agent` runtime compatibility.

### Slice 11: Web Rendering

Update the existing composer popup rather than creating a separate modal:

- `ComposerPendingUserInputPanel` renders above the composer already.
- Add rendering modes for `inputKind`.
- Add one-line input and textarea draft state to `PendingUserInputDraftAnswer`.
- Preserve current option shortcut behavior for select/confirm.
- For text/textarea, submit button uses the typed value.

Suggested draft type:

```ts
export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
  textAnswer?: string;
}
```

Then make `resolvePendingUserInputAnswer` branch by `question.inputKind`:

```ts
if (question.inputKind === "text" || question.inputKind === "textarea") {
  return normalizeDraftAnswer(draft?.textAnswer ?? draft?.customAnswer);
}
```

For `confirm`, the bridge can encode options as `Yes` and `No` and translate back to boolean, so the existing option UI can be reused.

### Slice 12: Command Menu Surface

Add a Pi extension command menu/action surface near the composer controls. It should:

- Only render for Pi-selected threads.
- Use the hydrated extension command list.
- Click runs the command immediately with no args.
- Keep slash autocomplete for typed args.
- Avoid trying to infer which commands require args.

The command menu is separate from the slash autocomplete menu. It can be a compact menu button with extension command rows.

### Slice 13: Testing Plan

Unit tests:

- `packages/contracts/src/providerRuntime.test.ts`
  - decodes `extension.activity`
  - decodes `UserInputQuestion` for `select`, `confirm`, `text`, `textarea`
- `apps/server/src/provider/Layers/PiAdapter.test.ts`
  - binds extensions with `uiContext`
  - `notify` emits `extension.activity`
  - extension `onError` emits non-fatal `extension.activity`, not `runtime.error`
  - `select/input/editor/confirm` emit `user-input.requested`
  - `respondToUserInput` resolves pending Pi dialog
  - `custom()` emits `custom ui coming soon`
  - Pi `read`, `bash`/exec, `grep`, `find`, `ls`, `edit`, and `write` tool outputs populate
    displayable `payload.detail` plus structured `payload.data.rawOutput`
- `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.test.ts`
  - `extension.activity` persists as activity and does not set session error
  - text/textarea user-input events persist and clear correctly
  - Pi tool output activities preserve visible detail text like other providers
- `apps/web/src/session-logic.test.ts`
  - derives pending text/textarea prompts
  - clears stale pending Pi extension prompts
  - derives visible work-log details from Pi `payload.detail` and `data.rawOutput`
- `apps/web/src/pendingUserInput.test.ts`
  - resolves text, textarea, select, confirm answers
- `apps/web/src/components/chat/composerSlashCommandSearch.test.ts`
  - provider extension commands search/filter correctly
- `apps/web/src/components/chat/ChatComposer.logic.test.ts` or nearest existing composer test
  - `Enter` runs provider command
  - `Tab` fills provider command
  - click command menu item runs command

Manual verification using the user's local extensions:

1. Select a Pi model in a new thread and wait for extension commands to hydrate.
2. Confirm `/yeet`, `/usage`, `/oc`, and `/tx9` appear for Pi only.
3. Run `/yeet` while idle and verify the expanded prompt appears as a normal user message.
4. Run `/tx9` while streaming and verify the injected prompt appears as a queued follow-up user message.
5. Run `/copy-all` and verify notify activity is persisted.
6. Run `/diff` and verify the select popup appears above the composer.
7. Verify `tps-tracker` status updates append individual activity rows.
8. Run `/ephemeral` and verify `custom ui coming soon` appears as UI-only activity.
9. Verify Firecrawl tools are auto-enabled if `FIRECRAWL_API_KEY` is configured in Pi's environment.
10. Verify OpenCode Zen provider registration refreshes the model picker after Pi init.
11. Ask Pi to read a file and verify the read output appears in the transcript tool row.
12. Ask Pi to run a command and verify stdout/stderr appears in the transcript tool row like other
    providers.

Required completion commands for code changes:

```bash
bun fmt
bun lint
bun typecheck
```

Do not run `bun test`; use targeted `bun run test ...` if tests are needed.

## Recommended Implementation Order

1. Add `extension.activity` contract and ingestion mapping.
2. Extend user-input question schema and web popup rendering for `text` and `textarea`.
3. Add `PiExtensionUiBridge` and wire `respondToUserInput`.
4. Switch extension `onError` to non-fatal `extension.activity`.
5. Publish session extension config after binding and reload.
6. Hydrate Pi extension commands into slash autocomplete for Pi threads only.
7. Implement `Enter` run versus `Tab` fill for provider slash commands.
8. Add command menu surface that runs commands with no args.
9. Project extension-injected user messages and follow-up queue activity.
10. Project Pi tool text output into visible tool rows for `read`, `bash`/exec, `grep`, `find`,
    `ls`, `edit`, `write`, and extension tools.
11. Auto-enable and expose extension tools.
12. Refresh provider/model snapshots for extension-registered providers.
13. Move Pi runtime resolution behind local-agent-dir-first resolver.

## Non-Goals For v1

- Rendering Pi TUI custom components in the browser.
- Full `ctx.ui.setHeader`, `setFooter`, `setEditorComponent`, raw terminal input, or theme mutation parity.
- T3-specific permission prompts for Pi extension execution.
- Guessing which extension commands require args.
- Rewriting existing Pi extensions for T3.

## Later Custom UI Direction

When it is time to support custom components, the likely path is a browser-hosted TUI line renderer:

- Server calls the Pi component factory.
- Server calls `component.render(width)` and sends rendered lines to the browser.
- Browser renders ANSI/text lines in an overlay above the composer or in a modal.
- Browser sends key input back to server.
- Server calls `component.handleInput(data)`.
- `tui.requestRender()` becomes a render-update event.
- `done(value)` resolves the `ctx.ui.custom(...)` promise.

That should unlock `ephemeral` and `pi-mcp` without rewriting them, but it is deliberately not part of the first support layer.
