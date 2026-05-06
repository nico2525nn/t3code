import type { ServerProviderSlashCommand } from "@t3tools/contracts";

export const PI_BUILT_IN_SLASH_COMMANDS = [
  { name: "settings", description: "Open settings menu" },
  { name: "model", description: "Select model" },
  { name: "scoped-models", description: "Enable or disable scoped models" },
  { name: "export", description: "Export session" },
  { name: "import", description: "Import and resume a session" },
  { name: "share", description: "Share session" },
  { name: "copy", description: "Copy last agent message" },
  { name: "name", description: "Set session display name" },
  { name: "session", description: "Show session info and stats" },
  { name: "changelog", description: "Show changelog entries" },
  { name: "hotkeys", description: "Show keyboard shortcuts" },
  { name: "fork", description: "Create a session fork" },
  { name: "clone", description: "Duplicate current session" },
  { name: "tree", description: "Navigate session tree" },
  { name: "login", description: "Configure provider authentication" },
  { name: "logout", description: "Remove provider authentication" },
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Compact session context" },
  { name: "resume", description: "Resume a different session" },
  { name: "reload", description: "Reload extensions, skills, prompts, and themes" },
  { name: "quit", description: "Quit Pi" },
] satisfies ReadonlyArray<ServerProviderSlashCommand>;

export function parsePiSlashCommand(text: string):
  | {
      readonly name: string;
      readonly args: string;
    }
  | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return undefined;
  }

  const withoutSlash = trimmed.slice(1);
  const [rawName, ...rest] = withoutSlash.split(/\s+/);
  const name = rawName?.trim();
  if (!name) {
    return undefined;
  }

  return { name, args: rest.join(" ").trim() };
}
