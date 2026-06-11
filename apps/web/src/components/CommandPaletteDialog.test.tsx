/** @vitest-environment happy-dom */

import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CommandPaletteDialogRoot, CommandPaletteDialogTrigger } from "./CommandPaletteDialog";
import { CommandDialogPopup } from "./ui/command";

interface DialogStateOwnerProps {
  readonly children: ReactNode;
}

function DialogStateOwner(props: DialogStateOwnerProps) {
  const [open, setOpen] = useState(false);

  return (
    <>
      {props.children}
      <CommandPaletteDialogRoot open={open} onOpenChange={setOpen}>
        {open ? (
          <CommandDialogPopup data-testid="command-palette-dialog">
            <button type="button">Dialog action</button>
          </CommandDialogPopup>
        ) : null}
      </CommandPaletteDialogRoot>
    </>
  );
}

function AppShell(props: { readonly onRender: () => void }) {
  props.onRender();

  return (
    <CommandPaletteDialogTrigger
      render={<button type="button" data-testid="command-palette-trigger" />}
    >
      Search
    </CommandPaletteDialogTrigger>
  );
}

let root: Root | null = null;

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("CommandPaletteDialog", () => {
  it("isolates dialog state while restoring focus to its detached trigger", async () => {
    const shellRender = vi.fn();
    const container = document.createElement("div");
    const previouslyFocusedInput = document.createElement("input");
    document.body.append(previouslyFocusedInput, container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <DialogStateOwner>
          <AppShell onRender={shellRender} />
        </DialogStateOwner>,
      );
    });

    const trigger = document.querySelector<HTMLButtonElement>(
      '[data-testid="command-palette-trigger"]',
    );
    expect(trigger).not.toBeNull();
    previouslyFocusedInput.focus();

    await act(async () => trigger?.click());

    expect(document.querySelector('[data-testid="command-palette-dialog"]')).not.toBeNull();
    expect(shellRender).toHaveBeenCalledTimes(1);

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" }));
    });

    await vi.waitFor(() => {
      expect(document.querySelector('[data-testid="command-palette-dialog"]')).toBeNull();
      expect(document.activeElement).toBe(trigger);
    });
    expect(shellRender).toHaveBeenCalledTimes(1);
  });
});
