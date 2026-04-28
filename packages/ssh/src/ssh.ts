import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type {
  DesktopDiscoveredSshHost,
  DesktopSshEnvironmentTarget,
  DesktopUpdateChannel,
} from "@t3tools/contracts";

import { Data, Effect } from "effect";

export const DEFAULT_REMOTE_PORT = 3773;

const NO_HOSTS = [] as const;
const PUBLISHABLE_T3_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;

export class SshHostDiscoveryError extends Data.TaggedError("SshHostDiscoveryError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

function stripInlineComment(line: string): string {
  const hashIndex = line.indexOf("#");
  return (hashIndex >= 0 ? line.slice(0, hashIndex) : line).trim();
}

function splitDirectiveArgs(value: string): ReadonlyArray<string> {
  return value
    .trim()
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function expandHomePath(input: string, homeDir: string = OS.homedir()): string {
  return input.replace(/^~(?=$|\/|\\)/u, homeDir);
}

export function resolveSshConfigIncludePattern(
  includePattern: string,
  _directory: string,
  homeDir: string = OS.homedir(),
): string {
  const expandedPattern = expandHomePath(includePattern, homeDir);
  return Path.isAbsolute(expandedPattern)
    ? expandedPattern
    : Path.resolve(Path.join(homeDir, ".ssh"), expandedPattern);
}

function hasSshPattern(value: string): boolean {
  return value.includes("*") || value.includes("?") || value.startsWith("!");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function globToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${escapeRegex(pattern).replace(/\\\*/gu, ".*").replace(/\\\?/gu, ".")}$`,
    "u",
  );
}

function expandGlob(pattern: string): ReadonlyArray<string> {
  if (!pattern.includes("*") && !pattern.includes("?")) {
    return FS.existsSync(pattern) ? [pattern] : NO_HOSTS;
  }

  const directory = Path.dirname(pattern);
  const basePattern = Path.basename(pattern);
  if (!FS.existsSync(directory)) {
    return NO_HOSTS;
  }

  const matcher = globToRegExp(basePattern);
  return FS.readdirSync(directory)
    .filter((entry) => matcher.test(entry))
    .map((entry) => Path.join(directory, entry))
    .filter((entry) => FS.existsSync(entry))
    .toSorted((left, right) => left.localeCompare(right));
}

export function collectSshConfigAliasesFromFile(
  filePath: string,
  visited = new Set<string>(),
  homeDir: string = OS.homedir(),
): ReadonlyArray<string> {
  const resolvedPath = Path.resolve(filePath);
  if (visited.has(resolvedPath) || !FS.existsSync(resolvedPath)) {
    return NO_HOSTS;
  }
  visited.add(resolvedPath);

  const aliases = new Set<string>();
  const directory = Path.dirname(resolvedPath);
  const raw = FS.readFileSync(resolvedPath, "utf8");

  for (const line of raw.split(/\r?\n/u)) {
    const stripped = stripInlineComment(line);
    if (stripped.length === 0) {
      continue;
    }

    const [directive = "", ...rawArgs] = splitDirectiveArgs(stripped);
    const normalizedDirective = directive.toLowerCase();
    if (normalizedDirective === "include") {
      for (const includePattern of rawArgs) {
        const resolvedPattern = resolveSshConfigIncludePattern(includePattern, directory, homeDir);
        for (const includedPath of expandGlob(resolvedPattern)) {
          for (const alias of collectSshConfigAliasesFromFile(includedPath, visited, homeDir)) {
            aliases.add(alias);
          }
        }
      }
      continue;
    }

    if (normalizedDirective !== "host") {
      continue;
    }

    for (const alias of rawArgs) {
      if (alias.length === 0 || hasSshPattern(alias)) {
        continue;
      }
      aliases.add(alias);
    }
  }

  return [...aliases].toSorted((left, right) => left.localeCompare(right));
}

function normalizeKnownHostsHostname(rawHost: string): string {
  const bracketMatch = /^\[([^\]]+)\]:(\d+)$/u.exec(rawHost);
  if (bracketMatch?.[1]) {
    return bracketMatch[1];
  }

  if (!rawHost.includes(":")) {
    return rawHost;
  }

  const firstColonIndex = rawHost.indexOf(":");
  const lastColonIndex = rawHost.lastIndexOf(":");
  return firstColonIndex === lastColonIndex ? rawHost.slice(0, lastColonIndex) : rawHost;
}

export function parseKnownHostsHostnames(raw: string): ReadonlyArray<string> {
  const hostnames = new Set<string>();

  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const withoutMarker = trimmed.startsWith("@")
      ? trimmed.split(/\s+/u).slice(1).join(" ")
      : trimmed;
    const [hostField = ""] = withoutMarker.split(/\s+/u);
    if (hostField.length === 0 || hostField.startsWith("|")) {
      continue;
    }

    for (const rawHost of hostField.split(",")) {
      const host = normalizeKnownHostsHostname(rawHost).trim();
      if (host.length === 0 || hasSshPattern(host)) {
        continue;
      }
      hostnames.add(host);
    }
  }

  return [...hostnames].toSorted((left, right) => left.localeCompare(right));
}

function readKnownHostsHostnames(filePath: string): ReadonlyArray<string> {
  if (!FS.existsSync(filePath)) {
    return NO_HOSTS;
  }

  return parseKnownHostsHostnames(FS.readFileSync(filePath, "utf8"));
}

export function parseSshResolveOutput(alias: string, stdout: string): DesktopSshEnvironmentTarget {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const [key, ...rest] = trimmed.split(/\s+/u);
    if (!key || rest.length === 0 || values.has(key)) {
      continue;
    }
    values.set(key, rest.join(" ").trim());
  }

  const hostname = values.get("hostname")?.trim() || alias;
  const username = values.get("user")?.trim() || null;
  const rawPort = values.get("port")?.trim() ?? "";
  const parsedPort = Number.parseInt(rawPort, 10);

  return {
    alias,
    hostname,
    username,
    port: Number.isInteger(parsedPort) ? parsedPort : null,
  };
}

export function targetConnectionKey(target: DesktopSshEnvironmentTarget): string {
  return `${target.alias}\u0000${target.hostname}\u0000${target.username ?? ""}\u0000${target.port ?? ""}`;
}

export function remoteStateKey(target: DesktopSshEnvironmentTarget): string {
  return Crypto.createHash("sha256").update(targetConnectionKey(target)).digest("hex").slice(0, 16);
}

export function buildSshHostSpec(target: DesktopSshEnvironmentTarget): string {
  const destination = target.alias.trim() || target.hostname.trim();
  if (destination.length === 0) {
    throw new Error("SSH target is missing its alias/hostname.");
  }
  return target.username ? `${target.username}@${destination}` : destination;
}

export function baseSshArgs(
  target: DesktopSshEnvironmentTarget,
  input?: { readonly batchMode?: "yes" | "no" },
): string[] {
  return [
    "-o",
    `BatchMode=${input?.batchMode ?? "no"}`,
    "-o",
    "ConnectTimeout=10",
    ...(target.port !== null ? ["-p", String(target.port)] : []),
  ];
}

export function normalizeSshErrorMessage(stderr: string, fallbackMessage: string): string {
  const cleaned = stderr.trim();
  return cleaned.length > 0 ? cleaned : fallbackMessage;
}

export function isSshAuthFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  return (
    /permission denied \((?:publickey|password|keyboard-interactive|hostbased|gssapi-with-mic)[^)]*\)/u.test(
      normalized,
    ) ||
    /authentication failed/u.test(normalized) ||
    /too many authentication failures/u.test(normalized)
  );
}

export function getLastNonEmptyOutputLine(stdout: string): string | null {
  return (
    stdout
      .trim()
      .split(/\r?\n/u)
      .map((entry) => entry.trim())
      .findLast((entry) => entry.length > 0) ?? null
  );
}

export function resolveRemoteT3CliPackageSpec(input: {
  readonly appVersion: string;
  readonly updateChannel: DesktopUpdateChannel;
  readonly isDevelopment?: boolean;
}): string {
  const appVersion = input.appVersion.trim();
  if (!input.isDevelopment && PUBLISHABLE_T3_VERSION_PATTERN.test(appVersion)) {
    return `t3@${appVersion}`;
  }

  if (input.isDevelopment) {
    return "t3@nightly";
  }

  return input.updateChannel === "nightly" ? "t3@nightly" : "t3@latest";
}

export const discoverSshHosts = (input?: {
  readonly homeDir?: string;
}): Effect.Effect<readonly DesktopDiscoveredSshHost[], SshHostDiscoveryError> =>
  Effect.try({
    try: () => {
      const homeDir = input?.homeDir ?? OS.homedir();
      const sshDirectory = Path.join(homeDir, ".ssh");
      const configAliases = collectSshConfigAliasesFromFile(
        Path.join(sshDirectory, "config"),
        new Set<string>(),
        homeDir,
      );
      const knownHosts = readKnownHostsHostnames(Path.join(sshDirectory, "known_hosts"));
      const discovered = new Map<string, DesktopDiscoveredSshHost>();

      for (const alias of configAliases) {
        discovered.set(alias, {
          alias,
          hostname: alias,
          username: null,
          port: null,
          source: "ssh-config",
        });
      }

      for (const hostname of knownHosts) {
        if (discovered.has(hostname)) {
          continue;
        }
        discovered.set(hostname, {
          alias: hostname,
          hostname,
          username: null,
          port: null,
          source: "known-hosts",
        });
      }

      return [...discovered.values()].toSorted((left, right) =>
        left.alias.localeCompare(right.alias),
      );
    },
    catch: (cause) =>
      new SshHostDiscoveryError({
        message: "Failed to discover SSH hosts.",
        cause,
      }),
  });
