import type { EnvironmentId, VcsRef, ProjectId } from "@t3tools/contracts";
import { Schema } from "effect";
export { dedupeRemoteBranchesWithLocalMatches } from "@t3tools/shared/git";

export interface EnvironmentOption {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  label: string;
  isPrimary: boolean;
}

export const EnvMode = Schema.Literals(["local", "worktree"]);
export type EnvMode = typeof EnvMode.Type;

const GENERIC_LOCAL_ENVIRONMENT_LABELS = new Set(["local", "local environment"]);

function normalizeDisplayLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

export function resolveEnvironmentOptionLabel(input: {
  isPrimary: boolean;
  environmentId: EnvironmentId;
  runtimeLabel?: string | null;
  savedLabel?: string | null;
}): string {
  const runtimeLabel = normalizeDisplayLabel(input.runtimeLabel);
  const savedLabel = normalizeDisplayLabel(input.savedLabel);

  if (input.isPrimary) {
    const preferredLocalLabel = [runtimeLabel, savedLabel].find((label) => {
      if (!label) return false;
      return !GENERIC_LOCAL_ENVIRONMENT_LABELS.has(label.toLowerCase());
    });
    return preferredLocalLabel ?? "This device";
  }

  return runtimeLabel ?? savedLabel ?? input.environmentId;
}

export function resolveEnvModeLabel(mode: EnvMode): string {
  return mode === "worktree" ? "New worktree" : "Current checkout";
}

export function resolveCurrentWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Current worktree" : resolveEnvModeLabel("local");
}

export function resolveLockedWorkspaceLabel(activeWorktreePath: string | null): string {
  return activeWorktreePath ? "Worktree" : "Local checkout";
}

export function resolveEffectiveEnvMode(input: {
  activeWorktreePath: string | null;
  hasServerThread: boolean;
  draftThreadEnvMode: EnvMode | undefined;
}): EnvMode {
  const { activeWorktreePath, hasServerThread, draftThreadEnvMode } = input;
  if (!hasServerThread) {
    if (activeWorktreePath) {
      return "local";
    }
    return draftThreadEnvMode === "worktree" ? "worktree" : "local";
  }
  return activeWorktreePath ? "worktree" : "local";
}

export function resolveDraftEnvModeAfterBranchChange(input: {
  nextWorktreePath: string | null;
  currentWorktreePath: string | null;
  effectiveEnvMode: EnvMode;
}): EnvMode {
  const { nextWorktreePath, currentWorktreePath, effectiveEnvMode } = input;
  if (nextWorktreePath) {
    return "worktree";
  }
  if (effectiveEnvMode === "worktree" && !currentWorktreePath) {
    return "worktree";
  }
  return "local";
}

export function resolveRefToolbarValue(input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadRefName: string | null;
  currentRefName: string | null;
}): string | null {
  const { envMode, activeWorktreePath, activeThreadRefName, currentRefName } = input;
  if (envMode === "worktree" && !activeWorktreePath) {
    return activeThreadRefName ?? currentRefName;
  }
  return currentRefName ?? activeThreadRefName;
}

export function resolveLocalCheckoutRefMismatch(input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadRefName: string | null;
  currentRefName: string | null;
}): { threadRefName: string; currentRefName: string } | null {
  const { effectiveEnvMode, activeWorktreePath, activeThreadRefName, currentRefName } = input;
  if (effectiveEnvMode !== "local" || activeWorktreePath !== null) {
    return null;
  }
  if (!activeThreadRefName || !currentRefName || activeThreadRefName === currentRefName) {
    return null;
  }
  return { threadRefName: activeThreadRefName, currentRefName };
}

export function resolveRefSelectionTarget(input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  ref: Pick<VcsRef, "isDefault" | "worktreePath">;
}): {
  checkoutCwd: string;
  nextWorktreePath: string | null;
  reuseExistingWorktree: boolean;
} {
  const { activeProjectCwd, activeWorktreePath, ref } = input;

  if (ref.worktreePath) {
    return {
      checkoutCwd: ref.worktreePath,
      nextWorktreePath: ref.worktreePath === activeProjectCwd ? null : ref.worktreePath,
      reuseExistingWorktree: true,
    };
  }

  const nextWorktreePath = activeWorktreePath !== null && ref.isDefault ? null : activeWorktreePath;

  return {
    checkoutCwd: nextWorktreePath ?? activeProjectCwd,
    nextWorktreePath,
    reuseExistingWorktree: false,
  };
}

export function shouldIncludeRefPickerItem(input: {
  itemValue: string;
  normalizedQuery: string;
  createRefItemValue: string | null;
  checkoutChangeRequestItemValue: string | null;
}): boolean {
  const { itemValue, normalizedQuery, createRefItemValue, checkoutChangeRequestItemValue } = input;

  if (normalizedQuery.length === 0) {
    return true;
  }

  if (createRefItemValue && itemValue === createRefItemValue) {
    return true;
  }

  if (checkoutChangeRequestItemValue && itemValue === checkoutChangeRequestItemValue) {
    return true;
  }

  return itemValue.toLowerCase().includes(normalizedQuery);
}

export function resolveLocalRefNameFromRemoteRef(ref: Pick<VcsRef, "name" | "remoteName">): string {
  const remotePrefix = ref.remoteName ? `${ref.remoteName}/` : "";
  if (remotePrefix.length > 0 && ref.name.startsWith(remotePrefix)) {
    const localName = ref.name.slice(remotePrefix.length);
    return localName.length > 0 ? localName : ref.name;
  }
  return ref.name;
}

export const resolveBranchToolbarValue = (input: {
  envMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}) =>
  resolveRefToolbarValue({
    envMode: input.envMode,
    activeWorktreePath: input.activeWorktreePath,
    activeThreadRefName: input.activeThreadBranch,
    currentRefName: input.currentGitBranch,
  });

export const resolveLocalCheckoutBranchMismatch = (input: {
  effectiveEnvMode: EnvMode;
  activeWorktreePath: string | null;
  activeThreadBranch: string | null;
  currentGitBranch: string | null;
}) => {
  const mismatch = resolveLocalCheckoutRefMismatch({
    effectiveEnvMode: input.effectiveEnvMode,
    activeWorktreePath: input.activeWorktreePath,
    activeThreadRefName: input.activeThreadBranch,
    currentRefName: input.currentGitBranch,
  });
  return mismatch
    ? {
        threadBranch: mismatch.threadRefName,
        currentBranch: mismatch.currentRefName,
      }
    : null;
};

export const resolveBranchSelectionTarget = (input: {
  activeProjectCwd: string;
  activeWorktreePath: string | null;
  refName: Pick<VcsRef, "isDefault" | "worktreePath">;
}) =>
  resolveRefSelectionTarget({
    activeProjectCwd: input.activeProjectCwd,
    activeWorktreePath: input.activeWorktreePath,
    ref: input.refName,
  });

export const shouldIncludeBranchPickerItem = (input: {
  itemValue: string;
  normalizedQuery: string;
  createBranchItemValue: string | null;
  checkoutPullRequestItemValue: string | null;
}) =>
  shouldIncludeRefPickerItem({
    itemValue: input.itemValue,
    normalizedQuery: input.normalizedQuery,
    createRefItemValue: input.createBranchItemValue,
    checkoutChangeRequestItemValue: input.checkoutPullRequestItemValue,
  });
