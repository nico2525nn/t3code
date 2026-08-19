import type { PluginCommand } from "@t3tools/contracts";

import type { ComposerCommandItem } from "./ComposerCommandPopover";

export function buildMobilePluginCommandItems(
  commands: ReadonlyArray<PluginCommand>,
  query: string,
): ComposerCommandItem[] {
  const normalizedQuery = query.toLowerCase();
  return commands
    .filter(
      (command) =>
        command.surfaces.includes("mobile") &&
        `${command.label} ${command.description ?? ""} ${command.id}`
          .toLowerCase()
          .includes(normalizedQuery),
    )
    .map((command) => ({
      id: `plugin-command:${command.id}`,
      type: "plugin-command" as const,
      command,
      label: command.label,
      description: command.description ?? "Plugin command",
    }));
}
