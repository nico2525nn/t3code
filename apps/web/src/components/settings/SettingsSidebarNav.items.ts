import {
  ArchiveIcon,
  BotIcon,
  GitBranchIcon,
  KeyboardIcon,
  Link2Icon,
  Settings2Icon,
} from "lucide-react";
import type { ComponentType } from "react";

export type SettingsSectionPath =
  | "/settings/general"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/archived";

export interface SettingsNavItem {
  readonly icon: ComponentType<{ className?: string }>;
  readonly label: string;
  readonly to: SettingsSectionPath;
}

export const SETTINGS_NAV_ITEMS: ReadonlyArray<SettingsNavItem> = [
  { label: "General", to: "/settings/general", icon: Settings2Icon },
  { label: "Keybindings", to: "/settings/keybindings", icon: KeyboardIcon },
  { label: "Providers", to: "/settings/providers", icon: BotIcon },
  { label: "Source Control", to: "/settings/source-control", icon: GitBranchIcon },
  { label: "Connections", to: "/settings/connections", icon: Link2Icon },
  { label: "Archive", to: "/settings/archived", icon: ArchiveIcon },
];
