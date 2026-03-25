import "../../index.css";

import { type ModelSelection, DEFAULT_MODEL_BY_PROVIDER, ProjectId, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { TraitsPicker } from "./TraitsPicker";
import {
  COMPOSER_DRAFT_STORAGE_KEY,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";

// ── Claude TraitsPicker tests ─────────────────────────────────────────

const CLAUDE_THREAD_ID = ThreadId.makeUnsafe("thread-claude-traits");

function ClaudeTraitsPickerHarness(props: {
  model: string;
  fallbackModelSelection: ModelSelection | null;
}) {
  const prompt = useComposerThreadDraft(CLAUDE_THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: CLAUDE_THREAD_ID,
    selectedProvider: "claudeAgent",
    threadModelSelection: props.fallbackModelSelection,
    projectModelSelection: null,
    customModelsByProvider: { codex: [], claudeAgent: [] },
  });
  const handlePromptChange = useCallback(
    (nextPrompt: string) => {
      setPrompt(CLAUDE_THREAD_ID, nextPrompt);
    },
    [setPrompt],
  );

  return (
    <TraitsPicker
      provider="claudeAgent"
      threadId={CLAUDE_THREAD_ID}
      model={selectedModel ?? props.model}
      prompt={prompt}
      modelOptions={modelOptions?.claudeAgent}
      onPromptChange={handlePromptChange}
    />
  );
}

async function mountClaudePicker(props?: {
  model?: string;
  prompt?: string;
  effort?: "low" | "medium" | "high" | "max" | "ultrathink" | null;
  thinkingEnabled?: boolean | null;
  fastModeEnabled?: boolean;
  fallbackModelOptions?: {
    effort?: "low" | "medium" | "high" | "max" | "ultrathink";
    thinking?: boolean;
    fastMode?: boolean;
  } | null;
  skipDraftModelOptions?: boolean;
}) {
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  const model = props?.model ?? "claude-opus-4-6";
  const claudeOptions = !props?.skipDraftModelOptions
    ? {
        ...(props?.effort ? { effort: props.effort } : {}),
        ...(props?.thinkingEnabled === false ? { thinking: false } : {}),
        ...(props?.fastModeEnabled ? { fastMode: true } : {}),
      }
    : undefined;
  draftsByThreadId[CLAUDE_THREAD_ID] = {
    prompt: props?.prompt ?? "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    modelSelectionByProvider: props?.skipDraftModelOptions
      ? {}
      : {
          claudeAgent: {
            provider: "claudeAgent",
            model,
            ...(claudeOptions && Object.keys(claudeOptions).length > 0
              ? { options: claudeOptions }
              : {}),
          },
        },
    activeProvider: "claudeAgent",
    runtimeMode: null,
    interactionMode: null,
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {},
  });
  const host = document.createElement("div");
  document.body.append(host);
  const fallbackModelSelection =
    props?.fallbackModelOptions !== undefined
      ? ({
          provider: "claudeAgent",
          model,
          options: props.fallbackModelOptions ?? undefined,
        } satisfies ModelSelection)
      : null;
  const screen = await render(
    <ClaudeTraitsPickerHarness model={model} fallbackModelSelection={fallbackModelSelection} />,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("TraitsPicker (Claude)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls for Opus", async () => {
    const mounted = await mountClaudePicker();

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Fast Mode");
        expect(text).toContain("off");
        expect(text).toContain("on");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("hides fast mode controls for non-Opus models", async () => {
    const mounted = await mountClaudePicker({ model: "claude-sonnet-4-6" });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").not.toContain("Fast Mode");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows only the provided effort options", async () => {
    const mounted = await mountClaudePicker({
      model: "claude-sonnet-4-6",
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Low");
        expect(text).toContain("Medium");
        expect(text).toContain("High");
        expect(text).not.toContain("Max");
        expect(text).toContain("Ultrathink");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows a thinking on/off dropdown for Haiku", async () => {
    const mounted = await mountClaudePicker({
      model: "claude-haiku-4-5",
      thinkingEnabled: true,
    });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Thinking On");
      });
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Thinking");
        expect(text).toContain("On (default)");
        expect(text).toContain("Off");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows prompt-controlled Ultrathink state with disabled effort controls", async () => {
    const mounted = await mountClaudePicker({
      effort: "high",
      model: "claude-opus-4-6",
      prompt: "Ultrathink:\nInvestigate this",
      fastModeEnabled: false,
    });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("Ultrathink");
        expect(document.body.textContent ?? "").not.toContain("Ultrathink · Prompt");
      });
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Effort");
        expect(text).toContain("Remove Ultrathink from the prompt to change effort.");
        expect(text).not.toContain("Fallback Effort");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("persists sticky claude model options when traits change", async () => {
    const mounted = await mountClaudePicker({
      model: "claude-opus-4-6",
      effort: "medium",
      fastModeEnabled: false,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Max" }).click();

      expect(
        useComposerDraftStore.getState().stickyModelSelectionByProvider.claudeAgent,
      ).toMatchObject({
        provider: "claudeAgent",
        options: {
          effort: "max",
        },
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("can turn inherited fast mode off without snapping back", async () => {
    const mounted = await mountClaudePicker({
      model: "claude-opus-4-6",
      skipDraftModelOptions: true,
      fallbackModelOptions: {
        effort: "high",
        fastMode: true,
      },
    });

    try {
      const trigger = page.getByRole("button");

      await expect.element(trigger).toHaveTextContent("High · Fast");
      await trigger.click();
      await page.getByRole("menuitemradio", { name: "off" }).click();

      await vi.waitFor(() => {
        expect(
          useComposerDraftStore.getState().draftsByThreadId[CLAUDE_THREAD_ID]
            ?.modelSelectionByProvider.claudeAgent?.options,
        ).toEqual({
          effort: "high",
          fastMode: false,
        });
      });
      await expect.element(trigger).toHaveTextContent("High");
      await expect.element(trigger).not.toHaveTextContent("High · Fast");
    } finally {
      await mounted.cleanup();
    }
  });
});

// ── Codex TraitsPicker tests ──────────────────────────────────────────

async function mountCodexPicker(props: {
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  fastModeEnabled: boolean;
}) {
  const threadId = ThreadId.makeUnsafe("thread-codex-traits");
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  const codexOptions = {
    ...(props.reasoningEffort ? { reasoningEffort: props.reasoningEffort } : {}),
    ...(props.fastModeEnabled ? { fastMode: true } : {}),
  };
  draftsByThreadId[threadId] = {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    modelSelectionByProvider: {
      codex: {
        provider: "codex",
        model: DEFAULT_MODEL_BY_PROVIDER["codex"],
        ...(Object.keys(codexOptions).length > 0 ? { options: codexOptions } : {}),
      },
    },
    activeProvider: "codex",
    runtimeMode: null,
    interactionMode: null,
  };
  useComposerDraftStore.setState({
    draftsByThreadId,
    draftThreadsByThreadId: {},
    projectDraftThreadIdByProjectId: {
      [ProjectId.makeUnsafe("project-codex-traits")]: threadId,
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const screen = await render(
    <TraitsPicker
      provider="codex"
      threadId={threadId}
      model={DEFAULT_MODEL_BY_PROVIDER["codex"]}
      prompt=""
      modelOptions={{
        ...(props.reasoningEffort ? { reasoningEffort: props.reasoningEffort } : {}),
        ...(props.fastModeEnabled ? { fastMode: true } : {}),
      }}
      onPromptChange={() => {}}
    />,
    { container: host },
  );

  return {
    cleanup: async () => {
      await screen.unmount();
      host.remove();
    },
  };
}

describe("TraitsPicker (Codex)", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelectionByProvider: {},
    });
  });

  it("shows fast mode controls", async () => {
    const mounted = await mountCodexPicker({
      fastModeEnabled: false,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Fast Mode");
        expect(text).toContain("off");
        expect(text).toContain("on");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows Fast in the trigger label when fast mode is active", async () => {
    const mounted = await mountCodexPicker({
      fastModeEnabled: true,
    });

    try {
      await vi.waitFor(() => {
        expect(document.body.textContent ?? "").toContain("High · Fast");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("shows only the provided effort options", async () => {
    const mounted = await mountCodexPicker({
      fastModeEnabled: false,
    });

    try {
      await page.getByRole("button").click();

      await vi.waitFor(() => {
        const text = document.body.textContent ?? "";
        expect(text).toContain("Low");
        expect(text).toContain("Medium");
        expect(text).toContain("High");
        expect(text).toContain("Extra High");
      });
    } finally {
      await mounted.cleanup();
    }
  });

  it("persists sticky codex model options when traits change", async () => {
    const mounted = await mountCodexPicker({
      fastModeEnabled: false,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "on" }).click();

      expect(
        useComposerDraftStore.getState().stickyModelSelectionByProvider.codex,
      ).toMatchObject({
        provider: "codex",
        options: {
          fastMode: true,
        },
      });
    } finally {
      await mounted.cleanup();
    }
  });
});
