import type { EnvironmentId } from "@t3tools/contracts";

import type { EnvironmentProject } from "./models.ts";
import { derivePhysicalProjectKey, projectFreshnessTime } from "./projectGrouping.ts";

/**
 * A project icon is a property of the repository, not of the machine that
 * happens to render a row. Every project that shares a repository identity is
 * mapped to one favicon source so all clients ask the same environment for
 * the same file, and a session-scoped memory keeps the last icon that loaded
 * so a dropped connection never blanks rows back to the folder glyph.
 */

export interface ProjectFaviconSource {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly faviconPath: string | null;
  /** Stable identity icons are remembered under: the repo key when known. */
  readonly iconKey: string;
}

function isBetterFaviconSource(
  candidate: EnvironmentProject,
  current: EnvironmentProject,
  primaryEnvironmentId: EnvironmentId | null,
): boolean {
  if (primaryEnvironmentId !== null) {
    const candidatePrimary = candidate.environmentId === primaryEnvironmentId;
    const currentPrimary = current.environmentId === primaryEnvironmentId;
    if (candidatePrimary !== currentPrimary) {
      return candidatePrimary;
    }
  }
  const freshnessDelta = projectFreshnessTime(candidate) - projectFreshnessTime(current);
  if (freshnessDelta !== 0) {
    return freshnessDelta > 0;
  }
  if (candidate.environmentId !== current.environmentId) {
    return candidate.environmentId < current.environmentId;
  }
  return candidate.workspaceRoot < current.workspaceRoot;
}

/**
 * Picks one favicon source project per repository group and maps every
 * member's physical project key to it. The primary environment wins when it
 * is a member, then the freshest project, with a stable tiebreak so the
 * choice does not flap between renders. Projects without a repository
 * identity stay their own source.
 */
export function selectProjectFaviconSources(
  projects: ReadonlyArray<EnvironmentProject>,
  primaryEnvironmentId: EnvironmentId | null,
): ReadonlyMap<string, ProjectFaviconSource> {
  const sourceByRepositoryKey = new Map<string, EnvironmentProject>();
  for (const project of projects) {
    const repositoryKey = project.repositoryIdentity?.canonicalKey;
    if (!repositoryKey) {
      continue;
    }
    const current = sourceByRepositoryKey.get(repositoryKey);
    if (current === undefined || isBetterFaviconSource(project, current, primaryEnvironmentId)) {
      sourceByRepositoryKey.set(repositoryKey, project);
    }
  }

  const sources = new Map<string, ProjectFaviconSource>();
  for (const project of projects) {
    const physicalKey = derivePhysicalProjectKey(project);
    if (sources.has(physicalKey)) {
      continue;
    }
    const repositoryKey = project.repositoryIdentity?.canonicalKey;
    const source = repositoryKey ? (sourceByRepositoryKey.get(repositoryKey) ?? project) : project;
    sources.set(physicalKey, {
      environmentId: source.environmentId,
      cwd: source.workspaceRoot,
      faviconPath: source.faviconPath ?? null,
      iconKey: repositoryKey ?? physicalKey,
    });
  }
  return sources;
}

export interface RememberedProjectFavicon {
  readonly url: string;
  readonly cacheKey: string;
}

const MAX_REMEMBERED_FAVICONS = 256;
const rememberedFavicons = new Map<string, RememberedProjectFavicon>();
const memoryListeners = new Set<() => void>();
let memoryVersion = 0;

function notifyMemoryListeners() {
  memoryVersion += 1;
  for (const listener of memoryListeners) {
    listener();
  }
}

export function rememberProjectFavicon(iconKey: string, entry: RememberedProjectFavicon): void {
  const current = rememberedFavicons.get(iconKey);
  if (current !== undefined && current.url === entry.url && current.cacheKey === entry.cacheKey) {
    return;
  }
  rememberedFavicons.delete(iconKey);
  rememberedFavicons.set(iconKey, entry);
  if (rememberedFavicons.size > MAX_REMEMBERED_FAVICONS) {
    rememberedFavicons.delete(rememberedFavicons.keys().next().value!);
  }
  notifyMemoryListeners();
}

/** Drops a remembered icon, but only while it still points at the failed URL. */
export function forgetProjectFavicon(iconKey: string, url: string): void {
  if (rememberedFavicons.get(iconKey)?.url !== url) {
    return;
  }
  rememberedFavicons.delete(iconKey);
  notifyMemoryListeners();
}

export function getRememberedProjectFavicon(iconKey: string): RememberedProjectFavicon | null {
  return rememberedFavicons.get(iconKey) ?? null;
}

/** Subscription pair for useSyncExternalStore in the web and mobile clients. */
export function subscribeProjectFaviconMemory(listener: () => void): () => void {
  memoryListeners.add(listener);
  return () => {
    memoryListeners.delete(listener);
  };
}

export function projectFaviconMemoryVersion(): number {
  return memoryVersion;
}

export interface ProjectFaviconRenderPlan {
  readonly url: string;
  readonly cacheKey: string;
  /** Write the icon to memory once it loads (only live URLs qualify). */
  readonly remember: boolean;
}

/**
 * Render precedence: the group source's live icon, then the remembered icon
 * (survives disconnects), then the row's own environment as a last resort,
 * then the fallback glyph.
 */
export function planProjectFaviconRender(input: {
  readonly sourceLive: { readonly url: string; readonly cacheKey: string } | null;
  readonly ownLive: { readonly url: string; readonly cacheKey: string } | null;
  readonly remembered: RememberedProjectFavicon | null;
}): ProjectFaviconRenderPlan | null {
  if (input.sourceLive !== null) {
    return { ...input.sourceLive, remember: true };
  }
  if (input.remembered !== null) {
    return { url: input.remembered.url, cacheKey: input.remembered.cacheKey, remember: false };
  }
  if (input.ownLive !== null) {
    return { ...input.ownLive, remember: true };
  }
  return null;
}
