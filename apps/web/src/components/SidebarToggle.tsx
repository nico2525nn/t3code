import { useAtomValue } from "@effect/atom-react";
import type { ComponentProps } from "react";

import { shortcutLabelForCommand } from "../keybindings";
import { primaryServerKeybindingsAtom } from "../state/server";
import { SidebarTrigger } from "./ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function MainSidebarToggle(props: ComponentProps<typeof SidebarTrigger>) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle");

  return (
    <Tooltip>
      <TooltipTrigger render={<SidebarTrigger aria-label="Toggle main sidebar" {...props} />} />
      <TooltipPopup side="bottom">
        Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}
