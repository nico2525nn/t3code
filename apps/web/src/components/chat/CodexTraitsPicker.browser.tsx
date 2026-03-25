import "../../index.css";

import { DEFAULT_MODEL_BY_PROVIDER, ProjectId, ThreadId } from "@t3tools/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { CodexTraitsPicker } from "./CodexTraitsPicker";
import { COMPOSER_DRAFT_STORAGE_KEY, useComposerDraftStore } from "../../composerDraftStore";

async function mountPicker(props: {
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  fastModeEnabled: boolean;
}) {
  const threadId = ThreadId.makeUnsafe("thread-codex-traits");
  const draftsByThreadId = {} as ReturnType<
    typeof useComposerDraftStore.getState
  >["draftsByThreadId"];
  draftsByThreadId[threadId] = {
    prompt: "",
    images: [],
    nonPersistedImageIds: [],
    persistedAttachments: [],
    terminalContexts: [],
    modelSelection: {
      provider: "codex",
      model: DEFAULT_MODEL_BY_PROVIDER["codex"],
      options: {
        ...(props.reasoningEffort ? { reasoningEffort: props.reasoningEffort } : {}),
        ...(props.fastModeEnabled ? { fastMode: true } : {}),
      },
    },
    modelOptions: {
      codex: {
        ...(props.reasoningEffort ? { reasoningEffort: props.reasoningEffort } : {}),
        ...(props.fastModeEnabled ? { fastMode: true } : {}),
      },
    },
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
    <CodexTraitsPicker
      threadId={threadId}
      modelOptions={{
        ...(props.reasoningEffort ? { reasoningEffort: props.reasoningEffort } : {}),
        ...(props.fastModeEnabled ? { fastMode: true } : {}),
      }}
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

describe("CodexTraitsPicker", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    localStorage.removeItem(COMPOSER_DRAFT_STORAGE_KEY);
    useComposerDraftStore.setState({
      draftsByThreadId: {},
      draftThreadsByThreadId: {},
      projectDraftThreadIdByProjectId: {},
      stickyModelOptions: {},
    });
  });

  it("shows fast mode controls", async () => {
    const mounted = await mountPicker({
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
    const mounted = await mountPicker({
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
    const mounted = await mountPicker({
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
    const mounted = await mountPicker({
      fastModeEnabled: false,
    });

    try {
      await page.getByRole("button").click();
      await page.getByRole("menuitemradio", { name: "on" }).click();

      expect(useComposerDraftStore.getState().stickyModelSelection).toMatchObject({
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
