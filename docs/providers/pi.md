# Pi

This is the T3 Code reference for Pi provider behavior and Pi extension compatibility.

The implementation roadmap lives in
[`docs/implementation-plans/pi-extension-support.md`](../implementation-plans/pi-extension-support.md).
This provider doc is the source of truth for the Pi extension API mapping: when an extension calls a
Pi function, this file says how T3 should handle it.

## Runtime Model

T3 Code should host Pi through the Pi SDK, not by translating extension TypeScript. The extension
code stays Pi-shaped. T3 provides compatible runtime objects and projects extension effects into T3
provider runtime events, orchestration activity, composer UI, and provider/model state.

Runtime resolution preference:

1. Use `~/.pi/agent/node_modules/@mariozechner/pi-coding-agent` when available.
2. Fall back to T3's bundled `@mariozechner/pi-coding-agent`.
3. Persist a visible warning if neither runtime can load.

Extension discovery should match Pi:

- global `~/.pi/agent/extensions`
- extension paths configured by Pi settings
- workspace-local `.pi/extensions`

Project-local extensions always run for Pi sessions. T3 does not add a separate permission prompt
for Pi extensions. Pi extension shell execution uses Pi's permission model, not T3's approval model.

## Mapping Status

The tables below use these status labels:

- `v1`: planned for the first T3 Pi extension support layer.
- `native`: Pi SDK already owns the behavior. T3 should avoid reimplementing it.
- `project`: Pi SDK owns the behavior, but T3 should project visible state into the UI.
- `degrade`: accept the call but persist a UI-only activity/warning or return a safe fallback.
- `future`: intentionally not handled in v1.
- `internal`: available to extensions, but no T3-facing behavior is needed.

Persisted extension activity and Pi panel state are UI-only history. They must not be included in
future model context.

## Pi Runtime Panel

When the selected provider is Pi, T3 renders a small Pi panel from the composer. The panel is not a
second chat interface and does not replace T3's composer. It is the home for Pi's TUI-adjacent
surfaces: header, footer, status, widgets, extension inventory, and diagnostics.

The panel has three tabs:

- `Home`: the Pi TUI projection. It contains header state, keyed status rows, working message,
  string widgets, title metadata, and footer state.
- `Extensions`: loaded extension paths, registered extension tools/commands/providers when known,
  and Pi skills. Slash commands still belong in `/` autocomplete, not in a separate commands tab.
- `Logs`: Pi diagnostics and extension lifecycle messages. High-frequency hook failures are deduped
  here and hidden from the normal Work Log.

The open panel has a fixed maximum height inside the composer. Its tab body owns scrolling, so long
extension or skill lists never resize the composer surface after the panel is opened.

Closed state:

- The closed Pi button may show one compact status summary, for example
  `Pi · tps 42 tok/s`, sourced from `ctx.ui.setStatus(...)`.
- Warning/error counts are T3 diagnostics and should appear as a quiet badge, not inline status copy.

Pi TUI surface mapping:

| Pi TUI surface | T3 panel section | Pi function source                                                                  |
| -------------- | ---------------- | ----------------------------------------------------------------------------------- |
| Header         | `Home` header    | `ctx.ui.setHeader(...)`; fallback from title/session/git metadata when available.   |
| Input          | T3 composer      | T3 keeps its own composer. Pi input prompts render above the composer when pending. |
| Body widgets   | `Home` widgets   | `ctx.ui.setWidget(...)`; string widgets render, component widgets degrade in v1.    |
| Status/footer  | `Home` status    | `ctx.ui.setStatus(...)` and `ctx.ui.setWorkingMessage(...)`.                        |
| Footer         | `Home` footer    | `ctx.ui.setFooter(...)`; fallback from cwd, branch, model, usage, and context.      |
| Logs           | `Logs`           | extension load/reload messages, `bindExtensions({ onError })`, degraded UI calls.   |

Implementation rules:

- `ctx.ui.setStatus(...)`, `ctx.ui.setWorkingMessage(...)`, `ctx.ui.setTitle(...)`, and
  `ctx.ui.setWidget(...)` update keyed Pi panel state. They do not append normal Work Log rows.
- Before a Pi session emits per-thread activity, T3 should seed the panel from the provider snapshot:
  static extension paths, extension tools, extension slash commands, Pi skills, and available Pi
  models. Live `pi.extension.configured` activity replaces this once the session is bound.
- `ctx.ui.notify(...)` remains user-visible activity when appropriate, and may also be mirrored in
  Pi logs.
- Extension hook errors are non-fatal diagnostics. They are deduped by extension path, hook event,
  and error message, then displayed in the Pi `Logs` tab instead of the normal Work Log.
- Repeated diagnostics should publish the first occurrence and occasional count updates, not one row
  per failure.
- Unsupported custom TUI components should create a restrained placeholder in the relevant Pi panel
  surface and a diagnostic log entry. They should not throw or hang the extension.
- T3 should strip terminal ANSI sequences before rendering Pi panel text in the browser.

## `ctx.ui` Mapping

| Pi extension key                                   | T3 status | T3 handling                                                                                                                                           |
| -------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ctx.ui.select(title, options, opts)`              | `v1`      | Emit `user-input.requested` with `inputKind: "select"` and render a popup above the composer. Resolve with the selected option string or `undefined`. |
| `ctx.ui.confirm(title, message, opts)`             | `v1`      | Emit `user-input.requested` with `inputKind: "confirm"` and render a popup above the composer. Resolve `true` or `false`.                             |
| `ctx.ui.input(title, placeholder, opts)`           | `v1`      | Emit `user-input.requested` with `inputKind: "text"`. Resolve with submitted text or `undefined`.                                                     |
| `ctx.ui.editor(title, prefill)`                    | `v1`      | Emit `user-input.requested` with `inputKind: "textarea"`. Resolve with submitted text or `undefined`.                                                 |
| `ctx.ui.notify(message, type)`                     | `v1`      | Persist `extension.activity` with `activityType: "notify"` and severity from `type`. No toast-only behavior.                                          |
| `ctx.ui.setStatus(key, text)`                      | `v1`      | Update keyed Pi panel status state. If `text` is omitted, clear that status key. High-frequency updates should be throttled/deduped.                  |
| `ctx.ui.setWorkingMessage(message)`                | `v1`      | Update the Pi panel working/status row. If omitted, clear the custom working message.                                                                 |
| `ctx.ui.setWidget(key, stringLines, options)`      | `v1`      | Update keyed Pi panel widget state with string lines and placement metadata.                                                                          |
| `ctx.ui.setWidget(key, componentFactory, options)` | `degrade` | Update a Pi panel widget placeholder and emit a diagnostic. Do not render the component in v1.                                                        |
| `ctx.ui.setTitle(title)`                           | `v1`      | Update Pi panel title/header metadata. Do not change browser title in v1.                                                                             |
| `ctx.ui.custom(factory, options)`                  | `degrade` | Emit a Pi panel diagnostic and resolve as unsupported/cancelled so the extension does not hang.                                                       |
| `ctx.ui.pasteToEditor(text)`                       | `degrade` | Update internal editor text state and emit a Pi panel diagnostic in v1. Future work can mutate the composer.                                          |
| `ctx.ui.setEditorText(text)`                       | `degrade` | Update internal editor text state and emit a Pi panel diagnostic in v1. Future work can mutate the composer.                                          |
| `ctx.ui.getEditorText()`                           | `degrade` | Return `""` in v1. Future work can request current composer text from the client.                                                                     |
| `ctx.ui.onTerminalInput(handler)`                  | `future`  | Return an unsubscribe no-op. Optional one-time activity warning if an extension registers this.                                                       |
| `ctx.ui.setWorkingVisible(visible)`                | `future`  | No-op in v1. Optional UI-only activity for visibility changes.                                                                                        |
| `ctx.ui.setWorkingIndicator(options)`              | `future`  | No-op in v1.                                                                                                                                          |
| `ctx.ui.setHiddenThinkingLabel(label)`             | `future`  | No-op in v1. Future mapping can alter reasoning block labels.                                                                                         |
| `ctx.ui.setFooter(factory)`                        | `degrade` | Update Pi panel footer placeholder state and emit a diagnostic when a custom factory is provided.                                                     |
| `ctx.ui.setHeader(factory)`                        | `degrade` | Update Pi panel header placeholder state and emit a diagnostic when a custom factory is provided.                                                     |
| `ctx.ui.addAutocompleteProvider(factory)`          | `future`  | No-op in v1. Future mapping can compose into T3 composer autocomplete.                                                                                |
| `ctx.ui.setEditorComponent(factory)`               | `future`  | No-op in v1.                                                                                                                                          |
| `ctx.ui.getEditorComponent()`                      | `future`  | Return `undefined` in v1.                                                                                                                             |
| `ctx.ui.theme`                                     | `degrade` | Return a stable fallback Pi-compatible theme object. Do not bind to T3 theme mutation in v1.                                                          |
| `ctx.ui.getAllThemes()`                            | `future`  | Return `[]` in v1.                                                                                                                                    |
| `ctx.ui.getTheme(name)`                            | `future`  | Return `undefined` in v1.                                                                                                                             |
| `ctx.ui.setTheme(theme)`                           | `future`  | Return `{ success: false, error }` and persist an unsupported activity if useful.                                                                     |
| `ctx.ui.getToolsExpanded()`                        | `future`  | Return `false` in v1.                                                                                                                                 |
| `ctx.ui.setToolsExpanded(expanded)`                | `future`  | No-op in v1.                                                                                                                                          |

T3 should set `ctx.hasUI === true` once this bridge exists. The UI is real for dialogs,
notifications, status, and text widgets, even though custom TUI components are degraded.

## `ctx` Mapping

| Pi extension key           | T3 status | T3 handling                                                                                       |
| -------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| `ctx.ui`                   | `v1`      | Use the T3 `PiExtensionUiBridge` described above.                                                 |
| `ctx.hasUI`                | `v1`      | Return `true` after bridge installation.                                                          |
| `ctx.cwd`                  | `native`  | Comes from the Pi session cwd. Must be the thread workspace/worktree cwd.                         |
| `ctx.sessionManager`       | `native`  | Expose Pi's read-only session manager. T3 should not wrap in v1.                                  |
| `ctx.modelRegistry`        | `native`  | Expose Pi model registry. T3 refreshes provider snapshots after extension provider/model changes. |
| `ctx.model`                | `native`  | Current Pi model.                                                                                 |
| `ctx.isIdle()`             | `native`  | Delegate to Pi agent state.                                                                       |
| `ctx.signal`               | `native`  | Current Pi abort signal when streaming.                                                           |
| `ctx.abort()`              | `native`  | Abort current Pi operation. T3 should project the resulting turn/session events.                  |
| `ctx.hasPendingMessages()` | `project` | Delegate to Pi. T3 should project queue/follow-up state for visibility.                           |
| `ctx.shutdown()`           | `degrade` | Persist a warning. Do not let extensions quit T3 in v1.                                           |
| `ctx.getContextUsage()`    | `native`  | Delegate to Pi. Future work can project into T3 context meter if needed.                          |
| `ctx.compact(options)`     | `project` | Delegate to Pi compaction. T3 should project compaction start/end activity and thread state.      |
| `ctx.getSystemPrompt()`    | `native`  | Delegate to Pi. No T3 UI behavior.                                                                |

## Command `ctx` Mapping

These methods exist on `ExtensionCommandContext`, which command handlers receive.

| Pi extension key                          | T3 status | T3 handling                                                                                  |
| ----------------------------------------- | --------- | -------------------------------------------------------------------------------------------- |
| `ctx.waitForIdle()`                       | `native`  | Delegate to `session.agent.waitForIdle()`.                                                   |
| `ctx.reload()`                            | `v1`      | Delegate to `session.reload()`, then republish extension command/tool/provider config to T3. |
| `ctx.newSession(options)`                 | `future`  | Persist warning and return `{ cancelled: true }` in v1.                                      |
| `ctx.fork(entryId, options)`              | `future`  | Persist warning and return `{ cancelled: true }` in v1.                                      |
| `ctx.navigateTree(targetId, options)`     | `future`  | Persist warning and return `{ cancelled: true }` in v1.                                      |
| `ctx.switchSession(sessionPath, options)` | `future`  | Persist warning and return `{ cancelled: true }` in v1.                                      |

`ReplacedSessionContext.sendMessage(...)` and `ReplacedSessionContext.sendUserMessage(...)` only
matter after new-session/fork/switch support exists. Until then, the replacement-session path should
not be reachable.

## `pi` Factory API Mapping

This is the API passed to extension factories as `pi`.

| Pi extension key                                   | T3 status  | T3 handling                                                                                                                                  |
| -------------------------------------------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi.registerTool(tool)`                            | `v1`       | Let Pi register and execute the tool. Auto-enable extension tools. Publish tool metadata to T3 after init/reload.                            |
| `pi.registerCommand(name, options)`                | `v1`       | Let Pi register the command. Hydrate into T3 slash autocomplete for Pi threads only.                                                         |
| `pi.registerShortcut(shortcut, options)`           | `future`   | Registration may succeed inside Pi, but T3 does not bind shortcuts in v1. Optionally publish unsupported shortcut diagnostics.               |
| `pi.registerFlag(name, options)`                   | `degrade`  | Defaults exist inside Pi. T3 has no per-session CLI flag input in v1.                                                                        |
| `pi.getFlag(name)`                                 | `degrade`  | Return Pi's current flag/default value. User-provided flag values are future work.                                                           |
| `pi.registerMessageRenderer(customType, renderer)` | `future`   | Registration may succeed, but T3 does not render custom Pi message components in v1. Use fallback activity/message rendering.                |
| `pi.sendMessage(message, options)`                 | `future`   | Pi can persist custom messages. T3 should add fallback projection later.                                                                     |
| `pi.sendUserMessage(content, options)`             | `v1`       | Project as a normal user message. If streaming, show immediately as queued follow-up and let Pi process it later.                            |
| `pi.appendEntry(customType, data)`                 | `native`   | Pi session persistence only. No T3 UI projection in v1 unless paired with custom-message support.                                            |
| `pi.setSessionName(name)`                          | `v1`       | Project Pi `session_info_changed` to T3 `thread.metadata.updated`.                                                                           |
| `pi.getSessionName()`                              | `native`   | Delegate to Pi session manager.                                                                                                              |
| `pi.setLabel(entryId, label)`                      | `future`   | Pi-native label persistence. No T3 tree/label UI in v1.                                                                                      |
| `pi.exec(command, args, options)`                  | `native`   | Execute with Pi permissions/environment. T3 should not route through approval prompts. Optional future activity projection.                  |
| `pi.getActiveTools()`                              | `v1`       | Delegate to Pi and expose through T3 tools UI/state when available.                                                                          |
| `pi.getAllTools()`                                 | `v1`       | Delegate to Pi. Publish tool metadata after init/reload.                                                                                     |
| `pi.setActiveTools(toolNames)`                     | `v1`       | Delegate to Pi. Project active tool state if T3 has a tools UI.                                                                              |
| `pi.getCommands()`                                 | `v1`       | Delegate to Pi. Used to hydrate slash autocomplete/menu.                                                                                     |
| `pi.setModel(model)`                               | `v1`       | Delegate to Pi. Refresh T3 model picker/provider snapshot.                                                                                   |
| `pi.getThinkingLevel()`                            | `native`   | Delegate to Pi.                                                                                                                              |
| `pi.setThinkingLevel(level)`                       | `project`  | Delegate to Pi. Project thinking-level changes where T3 exposes model options.                                                               |
| `pi.registerProvider(name, config)`                | `v1`       | Delegate to Pi model registry. Refresh T3 model picker/provider snapshot after init/reload. Auth prompts use the same extension input popup. |
| `pi.unregisterProvider(name)`                      | `v1`       | Delegate to Pi and refresh T3 provider snapshot.                                                                                             |
| `pi.events`                                        | `internal` | Pi extension-to-extension event bus. No T3 bridge needed in v1.                                                                              |

## `pi.on(...)` Event Mapping

All event handlers are registered through `pi.on(eventName, handler)`.

| Event key                 | T3 status | T3 handling                                                                                                          |
| ------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `resources_discover`      | `project` | Pi loads returned skill/prompt/theme paths. T3 republishes session config after startup/reload.                      |
| `session_start`           | `native`  | Pi emits during startup/resume/reload/new/fork. T3 projects config after handlers run.                               |
| `session_before_switch`   | `future`  | Only meaningful once T3 supports Pi session switching.                                                               |
| `session_before_fork`     | `future`  | Only meaningful once T3 supports Pi forking.                                                                         |
| `session_before_compact`  | `native`  | Pi compaction honors handler result. T3 should project compaction activity.                                          |
| `session_compact`         | `project` | Pi-native. Project activity/thread state.                                                                            |
| `session_shutdown`        | `native`  | Pi emits on reload/teardown. T3 should dispose bridge and pending dialogs.                                           |
| `session_before_tree`     | `future`  | Only meaningful once T3 supports Pi session tree navigation.                                                         |
| `session_tree`            | `future`  | Only meaningful once T3 supports Pi session tree navigation.                                                         |
| `context`                 | `native`  | Pi lets extensions modify messages before provider call. T3 should not duplicate this logic.                         |
| `before_provider_request` | `native`  | Pi lets extensions replace provider payload. T3 should not inspect sensitive payloads unless needed for debugging.   |
| `after_provider_response` | `native`  | Pi emits after provider response. T3 no special behavior in v1.                                                      |
| `before_agent_start`      | `native`  | Pi can inject custom messages or replace system prompt. T3 should project any visible custom messages later.         |
| `agent_start`             | `project` | Pi-native. T3 can persist status/activity if useful.                                                                 |
| `agent_end`               | `project` | Pi-native. T3 can persist status/activity if useful.                                                                 |
| `turn_start`              | `project` | Pi-native. T3 already owns canonical turn start for user sends. Use carefully to avoid duplicates.                   |
| `turn_end`                | `project` | Pi-native. T3 should project completion/usage where available.                                                       |
| `message_start`           | `project` | Needed for extension-injected user messages and custom messages.                                                     |
| `message_update`          | `project` | T3 already maps assistant text/reasoning deltas.                                                                     |
| `message_end`             | `project` | Needed to finalize projected assistant/user/custom messages.                                                         |
| `tool_execution_start`    | `project` | T3 maps to `item.started`. Include enough display data for the same tool row UI used by other providers.             |
| `tool_execution_update`   | `project` | T3 maps to `item.updated`. Streaming/partial text output must be visible in the tool row when Pi provides it.        |
| `tool_execution_end`      | `project` | T3 maps to `item.completed`. Final text output must be visible in the tool row, not hidden only in raw `data`.       |
| `model_select`            | `project` | Project to provider/model state and model picker.                                                                    |
| `thinking_level_select`   | `project` | Project to model option state if visible.                                                                            |
| `tool_call`               | `native`  | Pi allows blocking or mutating tool input. T3 should not revalidate mutated args.                                    |
| `tool_result`             | `native`  | Pi allows modifying tool results. T3 projects final tool lifecycle after Pi modifications.                           |
| `user_bash`               | `future`  | Only meaningful if T3 exposes Pi `!`/`!!` user bash input.                                                           |
| `input`                   | `native`  | Pi transforms or handles user input before agent processing. T3 should call `session.prompt(...)` so this hook runs. |

## Tool Definition Mapping

Extension tools are registered through `pi.registerTool(tool)`.

| Tool definition key                                       | T3 status | T3 handling                                                                         |
| --------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `tool.name`                                               | `v1`      | Publish as extension tool metadata and use in T3 tool lifecycle rows.               |
| `tool.label`                                              | `v1`      | Use as display label when available.                                                |
| `tool.description`                                        | `v1`      | Publish in tool metadata and tools UI.                                              |
| `tool.promptSnippet`                                      | `native`  | Pi uses it in the system prompt when tool is active.                                |
| `tool.promptGuidelines`                                   | `native`  | Pi uses it in the system prompt when tool is active.                                |
| `tool.parameters`                                         | `native`  | Pi validates and exposes schema to the model. T3 may display later.                 |
| `tool.renderShell`                                        | `future`  | Pi TUI rendering hint. T3 can ignore in v1.                                         |
| `tool.prepareArguments(args)`                             | `native`  | Pi calls before schema validation.                                                  |
| `tool.executionMode`                                      | `native`  | Pi controls sequential/parallel execution.                                          |
| `tool.execute(toolCallId, params, signal, onUpdate, ctx)` | `native`  | Pi executes with extension `ctx`. T3 projects tool lifecycle events emitted by Pi.  |
| `tool.renderCall(args, theme, context)`                   | `future`  | Custom TUI component rendering. T3 falls back to generic tool call display in v1.   |
| `tool.renderResult(result, options, theme, context)`      | `future`  | Custom TUI component rendering. T3 falls back to generic tool result display in v1. |

## Tool Output Projection

Pi tool execution events must render like tool calls from the other providers. This is especially
important for built-in tool families such as `read`, `bash`/command execution, `grep`, `find`, `ls`,
`edit`, `write`, and extension tools that return text.

Mapping requirements:

- Use canonical `item.started`, `item.updated`, and `item.completed` events.
- Use `itemType: "command_execution"` for Pi `bash`/exec-style commands.
- Use `itemType: "file_change"` for Pi `edit` and `write`.
- Use `itemType: "dynamic_tool_call"` for Pi `read`, `grep`, `find`, `ls`, and extension tools
  unless a more specific canonical type exists later.
- Put human-readable stdout/file contents/result previews into `payload.detail` when they should be
  shown in the transcript.
- Keep structured/raw tool result data in `payload.data`, including `data.rawOutput.stdout`,
  `data.rawOutput.stderr`, `data.rawOutput.content`, command, exit code, and tool call id when
  available.
- Do not make the UI depend on opening raw JSON to see command output or read-file contents.
- Reuse the same truncation, collapse, and copy behavior used by existing T3 tool rows.
- For partial output, update the same tool row by `toolCallId`; do not append unrelated activity
  entries for each chunk unless Pi emitted a separate tool execution.

## Event Result Mapping

Some `pi.on(...)` handlers return values that Pi consumes. T3 should let the Pi SDK own these
semantics and only project visible outcomes.

| Handler result key                                                                           | T3 status | T3 handling                                                                                                             |
| -------------------------------------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------- |
| `resources_discover -> { skillPaths, promptPaths, themePaths }`                              | `native`  | Pi extends its resources. T3 republishes refreshed config after startup/reload.                                         |
| `context -> { messages }`                                                                    | `native`  | Pi replaces/augments context messages before the provider call. Do not include extension activity rows in this context. |
| `before_provider_request -> payload`                                                         | `native`  | Pi replaces provider request payload. T3 should avoid logging raw provider payloads.                                    |
| `before_agent_start -> { message }`                                                          | `project` | Pi can inject a custom message. T3 custom-message projection is future work unless it becomes a normal user message.    |
| `before_agent_start -> { systemPrompt }`                                                     | `native`  | Pi replaces/chains system prompt. T3 does not need to mirror prompt text.                                               |
| `message_end -> { message }`                                                                 | `native`  | Pi replaces finalized message. T3 should project the final message after Pi modifications.                              |
| `tool_call -> { block, reason }`                                                             | `native`  | Pi blocks tool execution. T3 should project final tool lifecycle/error if emitted by Pi.                                |
| `tool_result -> { content, details, isError }`                                               | `native`  | Pi modifies final tool result. T3 should project the modified result.                                                   |
| `user_bash -> { operations }`                                                                | `future`  | Only needed if T3 exposes Pi `!`/`!!` user bash.                                                                        |
| `user_bash -> { result }`                                                                    | `future`  | Only needed if T3 exposes Pi `!`/`!!` user bash.                                                                        |
| `input -> { action: "continue" }`                                                            | `native`  | Pi proceeds with the original input.                                                                                    |
| `input -> { action: "transform", text, images }`                                             | `native`  | Pi proceeds with transformed input. T3 should project the final user-visible message carefully to avoid duplicates.     |
| `input -> { action: "handled" }`                                                             | `native`  | Pi treats input as handled by extension. T3 should avoid starting a duplicate assistant turn.                           |
| `session_before_switch -> { cancel }`                                                        | `future`  | Session switching is not v1.                                                                                            |
| `session_before_fork -> { cancel, skipConversationRestore }`                                 | `future`  | Session forking is not v1.                                                                                              |
| `session_before_tree -> { cancel, summary, customInstructions, replaceInstructions, label }` | `future`  | Session tree navigation is not v1.                                                                                      |
| `session_before_compact -> { cancel, compaction }`                                           | `native`  | Pi compaction honors this. T3 projects compaction activity.                                                             |

## Importable Extension Helpers

These helpers can be imported from `@mariozechner/pi-coding-agent` by extension code. They are not
`ctx` methods, but they are part of the extension authoring surface.

| Helper key                             | T3 status  | T3 handling                                                                                |
| -------------------------------------- | ---------- | ------------------------------------------------------------------------------------------ |
| `defineTool(tool)`                     | `native`   | Type/inference helper for extension authors. No T3 runtime behavior.                       |
| `isToolCallEventType(toolName, event)` | `native`   | Type guard helper. No T3 runtime behavior.                                                 |
| `isBashToolResult(event)`              | `native`   | Type guard helper. No T3 runtime behavior.                                                 |
| `isReadToolResult(event)`              | `native`   | Type guard helper. No T3 runtime behavior.                                                 |
| `isEditToolResult(event)`              | `native`   | Type guard helper. No T3 runtime behavior.                                                 |
| `isWriteToolResult(event)`             | `native`   | Type guard helper. No T3 runtime behavior.                                                 |
| `isGrepToolResult(event)`              | `native`   | Type guard helper. No T3 runtime behavior.                                                 |
| `isFindToolResult(event)`              | `native`   | Type guard helper. No T3 runtime behavior.                                                 |
| `isLsToolResult(event)`                | `native`   | Type guard helper. No T3 runtime behavior.                                                 |
| `createExtensionRuntime()`             | `internal` | Pi loader/runtime helper. T3 may use internally, but normal extensions should not need it. |
| `discoverAndLoadExtensions(...)`       | `internal` | Pi loader helper. T3 may use through Pi SDK/session creation.                              |
| `loadExtensionFromFactory(...)`        | `internal` | Pi loader helper. No direct T3 bridge behavior.                                            |
| `loadExtensions(...)`                  | `internal` | Pi loader helper. No direct T3 bridge behavior.                                            |
| `ExtensionRunner`                      | `internal` | Pi runtime class. T3 interacts with it through `AgentSession.extensionRunner`.             |
| `wrapRegisteredTool(...)`              | `internal` | Pi wrapper helper. No direct T3 bridge behavior.                                           |
| `wrapRegisteredTools(...)`             | `internal` | Pi wrapper helper. No direct T3 bridge behavior.                                           |

## Slash Command Behavior

Extension commands should appear only when the selected provider/model is Pi.

Hydration can happen after Pi session init. The composer may show a slight delay before extension
commands arrive.

Interaction rules:

- Typing `/command arg text` sends the raw input to Pi. Pi parses the command and receives
  `arg text`.
- `Enter` on a highlighted provider slash command runs it immediately.
- `Tab` on a highlighted provider slash command fills it into the composer.
- Clicking a provider command in the menu runs it immediately with no args.
- Commands run immediately even while a turn is streaming. Extensions decide whether to wait,
  queue, follow up, warn, or fail.

## User Input Behavior

Pi dialog answers are internal extension state. T3 does not automatically persist a user message for
an input answer.

If the extension uses the answer in TypeScript only, no user message is added. If the extension calls
`pi.sendUserMessage(...)`, that injected prompt is persisted as a normal user message.

## Error Behavior

Extension errors are non-fatal by default.

T3 should persist Pi diagnostics for extension hook/command errors, then continue the session. Do
not map extension hook/command errors to `runtime.error` unless the Pi session itself crashes.

Diagnostics belong in the Pi panel `Logs` tab by default. The normal Work Log should only show
extension errors when they are directly user-actionable and intentionally marked for the main
surface. High-frequency hooks such as `message_update` must be deduped and suppressed after the
first visible diagnostic.

## Current Local Extension Coverage

The user's current Pi home exercises these v1 surfaces:

- `/yeet`, `/usage`, `/oc`, `/tx9`: command hydration and `pi.sendUserMessage(...)`.
- `/copy-all`: command execution, `waitForIdle`, `notify`.
- `/diff`: command execution, `pi.exec`, `select`, `notify`.
- `tps-tracker`: frequent `setStatus` and final `notify`.
- `firecrawl-search`: extension tools `search` and `scrape`.
- `pi-mcp`: commands, tool registration, status, auth/input prompts, custom UI fallback.
- `opencode-zen-login`: provider registration and auth/input prompts.
- `/ephemeral`: custom UI fallback with `custom ui coming soon`.

## Future Custom UI Direction

The later custom UI layer should host Pi TUI-style components instead of rewriting them:

1. Server calls the component factory.
2. Server calls `component.render(width)`.
3. Browser renders ANSI/text lines.
4. Browser sends key input back to the server.
5. Server calls `component.handleInput(data)`.
6. `tui.requestRender()` emits a render update.
7. `done(value)` resolves the original `ctx.ui.custom(...)` promise.

That future layer should unlock custom overlays like `/ephemeral` and the Pi MCP panel.
