import type { ComponentProps } from "react";

import { CommandCreateHandle, CommandDialog, CommandDialogTrigger } from "./ui/command";

const commandPaletteDialogHandle = CommandCreateHandle();

export function CommandPaletteDialogRoot(
  props: Omit<ComponentProps<typeof CommandDialog>, "handle">,
) {
  return <CommandDialog handle={commandPaletteDialogHandle} {...props} />;
}

export function CommandPaletteDialogTrigger(
  props: Omit<ComponentProps<typeof CommandDialogTrigger>, "handle">,
) {
  return <CommandDialogTrigger handle={commandPaletteDialogHandle} {...props} />;
}
