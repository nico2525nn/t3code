import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import type { DesktopDiscoveredSshHost } from "@t3tools/contracts";

import { Effect } from "effect";

import { SshHostDiscoveryError } from "./errors.ts";

const NO_HOSTS = [] as const;

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
