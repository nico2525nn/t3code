import { scopedProjectKey, scopeProjectRef } from "@t3tools/client-runtime";
import type { ScopedProjectRef, SidebarProjectGroupingMode } from "@t3tools/contracts";
import { normalizeProjectPathForComparison } from "./lib/projectPaths";
import type { Project } from "./types";

export interface ProjectGroupingSettings {
  sidebarProjectGroupingMode: SidebarProjectGroupingMode;
  sidebarProjectGroupingOverrides: Record<string, SidebarProjectGroupingMode>;
}

export type ProjectGroupingMode = SidebarProjectGroupingMode;

function uniqueNonEmptyValues(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const value of values) {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function deriveRepositoryRelativeProjectPath(
  project: Pick<Project, "cwd" | "repositoryIdentity">,
): string | null {
  const rootPath = project.repositoryIdentity?.rootPath?.trim();
  if (!rootPath) {
    return null;
  }

  const normalizedProjectPath = normalizeProjectPathForComparison(project.cwd);
  const normalizedRootPath = normalizeProjectPathForComparison(rootPath);
  if (normalizedProjectPath.length === 0 || normalizedRootPath.length === 0) {
    return null;
  }

  if (normalizedProjectPath === normalizedRootPath) {
    return "";
  }

  const separator = normalizedRootPath.includes("\\") ? "\\" : "/";
  const rootPrefix = `${normalizedRootPath}${separator}`;
  if (!normalizedProjectPath.startsWith(rootPrefix)) {
    return null;
  }

  return normalizedProjectPath.slice(rootPrefix.length).replaceAll("\\", "/");
}

function formatProjectGroupDiscriminator(value: string): string {
  return value.length === 0 ? "." : value;
}

function hasDuplicateEnvironment(projects: ReadonlyArray<Pick<Project, "environmentId">>): boolean {
  const seen = new Set<string>();
  for (const project of projects) {
    if (seen.has(project.environmentId)) {
      return true;
    }
    seen.add(project.environmentId);
  }
  return false;
}

export function derivePhysicalProjectKeyFromPath(environmentId: string, cwd: string): string {
  return `${environmentId}:${normalizeProjectPathForComparison(cwd)}`;
}

export function derivePhysicalProjectKey(project: Pick<Project, "environmentId" | "cwd">): string {
  return derivePhysicalProjectKeyFromPath(project.environmentId, project.cwd);
}

export function deriveProjectGroupingOverrideKey(
  project: Pick<Project, "environmentId" | "cwd">,
): string {
  return derivePhysicalProjectKey(project);
}

// Key under which a project's manual sort order (projectOrder) is stored.
// Must stay aligned with the writer side in `uiStateStore.syncProjects` and
// the drag handlers in `Sidebar` so readers and writers agree.
export function getProjectOrderKey(project: Pick<Project, "environmentId" | "cwd">): string {
  return derivePhysicalProjectKey(project);
}

export function resolveProjectGroupingMode(
  project: Pick<Project, "environmentId" | "cwd">,
  settings: ProjectGroupingSettings,
): SidebarProjectGroupingMode {
  return (
    settings.sidebarProjectGroupingOverrides?.[deriveProjectGroupingOverrideKey(project)] ??
    settings.sidebarProjectGroupingMode
  );
}

function deriveRepositoryScopedKey(
  project: Pick<Project, "cwd" | "repositoryIdentity">,
  groupingMode: SidebarProjectGroupingMode,
): string | null {
  const canonicalKey = project.repositoryIdentity?.canonicalKey;
  if (!canonicalKey) {
    return null;
  }

  if (groupingMode === "repository") {
    return canonicalKey;
  }

  const relativeProjectPath = deriveRepositoryRelativeProjectPath(project);
  if (relativeProjectPath === null) {
    return canonicalKey;
  }

  return relativeProjectPath.length === 0
    ? canonicalKey
    : `${canonicalKey}::${relativeProjectPath}`;
}

export function deriveLogicalProjectKey(
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">,
  options?: {
    groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  const groupingMode = options?.groupingMode ?? "repository";
  if (groupingMode === "separate") {
    return derivePhysicalProjectKey(project);
  }

  return (
    deriveRepositoryScopedKey(project, groupingMode) ??
    derivePhysicalProjectKey(project) ??
    scopedProjectKey(scopeProjectRef(project.environmentId, project.id))
  );
}

export function deriveLogicalProjectKeyFromSettings(
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">,
  settings: ProjectGroupingSettings,
): string {
  return deriveLogicalProjectKey(project, {
    groupingMode: resolveProjectGroupingMode(project, settings),
  });
}

export function buildLogicalProjectKeyMap(
  projects: ReadonlyArray<Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">>,
  settings: ProjectGroupingSettings,
): Map<string, string> {
  const baseBuckets = new Map<
    string,
    Array<Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">>
  >();
  const physicalKeyByProject = new Map<
    Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">,
    string
  >();

  for (const project of projects) {
    const physicalKey = derivePhysicalProjectKey(project);
    physicalKeyByProject.set(project, physicalKey);
    const baseKey = deriveLogicalProjectKeyFromSettings(project, settings);
    const bucket = baseBuckets.get(baseKey);
    if (bucket) {
      bucket.push(project);
    } else {
      baseBuckets.set(baseKey, [project]);
    }
  }

  const result = new Map<string, string>();
  const assignBucket = (
    baseKey: string,
    bucket: ReadonlyArray<Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">>,
    discriminatorIndex: number,
  ) => {
    if (!hasDuplicateEnvironment(bucket)) {
      for (const project of bucket) {
        result.set(physicalKeyByProject.get(project)!, baseKey);
      }
      return;
    }

    const discriminatorFns = [
      (project: Pick<Project, "cwd" | "repositoryIdentity">) => {
        const relativePath = deriveRepositoryRelativeProjectPath(project);
        return relativePath === null ? null : formatProjectGroupDiscriminator(relativePath);
      },
      (project: Pick<Project, "cwd">) => normalizeProjectPathForComparison(project.cwd),
      (project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">) =>
        physicalKeyByProject.get(project) ?? derivePhysicalProjectKey(project),
    ] as const;
    const discriminator = discriminatorFns[discriminatorIndex];
    if (!discriminator) {
      for (const project of bucket) {
        result.set(physicalKeyByProject.get(project)!, physicalKeyByProject.get(project)!);
      }
      return;
    }

    const buckets = new Map<
      string,
      Array<Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity">>
    >();
    for (const project of bucket) {
      const value = discriminator(project) ?? normalizeProjectPathForComparison(project.cwd);
      const key = `${baseKey}::${value}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.push(project);
      } else {
        buckets.set(key, [project]);
      }
    }

    for (const [key, projectsForKey] of buckets) {
      assignBucket(key, projectsForKey, discriminatorIndex + 1);
    }
  };

  for (const [baseKey, bucket] of baseBuckets) {
    assignBucket(baseKey, bucket, 0);
  }

  return result;
}

export function deriveLogicalProjectKeyFromRef(
  projectRef: ScopedProjectRef,
  project: Pick<Project, "environmentId" | "id" | "cwd" | "repositoryIdentity"> | null | undefined,
  options?: {
    groupingMode?: SidebarProjectGroupingMode;
  },
): string {
  return project ? deriveLogicalProjectKey(project, options) : scopedProjectKey(projectRef);
}

export function deriveProjectGroupLabel(input: {
  representative: Pick<Project, "name" | "repositoryIdentity">;
  members: ReadonlyArray<Pick<Project, "name" | "repositoryIdentity">>;
}): string {
  const sharedDisplayNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.displayName),
  );
  if (sharedDisplayNames.length === 1) {
    return sharedDisplayNames[0]!;
  }

  const sharedRepositoryNames = uniqueNonEmptyValues(
    input.members.map((member) => member.repositoryIdentity?.name),
  );
  if (sharedRepositoryNames.length === 1) {
    return sharedRepositoryNames[0]!;
  }

  return input.representative.name;
}
