# 18 - Provider-Agnostic Cleanup

Follow-up to the `t3code/provider-kind-model` PR which introduced the `ModelSelection`
discriminated union and removed `inferProviderForModel()`. Three items remain to complete
the provider-agnostic vision and make adding new providers mechanical.

---

## Item 1: Consolidate dual model-options representation

### Problem

The composer draft store carries two parallel representations of model options:

```
draft.modelSelection: { provider: "codex", model: "gpt-5.4", options: { fastMode: true } }
draft.modelOptions:   { codex: { fastMode: true }, claudeAgent: { effort: "max" } }
```

Every mutation must sync both via `syncModelSelectionOptions()` and
`mergeModelSelectionIntoProviderModelOptions()`. The sync logic is a bug surface and
the dual representation creates ambiguity about which is authoritative.

The `ProviderModelOptions` bag exists for a good reason: when you switch providers and
switch back, your per-provider options should survive the round-trip. The fix is not to
remove the bag concept, but to eliminate the *dual* representation.

### Target state

Replace the parallel fields with a single `ModelSelection`-per-provider map:

```ts
// Before
draft.modelSelection: ModelSelection | null      // active selection (provider + model + options)
draft.modelOptions: ProviderModelOptions | null   // bag of options keyed by provider

// After
draft.modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>
draft.activeProvider: ProviderKind | null
```

The active `ModelSelection` is derived:
`draft.modelSelectionByProvider[draft.activeProvider]`. No sync needed -- each provider's
full selection (model + options) lives in one place. Switching providers changes
`activeProvider`; the old provider's entry is preserved.

Sticky state follows the same shape:
```ts
stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>
```

### Phase 1A: Refactor the draft store internals

**Files:** `apps/web/src/composerDraftStore.ts`, `apps/web/src/composerDraftStore.test.ts`

1. Replace `ComposerThreadDraftState` fields:
   - Remove `modelSelection: ModelSelection | null`
   - Remove `modelOptions: ProviderModelOptions | null`
   - Add `modelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>`
   - Add `activeProvider: ProviderKind | null`

2. Replace global sticky fields in `ComposerDraftStoreState`:
   - Remove `stickyModelSelection: ModelSelection | null`
   - Remove `stickyModelOptions: ProviderModelOptions`
   - Add `stickyModelSelectionByProvider: Partial<Record<ProviderKind, ModelSelection>>`

3. Delete sync functions that exist only to maintain the dual representation:
   - `syncModelSelectionOptions()`
   - `mergeModelSelectionIntoProviderModelOptions()`
   - `replaceProviderModelOptions()`

4. Simplify store actions:
   - `setModelSelection(threadId, selection)` -- writes to
     `draft.modelSelectionByProvider[selection.provider]` and sets
     `draft.activeProvider = selection.provider`
   - `setProviderModelOptions(threadId, provider, options)` -- updates
     `draft.modelSelectionByProvider[provider].options` in place. If the entry
     doesn't exist yet, create it with the provider's default model.
   - `setStickyModelSelection(selection)` -- writes to
     `stickyModelSelectionByProvider[selection.provider]`
   - Remove `setModelOptions()` (the bag setter) and `setStickyModelOptions()`

5. Rewrite `deriveEffectiveComposerModelState()`:
   - Read options from `draft.modelSelectionByProvider[provider].options`
   - Fall back to `threadModelSelection.options` then
     `projectModelSelection.options`
   - No bag indexing needed

6. Update persistence schema:
   - `PersistedComposerThreadDraftState` replaces `modelSelection` + `modelOptions`
     with `modelSelectionByProvider` + `activeProvider`
   - `PersistedComposerDraftStoreState` replaces `stickyModelSelection` +
     `stickyModelOptions` with `stickyModelSelectionByProvider`
   - Bump storage version to 3
   - Write v2 -> v3 migration: for each draft, reconstruct
     `modelSelectionByProvider` from the old `modelSelection` (active provider entry)
     merged with `modelOptions` (other providers' entries with default models).
     For sticky state, same approach.

7. Update legacy migration code (`LegacyCodexFields`, `LegacyStickyModelFields`,
   `LegacyThreadModelFields`) to produce the new shape directly. These can be
   simplified since they no longer need to produce two parallel outputs.

### Phase 1B: Remove `ProviderModelOptions` from contracts and UI consumers

**Files:** `packages/contracts/src/model.ts`, `apps/web/src/components/chat/composerProviderRegistry.tsx`,
`apps/web/src/components/ChatView.tsx`, `apps/web/src/components/chat/CompactComposerControlsMenu.browser.tsx`,
`apps/web/src/components/chat/ClaudeTraitsPicker.tsx`, `apps/web/src/components/chat/CodexTraitsPicker.tsx`

1. In `contracts/model.ts`: delete the `ProviderModelOptions` schema and type export.
   Keep `CodexModelOptions` and `ClaudeModelOptions` -- they're referenced by the
   `ModelSelection` variants in `orchestration.ts`.

2. In `composerProviderRegistry.tsx`: change `ComposerProviderStateInput` to accept
   `options: CodexModelOptions | ClaudeModelOptions | undefined` instead of
   `modelOptions: ProviderModelOptions | null | undefined`. The registry entry
   receives already-extracted provider options from `modelSelection.options`.

3. In `ChatView.tsx`: `useEffectiveComposerModelState` returns
   `{ selectedModel, options }` instead of `{ selectedModel, modelOptions }`.
   `getComposerProviderState` receives the typed options directly.

4. In `CompactComposerControlsMenu.browser.tsx`: remove the
   `provider === "codex" ? props.modelOptions.codex : props.modelOptions.claudeAgent`
   ternary. Component receives pre-extracted typed options.

5. Trait pickers already receive typed `ClaudeModelOptions` / `CodexModelOptions`.
   Only parent callsite plumbing changes.

### Phase 1C: Server-side verification

**Files:** `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`,
`apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/wsServer.ts`

1. Verify the server never reads from a `ProviderModelOptions` bag. From analysis of
   the current code, it doesn't -- the server works exclusively with
   `ModelSelection.options`. This phase is a verification pass.

2. Remove any residual imports of `ProviderModelOptions` in server code.

3. Grep for remaining references to ensure the type is fully eliminated.

---

## Item 2: Data-driven model capabilities

### Problem

`packages/shared/src/model.ts` is full of imperative capability checks:

```ts
const CLAUDE_OPUS_4_6_MODEL = "claude-opus-4-6";
export function supportsClaudeFastMode(model) {
  return normalizeModelSlug(model, "claudeAgent") === CLAUDE_OPUS_4_6_MODEL;
}
```

Adding a new model or provider requires touching 5+ functions. The capability
information should be *data* on the model definition, not scattered conditionals.
This is the primary bottleneck for adding new providers.

### Target state

Model capabilities are declared inline with model definitions in `contracts/model.ts`.
The imperative `supportsXxx` functions in `shared/model.ts` become thin lookups against
a capabilities index. Adding a new model means adding one entry to the data table.

### Phase 2A: Define a model capability schema

**File:** `packages/contracts/src/model.ts`

1. Define the capability shape:

```ts
type ModelCapabilities = {
  readonly reasoningEffortLevels: readonly string[];
  readonly supportsFastMode: boolean;
  readonly supportsThinkingToggle: boolean;
};

type ModelDefinition = {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ModelCapabilities;
};
```

2. Embed capabilities in `MODEL_OPTIONS_BY_PROVIDER`:

```ts
export const MODEL_OPTIONS_BY_PROVIDER = {
  codex: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      capabilities: {
        reasoningEffortLevels: CODEX_REASONING_EFFORT_OPTIONS,
        supportsFastMode: true,
        supportsThinkingToggle: false,
      },
    },
    // ... other codex models
  ],
  claudeAgent: [
    {
      slug: "claude-opus-4-6",
      name: "Claude Opus 4.6",
      capabilities: {
        reasoningEffortLevels: ["low", "medium", "high", "max", "ultrathink"],
        supportsFastMode: true,
        supportsThinkingToggle: false,
      },
    },
    {
      slug: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      capabilities: {
        reasoningEffortLevels: ["low", "medium", "high", "ultrathink"],
        supportsFastMode: false,
        supportsThinkingToggle: false,
      },
    },
    {
      slug: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      capabilities: {
        reasoningEffortLevels: [],
        supportsFastMode: false,
        supportsThinkingToggle: true,
      },
    },
  ],
} as const satisfies Record<ProviderKind, readonly ModelDefinition[]>;
```

3. Build a lookup index:

```ts
export const MODEL_CAPABILITIES_INDEX: Record<
  ProviderKind,
  Record<string, ModelCapabilities>
> = Object.fromEntries(
  Object.entries(MODEL_OPTIONS_BY_PROVIDER).map(([provider, models]) => [
    provider,
    Object.fromEntries(models.map((m) => [m.slug, m.capabilities])),
  ]),
) as Record<ProviderKind, Record<string, ModelCapabilities>>;
```

4. Define provider-level defaults for custom/unknown models:

```ts
export const DEFAULT_CAPABILITIES_BY_PROVIDER: Record<ProviderKind, ModelCapabilities> = {
  codex: {
    reasoningEffortLevels: CODEX_REASONING_EFFORT_OPTIONS as unknown as string[],
    supportsFastMode: true,
    supportsThinkingToggle: false,
  },
  claudeAgent: {
    reasoningEffortLevels: ["low", "medium", "high"],
    supportsFastMode: false,
    supportsThinkingToggle: false,
  },
};
```

### Phase 2B: Replace imperative gates with data lookups

**File:** `packages/shared/src/model.ts`

1. Add a central capability resolver:

```ts
export function getModelCapabilities(
  provider: ProviderKind,
  model: string | null | undefined,
): ModelCapabilities {
  const slug = normalizeModelSlug(model, provider);
  if (slug && MODEL_CAPABILITIES_INDEX[provider]?.[slug]) {
    return MODEL_CAPABILITIES_INDEX[provider][slug];
  }
  return DEFAULT_CAPABILITIES_BY_PROVIDER[provider];
}
```

2. Rewrite `supportsXxx` functions as thin lookups (signatures unchanged, all call
   sites continue to work):

```ts
export function supportsClaudeFastMode(model: string | null | undefined): boolean {
  return getModelCapabilities("claudeAgent", model).supportsFastMode;
}

export function supportsClaudeThinkingToggle(model: string | null | undefined): boolean {
  return getModelCapabilities("claudeAgent", model).supportsThinkingToggle;
}

export function supportsClaudeAdaptiveReasoning(model: string | null | undefined): boolean {
  return getModelCapabilities("claudeAgent", model).reasoningEffortLevels.length > 0;
}

export function supportsClaudeMaxEffort(model: string | null | undefined): boolean {
  return getModelCapabilities("claudeAgent", model).reasoningEffortLevels.includes("max");
}

export function supportsClaudeUltrathinkKeyword(model: string | null | undefined): boolean {
  return supportsClaudeAdaptiveReasoning(model);
}
```

3. Rewrite `getReasoningEffortOptions()`:

```ts
export function getReasoningEffortOptions(
  provider: ProviderKind,
  model?: string | null,
): readonly string[] {
  return getModelCapabilities(provider, model).reasoningEffortLevels;
}
```

   Remove the overloaded signatures that return provider-specific types. The return
   type becomes `readonly string[]`. Consumers that need the specific type can cast,
   or we can add type predicates later.

4. Rewrite `normalizeClaudeModelOptions()` and `normalizeCodexModelOptions()` to use
   `getModelCapabilities()` internally instead of calling individual `supportsXxx`
   functions. Logic stays the same, data source changes.

5. Remove hardcoded model constants:
   - `CLAUDE_OPUS_4_6_MODEL`
   - `CLAUDE_SONNET_4_6_MODEL`
   - `CLAUDE_HAIKU_4_5_MODEL`

### Phase 2C: Verify call sites are unchanged

**Files:** `apps/web/src/components/chat/ClaudeTraitsPicker.tsx`,
`apps/web/src/components/chat/CodexTraitsPicker.tsx`,
`apps/web/src/components/chat/composerProviderRegistry.tsx`,
`apps/server/src/provider/Layers/ClaudeAdapter.ts`

1. All existing `supportsXxx()` call sites continue to work -- the function signatures
   are unchanged, only the implementation is swapped to data lookups.

2. `ClaudeAdapter.ts` calls to `supportsClaudeFastMode()`,
   `supportsClaudeThinkingToggle()`, `getReasoningEffortOptions()` still work
   identically.

3. Trait pickers call `supportsClaudeFastMode(model)` etc. -- no change needed.

4. **Future benefit**: adding a new provider means defining its models with inline
   capabilities in `MODEL_OPTIONS_BY_PROVIDER`. No new `supportsXxx` functions needed.
   Custom models from app settings get reasonable behavior via
   `DEFAULT_CAPABILITIES_BY_PROVIDER[provider]`.

### Phase 2D: Provider-generic capability functions

Add provider-generic alternatives that don't hardcode "claude" in the name:

```ts
export function modelSupportsFastMode(provider: ProviderKind, model: string | null | undefined): boolean {
  return getModelCapabilities(provider, model).supportsFastMode;
}
```

The Claude-specific wrappers can remain as aliases for backward compatibility, but new
code should prefer the generic versions.

### Phase 2E: Unify trait picker components

With data-driven capabilities, the separate `ClaudeTraitsPicker` and `CodexTraitsPicker`
components become unnecessary. They render the same UI primitives in the same structure,
just parameterized differently:

| Section | Codex | Claude |
|---------|-------|--------|
| Effort/reasoning radio group | Always (label "Reasoning") | If model has effort levels (label "Effort") |
| Thinking toggle | Never | If `supportsThinkingToggle` (Haiku) |
| Fast mode toggle | Always | If `supportsFastMode` (Opus) |
| Trigger label | `"{effort} · Fast"` | `"{effort/thinking} · Fast"` |

The only truly provider-specific behavior is Claude's **ultrathink prompt injection**:
when effort is "ultrathink", it modifies the prompt text instead of setting an option,
and locks the effort radio group with an explanatory message.

#### 2E.1: Add trait metadata to capabilities

**File:** `packages/contracts/src/model.ts`

Extend `ModelCapabilities` with display and behavioral metadata:

```ts
type ModelCapabilities = {
  readonly reasoningEffortLevels: readonly string[];
  readonly supportsFastMode: boolean;
  readonly supportsThinkingToggle: boolean;
  readonly effortSectionLabel: string;                       // "Reasoning" | "Effort"
  readonly promptInjectedEffortLevels: readonly string[];    // ["ultrathink"] for Claude, [] for Codex
};
```

Add a provider-level effort label config:

```ts
export const EFFORT_DISPLAY_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
  ultrathink: "Ultrathink",
};
```

This replaces the separate `CLAUDE_EFFORT_LABELS` and `CODEX_REASONING_LABELS` records
in each picker component.

#### 2E.2: Create unified `TraitsPicker` component

**File:** `apps/web/src/components/chat/TraitsPicker.tsx` (new, replaces both pickers)

The component receives `provider`, `model`, `threadId`, `options`, `prompt`,
`onPromptChange` and renders sections purely from capabilities data:

```tsx
function TraitsMenuContent({ provider, model, threadId, options, prompt, onPromptChange }) {
  const caps = getModelCapabilities(provider, model);
  const effortLevels = caps.reasoningEffortLevels;
  const promptInjected = caps.promptInjectedEffortLevels;

  return (
    <>
      {effortLevels.length > 0 && (
        <EffortSection
          label={caps.effortSectionLabel}
          levels={effortLevels}
          promptInjectedLevels={promptInjected}
          currentEffort={...}
          defaultEffort={...}
          prompt={prompt}
          onPromptChange={onPromptChange}
          onEffortChange={...}
        />
      )}
      {caps.supportsThinkingToggle && (
        <ThinkingSection enabled={options?.thinking ?? true} onChange={...} />
      )}
      {caps.supportsFastMode && (
        <FastModeSection enabled={options?.fastMode === true} onChange={...} />
      )}
    </>
  );
}
```

Key design points:

- **Effort section** handles both normal effort (set via options) and prompt-injected
  effort (like ultrathink) via the `promptInjectedLevels` parameter. If the current
  prompt contains a prompt-injected effort keyword, the radio group is locked with an
  explanatory message -- same as current Claude behavior, but driven by data.

- **Trigger label** is built generically: collect the active effort label (or thinking
  state if no effort), append "Fast" if fast mode is on, join with " · ".

- **`onEffortChange` handler** checks `promptInjectedLevels.includes(nextEffort)`. If
  true, it injects into the prompt via `onPromptChange`. Otherwise, it updates options
  via `setProviderModelOptions`. This generalizes the current ultrathink-specific logic.

- **No provider `if` branches** in the component body. All behavior flows from `caps`.

#### 2E.3: Update the provider registry

**File:** `apps/web/src/components/chat/composerProviderRegistry.tsx`

The registry entries for both providers now point to the same `TraitsMenuContent` and
`TraitsPicker` components. The registry still exists (it's a `Record<ProviderKind, ...>`
so it's exhaustive-safe), but both entries delegate to the unified component:

```ts
const composerProviderRegistry: Record<ProviderKind, ProviderRegistryEntry> = {
  codex: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => <TraitsMenuContent {...input} />,
    renderTraitsPicker: (input) => <TraitsPicker {...input} />,
  },
  claudeAgent: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => <TraitsMenuContent {...input} />,
    renderTraitsPicker: (input) => <TraitsPicker {...input} />,
  },
};
```

At this point, the registry becomes a thin pass-through. It can optionally be simplified
further (e.g. a single `getProviderRegistryEntry()` that returns the same object for
all providers), but the `Record<ProviderKind, ...>` shape is still useful as a compile-
time exhaustiveness check when new providers are added.

`getProviderStateFromCapabilities` replaces the two inline `getState` implementations.
It uses `getModelCapabilities(provider, model)` to determine prompt effort, normalize
options, and compute CSS classes (e.g. ultrathink frame styling is driven by
`caps.promptInjectedEffortLevels` + prompt content, not by `provider === "claudeAgent"`).

#### 2E.4: Delete old picker components

**Files to delete:**
- `apps/web/src/components/chat/ClaudeTraitsPicker.tsx`
- `apps/web/src/components/chat/CodexTraitsPicker.tsx`

**Files to update:**
- `apps/web/src/components/chat/ClaudeTraitsPicker.browser.tsx` -- rename to
  `TraitsPicker.browser.tsx`, update to test unified component with both providers
- `apps/web/src/components/chat/CodexTraitsPicker.browser.tsx` -- merge test cases into
  `TraitsPicker.browser.tsx`
- `apps/web/src/components/chat/CompactComposerControlsMenu.browser.tsx` -- import from
  unified component
- Any other import sites

#### 2E.5: Normalize options generically

**File:** `packages/shared/src/model.ts`

Replace `normalizeClaudeModelOptions()` and `normalizeCodexModelOptions()` with a single
generic function:

```ts
export function normalizeModelOptions(
  provider: ProviderKind,
  model: string | null | undefined,
  options: Record<string, unknown> | null | undefined,
): Record<string, unknown> | undefined {
  const caps = getModelCapabilities(provider, model);
  const result: Record<string, unknown> = {};

  // Reasoning effort
  if (options?.reasoningEffort || options?.effort) {
    const effortKey = provider === "codex" ? "reasoningEffort" : "effort";
    const raw = (options?.reasoningEffort ?? options?.effort) as string;
    const resolved = caps.reasoningEffortLevels.includes(raw) ? raw : null;
    const isPromptInjected = caps.promptInjectedEffortLevels?.includes(resolved ?? "");
    const isDefault = resolved === getDefaultReasoningEffort(provider);
    if (resolved && !isPromptInjected && !isDefault) {
      result[effortKey] = resolved;
    }
  }

  // Thinking toggle
  if (caps.supportsThinkingToggle && options?.thinking === false) {
    result.thinking = false;
  }

  // Fast mode
  if (caps.supportsFastMode && options?.fastMode === true) {
    result.fastMode = true;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
```

Note: the effort key name difference (`reasoningEffort` for Codex vs `effort` for
Claude) is an existing schema inconsistency. This can either be normalized in a future
schema migration, or handled via a `effortOptionKey` field on the capabilities. For now
the function handles both.

The old `normalizeClaudeModelOptions()` and `normalizeCodexModelOptions()` become thin
wrappers that call `normalizeModelOptions()` with the appropriate provider, for backward
compatibility at existing call sites.

---

## Item 3: Exhaustiveness enforcement

### Problem

Ternary branches like `provider === "codex" ? ... : ...` silently give the `else` branch
to any new provider added to `ProviderKind`. The `Record<ProviderKind, ...>` pattern
(used in contracts and the provider registry) is already exhaustive-safe, but ~10 sites
use unsafe ternaries.

### Target state

All provider dispatches either use `Record<ProviderKind, ...>` lookups (already
compile-time safe) or `switch` statements with `assertNever` in the default branch.
A lint marker or convention makes the pattern obvious.

### Phase 3A: Add an `assertNever` utility

**File:** `packages/shared/src/assertNever.ts` (new)

```ts
/**
 * Compile-time exhaustiveness check. Use in `default:` branches of switch
 * statements over discriminated unions. Produces a type error if any variant
 * is unhandled, and throws at runtime if reached.
 */
export function assertNever(value: never, message?: string): never {
  throw new Error(message ?? `Unexpected value: ${JSON.stringify(value)}`);
}
```

The codebase already uses the `_exhaustiveCheck: never` pattern in `wsServer.ts`.
This standardizes it as a reusable utility.

### Phase 3B: Add `PROVIDER_DISPLAY_NAMES` to contracts

**File:** `packages/contracts/src/model.ts`

```ts
export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
};
```

This eliminates display-name ternaries across the UI.

### Phase 3C: Convert unsafe ternaries

Listed by priority (most likely to cause silent bugs when a new provider is added):

1. **`apps/web/src/composerDraftStore.ts` line 492**
   ```ts
   // Before
   const options = provider === "codex" ? modelOptions?.codex : modelOptions?.claudeAgent;
   // After (eliminated entirely by Item 1 -- modelSelectionByProvider replaces this)
   ```

2. **`apps/web/src/components/chat/CompactComposerControlsMenu.browser.tsx` line 59**
   ```ts
   // Before: inline ternary selecting which traits component to render
   provider === "codex" ? <CodexTraitsMenuContent .../> : <ClaudeTraitsMenuContent .../>

   // After: delegate to the existing registry (already Record<ProviderKind, ...>)
   renderProviderTraitsMenuContent({ provider, threadId, model, ... })
   ```

3. **`apps/web/src/components/chat/CompactComposerControlsMenu.browser.tsx` line 36**
   ```ts
   // Before
   const providerModelOptions = provider === "codex"
     ? props.modelOptions.codex : props.modelOptions.claudeAgent;
   // After (eliminated by Item 1 -- options arrive pre-extracted)
   ```

4. **`apps/web/src/composerDraftStore.ts` lines 403, 415, 490**
   Legacy migration code. Low priority since it runs once on old data. Convert to
   switch + assertNever for safety, or leave with a `// LEGACY` comment if migration
   removal is planned.

5. **`apps/web/src/components/chat/ProviderHealthBanner.tsx` lines 16-20**
   ```ts
   // Before
   const providerLabel = status.provider === "codex" ? "Codex"
     : status.provider === "claudeAgent" ? "Claude" : status.provider;
   // After
   const providerLabel = PROVIDER_DISPLAY_NAMES[status.provider] ?? status.provider;
   ```

6. **`apps/web/src/store.ts` `toLegacyProvider()`**
   ```ts
   // Before: coerces untyped string|null to ProviderKind with "codex" default
   // After: if providerName comes from a typed source, remove the function.
   // If it comes from an untyped runtime source (e.g. session event), keep it
   // but add a warning log for unknown values.
   ```

7. **`packages/shared/src/model.ts` `getReasoningEffortOptions()`**
   ```ts
   // Before: if (provider === "claudeAgent") { ... } return REASONING_EFFORT_OPTIONS_BY_PROVIDER[provider];
   // After: eliminated by Item 2 (data-driven capability lookup)
   ```

8. **`apps/web/src/components/ChatView.tsx` line 199**
   ```ts
   // Before
   if (params.provider === "claudeAgent" && params.effort === "ultrathink") { ... }
   // After (with Item 2 in place):
   const caps = getModelCapabilities(params.provider, params.model);
   if (caps.reasoningEffortLevels.includes("ultrathink") && params.effort === "ultrathink") { ... }
   ```

### Phase 3D: Adapter guards are correct as-is

The patterns in `ClaudeAdapter.ts` and `CodexAdapter.ts` like
`input.modelSelection?.provider === "claudeAgent"` are **not** provider dispatches.
They are adapter-internal guards: "only process my own provider's data." These are
correct and do not need exhaustiveness -- an adapter should only care about its own
provider. No changes needed.

---

## Execution order

```
Item 2 (data-driven capabilities)     -- purely additive, no breaking changes
  |
  v
Item 1 (consolidate dual options)     -- biggest refactor, touches draft store heavily
  |
  v
Item 3 (exhaustiveness enforcement)   -- small cleanup pass, most sites already fixed by 1 & 2
```

**Item 2 first**: phases 2A-2D are purely additive -- every `supportsXxx` function
becomes a data lookup with identical signatures. Tests pass with zero call-site changes.
Phase 2E (unified trait picker) builds on the capabilities data to collapse
`ClaudeTraitsPicker` and `CodexTraitsPicker` into a single capabilities-driven component.
Phases 2A-2D and 2E can be separate PRs or one combined PR.

**Item 1 second**: the largest change, touching the draft store, persistence, and
localStorage migration. Doing Item 2 first means the capability logic is already clean,
reducing cognitive load during this refactor. Warrants its own PR with careful testing
of the v2 -> v3 storage migration.

**Item 3 last**: after Items 1 and 2, most unsafe ternaries are already eliminated. What
remains is adding `assertNever`, `PROVIDER_DISPLAY_NAMES`, and converting a handful of
surviving dispatch sites. Can be batched with Item 2 into a single PR since both are
small and contained.

---

## Files affected (summary)

### Item 1
- `packages/contracts/src/model.ts` -- remove `ProviderModelOptions`
- `apps/web/src/composerDraftStore.ts` -- major refactor
- `apps/web/src/composerDraftStore.test.ts` -- update tests
- `apps/web/src/components/ChatView.tsx` -- plumbing changes
- `apps/web/src/components/chat/composerProviderRegistry.tsx` -- input type change
- `apps/web/src/components/chat/CompactComposerControlsMenu.browser.tsx` -- simplified
- `apps/web/src/hooks/useHandleNewThread.ts` -- reads sticky state differently

### Item 2
- `packages/contracts/src/model.ts` -- add capabilities to model definitions, add `EFFORT_DISPLAY_LABELS`
- `packages/shared/src/model.ts` -- rewrite ~10 functions to data lookups, add `normalizeModelOptions`
- `packages/shared/src/model.test.ts` -- same tests, same assertions
- `apps/web/src/components/chat/TraitsPicker.tsx` -- new unified component
- `apps/web/src/components/chat/ClaudeTraitsPicker.tsx` -- deleted
- `apps/web/src/components/chat/CodexTraitsPicker.tsx` -- deleted
- `apps/web/src/components/chat/ClaudeTraitsPicker.browser.tsx` -- merged into `TraitsPicker.browser.tsx`
- `apps/web/src/components/chat/CodexTraitsPicker.browser.tsx` -- merged into `TraitsPicker.browser.tsx`
- `apps/web/src/components/chat/composerProviderRegistry.tsx` -- both entries use unified component
- `apps/web/src/components/chat/CompactComposerControlsMenu.browser.tsx` -- import from unified

### Item 3
- `packages/shared/src/assertNever.ts` -- new utility
- `packages/contracts/src/model.ts` -- add `PROVIDER_DISPLAY_NAMES`
- `apps/web/src/components/chat/CompactComposerControlsMenu.browser.tsx` -- use registry
- `apps/web/src/components/chat/ProviderHealthBanner.tsx` -- use display names
- `apps/web/src/components/ChatView.tsx` -- use capability check
- `apps/web/src/store.ts` -- tighten `toLegacyProvider`
