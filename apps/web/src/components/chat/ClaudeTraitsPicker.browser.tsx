import "../../index.css";

import { type ModelSelection, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { useCallback } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ClaudeTraitsPicker } from "./ClaudeTraitsPicker";
import {
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";

const THREAD_ID = ThreadId.makeUnsafe("thread-claude-traits");

function ClaudeTraitsPickerHarness(props: {
  model: string;
  fallbackModelSelection: ModelSelection | null;
}) {
  const prompt = useComposerThreadDraft(THREAD_ID).prompt;
  const setPrompt = useComposerDraftStore((store) => store.setPrompt);
  const { modelOptions, selectedModel } = useEffectiveComposerModelState({
    threadId: THREAD_ID,
    selectedProvider: "claudeAgent",
    threadModelSelection: props.fallbackModelSelection,
    projectModelSelection: null,
    customModelsByProvider: { codex: [], claudeAgent: [] },
  });
  const handlePromptChange = useCallback(
    (nextPrompt: string) => {
      setPrompt(THREAD_ID, nextPrompt);
    },
    [setPrompt],
  );

  return (
    <ClaudeTraitsPicker
      threadId={THREAD_ID}
      model={selectedModel ?? props.model}
      prompt={prompt}
      modelOptions={modelOptions?.claudeAgent}
      onPromptChange={handlePromptChange}
    />
  );
}

async function mountPicker(props?: {
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
  draftsByThreadId[THREAD_ID] = {
    prompt: props?.prompt ?? "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    modelSelection: {
      provider: "claudeAgent",
      model,
      ...(!props?.skipDraftModelOptions
        ? {
            options: {
              ...(props?.effort ? { effort: props.effort } : {}),
              ...(props?.thinkingEnabled === false ? { thinking: false } : {}),
              ...(props?.fastModeEnabled ? { fastMode: true } : {}),
            },
          }
        : {}),
    },
    modelOptions: props?.skipDraftModelOptions
      ? null
      : {
          claudeAgent: {
            ...(props?.effort ? { effort: props.effort } : {}),
            ...(props?.thinkingEnabled === false ? { thinking: false } : {}),
            ...(props?.fastModeEnabled ? { fastMode: true } : {}),
          },
        },
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

describe("ClaudeTraitsPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelSelection: null,
      stickyModelOptions: {},
    });
  });

  it("shows fast mode controls for Opus", async () => {
    const mounted = await mountPicker();

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
    const mounted = await mountPicker({ model: "claude-sonnet-4-6" });

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
    const mounted = await mountPicker({
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
    const mounted = await mountPicker({
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
    const mounted = await mountPicker({
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
    const mounted = await mountPicker({
      model: "claude-opus-4-6",
      effort: "medium",
      fastModeEnabled: false,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "Max" }).click();

      expect(useComposerDraftStore.getState().stickyModelSelection).toMatchObject({
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
    const mounted = await mountPicker({
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
        expect(useComposerDraftStore.getState().draftsByThreadId[THREAD_ID]?.modelOptions).toEqual({
          claudeAgent: {
            effort: "high",
            fastMode: false,
          },
        });
      });
      await expect.element(trigger).toHaveTextContent("High");
      await expect.element(trigger).not.toHaveTextContent("High · Fast");
    } finally {
      await mounted.cleanup();
    }
  });
});
