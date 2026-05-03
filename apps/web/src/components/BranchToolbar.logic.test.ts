import { EnvironmentId, type VcsRef } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";
import {
  dedupeRemoteBranchesWithLocalMatches,
  resolveEnvironmentOptionLabel,
  resolveCurrentWorkspaceLabel,
  resolveDraftEnvModeAfterBranchChange,
  resolveEffectiveEnvMode,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  resolveLocalCheckoutRefMismatch,
  resolveLocalRefNameFromRemoteRef,
  resolveRefSelectionTarget,
  resolveRefToolbarValue,
  shouldIncludeRefPickerItem,
} from "./BranchToolbar.logic";

const localEnvironmentId = EnvironmentId.make("environment-local");
const remoteEnvironmentId = EnvironmentId.make("environment-remote");

describe("resolveDraftEnvModeAfterBranchChange", () => {
  it("switches to local mode when returning from an existing worktree to the main worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: "/repo/.t3/worktrees/feature-a",
        effectiveEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps new-worktree mode when selecting a base ref before worktree creation", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: null,
        currentWorktreePath: null,
        effectiveEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });

  it("uses worktree mode when selecting a ref already attached to a worktree", () => {
    expect(
      resolveDraftEnvModeAfterBranchChange({
        nextWorktreePath: "/repo/.t3/worktrees/feature-a",
        currentWorktreePath: null,
        effectiveEnvMode: "local",
      }),
    ).toBe("worktree");
  });
});

describe("resolveRefToolbarValue", () => {
  it("defaults new-worktree mode to current ref when no explicit base ref is set", () => {
    expect(
      resolveRefToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadRefName: null,
        currentRefName: "main",
      }),
    ).toBe("main");
  });

  it("keeps an explicitly selected worktree base ref", () => {
    expect(
      resolveRefToolbarValue({
        envMode: "worktree",
        activeWorktreePath: null,
        activeThreadRefName: "feature/base",
        currentRefName: "main",
      }),
    ).toBe("feature/base");
  });

  it("shows the actual checked-out ref when not selecting a new worktree base", () => {
    expect(
      resolveRefToolbarValue({
        envMode: "local",
        activeWorktreePath: null,
        activeThreadRefName: "feature/base",
        currentRefName: "main",
      }),
    ).toBe("main");
  });
});

describe("resolveLocalCheckoutRefMismatch", () => {
  it("detects when a local thread is associated with a different ref than the checkout", () => {
    expect(
      resolveLocalCheckoutRefMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadRefName: "feature/thread",
        currentRefName: "feature/current",
      }),
    ).toEqual({
      threadRefName: "feature/thread",
      currentRefName: "feature/current",
    });
  });

  it("ignores matching local checkout state", () => {
    expect(
      resolveLocalCheckoutRefMismatch({
        effectiveEnvMode: "local",
        activeWorktreePath: null,
        activeThreadRefName: "feature/thread",
        currentRefName: "feature/thread",
      }),
    ).toBeNull();
  });

  it("ignores dedicated worktrees because their checkout is already thread-scoped", () => {
    expect(
      resolveLocalCheckoutRefMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: "/repo/.t3/worktrees/feature-thread",
        activeThreadRefName: "feature/thread",
        currentRefName: "feature/current",
      }),
    ).toBeNull();
  });

  it("ignores new-worktree base selection before a worktree exists", () => {
    expect(
      resolveLocalCheckoutRefMismatch({
        effectiveEnvMode: "worktree",
        activeWorktreePath: null,
        activeThreadRefName: "feature/base",
        currentRefName: "main",
      }),
    ).toBeNull();
  });
});

describe("resolveEnvironmentOptionLabel", () => {
  it("prefers the primary environment's machine label", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Julius's Mac mini",
        savedLabel: "Local environment",
      }),
    ).toBe("Julius's Mac mini");
  });

  it("falls back to 'This device' for generic primary labels", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: true,
        environmentId: localEnvironmentId,
        runtimeLabel: "Local environment",
        savedLabel: "Local",
      }),
    ).toBe("This device");
  });

  it("keeps configured labels for non-primary environments", () => {
    expect(
      resolveEnvironmentOptionLabel({
        isPrimary: false,
        environmentId: remoteEnvironmentId,
        runtimeLabel: null,
        savedLabel: "Build box",
      }),
    ).toBe("Build box");
  });
});

describe("resolveEffectiveEnvMode", () => {
  it("treats draft threads already attached to a worktree as current-checkout mode", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        hasServerThread: false,
        draftThreadEnvMode: "worktree",
      }),
    ).toBe("local");
  });

  it("keeps explicit new-worktree mode for draft threads without a worktree path", () => {
    expect(
      resolveEffectiveEnvMode({
        activeWorktreePath: null,
        hasServerThread: false,
        draftThreadEnvMode: "worktree",
      }),
    ).toBe("worktree");
  });
});

describe("resolveEnvModeLabel", () => {
  it("uses explicit workspace labels", () => {
    expect(resolveEnvModeLabel("local")).toBe("Current checkout");
    expect(resolveEnvModeLabel("worktree")).toBe("New worktree");
  });
});

describe("resolveCurrentWorkspaceLabel", () => {
  it("describes the main repo checkout when no worktree path is active", () => {
    expect(resolveCurrentWorkspaceLabel(null)).toBe("Current checkout");
  });

  it("describes the active checkout as a worktree when one is attached", () => {
    expect(resolveCurrentWorkspaceLabel("/repo/.t3/worktrees/feature-a")).toBe("Current worktree");
  });
});

describe("resolveLockedWorkspaceLabel", () => {
  it("uses a shorter label for the main repo checkout", () => {
    expect(resolveLockedWorkspaceLabel(null)).toBe("Local checkout");
  });

  it("uses a shorter label for an attached worktree", () => {
    expect(resolveLockedWorkspaceLabel("/repo/.t3/worktrees/feature-a")).toBe("Worktree");
  });
});

describe("resolveLocalRefNameFromRemoteRef", () => {
  it("strips the remote prefix from a remote ref using structured metadata", () => {
    expect(
      resolveLocalRefNameFromRemoteRef({
        name: "origin/feature/demo",
        remoteName: "origin",
      }),
    ).toBe("feature/demo");
  });

  it("supports remote names that contain slashes through the remoteName field", () => {
    expect(
      resolveLocalRefNameFromRemoteRef({
        name: "my-org/upstream/feature/demo",
        remoteName: "my-org/upstream",
      }),
    ).toBe("feature/demo");
  });

  it("returns the original name when remote metadata is unavailable", () => {
    expect(
      resolveLocalRefNameFromRemoteRef({
        name: "origin/feature/demo",
      }),
    ).toBe("origin/feature/demo");
  });

  it("returns the original name when the remote prefix is malformed", () => {
    expect(
      resolveLocalRefNameFromRemoteRef({
        name: "origin/",
        remoteName: "origin",
      }),
    ).toBe("origin/");
    expect(
      resolveLocalRefNameFromRemoteRef({
        name: "/feature/demo",
        remoteName: "origin",
      }),
    ).toBe("/feature/demo");
  });
});

describe("dedupeRemoteBranchesWithLocalMatches", () => {
  it("hides remote refs when the matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/demo",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps all entries when no local match exists for a remote ref", () => {
    const input: VcsRef[] = [
      {
        name: "feature/local",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "origin/feature/remote-only",
        isRemote: true,
        remoteName: "origin",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/local",
      "origin/feature/remote-only",
    ]);
  });

  it("keeps non-origin remote refs visible even when a matching local ref exists", () => {
    const input: VcsRef[] = [
      {
        name: "feature/demo",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature/demo",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "feature/demo",
      "my-org/upstream/feature/demo",
    ]);
  });

  it("keeps non-origin remote refs visible when git tracks with first-slash local naming", () => {
    const input: VcsRef[] = [
      {
        name: "upstream/feature",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
      {
        name: "my-org/upstream/feature",
        isRemote: true,
        remoteName: "my-org/upstream",
        current: false,
        isDefault: false,
        worktreePath: null,
      },
    ];

    expect(dedupeRemoteBranchesWithLocalMatches(input).map((ref) => ref.name)).toEqual([
      "upstream/feature",
      "my-org/upstream/feature",
    ]);
  });
});

describe("resolveRefSelectionTarget", () => {
  it("reuses an existing secondary worktree for the selected ref", () => {
    expect(
      resolveRefSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        ref: {
          isDefault: false,
          worktreePath: "/repo/.t3/worktrees/feature-b",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-b",
      nextWorktreePath: "/repo/.t3/worktrees/feature-b",
      reuseExistingWorktree: true,
    });
  });

  it("switches back to the main repo when the ref already lives there", () => {
    expect(
      resolveRefSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        ref: {
          isDefault: true,
          worktreePath: "/repo",
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: true,
    });
  });

  it("checks out the default ref in the main repo when leaving a secondary worktree", () => {
    expect(
      resolveRefSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        ref: {
          isDefault: true,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo",
      nextWorktreePath: null,
      reuseExistingWorktree: false,
    });
  });

  it("keeps checkout in the current worktree for non-default refs", () => {
    expect(
      resolveRefSelectionTarget({
        activeProjectCwd: "/repo",
        activeWorktreePath: "/repo/.t3/worktrees/feature-a",
        ref: {
          isDefault: false,
          worktreePath: null,
        },
      }),
    ).toEqual({
      checkoutCwd: "/repo/.t3/worktrees/feature-a",
      nextWorktreePath: "/repo/.t3/worktrees/feature-a",
      reuseExistingWorktree: false,
    });
  });
});

describe("shouldIncludeRefPickerItem", () => {
  it("keeps the synthetic checkout change request item visible for change request input", () => {
    expect(
      shouldIncludeRefPickerItem({
        itemValue: "__checkout_pull_request__:1359",
        normalizedQuery: "gh pr checkout 1359",
        createRefItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutChangeRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(true);
  });

  it("keeps the synthetic create-ref item visible for arbitrary ref input", () => {
    expect(
      shouldIncludeRefPickerItem({
        itemValue: "__create_new_branch__:feature/demo",
        normalizedQuery: "feature/demo",
        createRefItemValue: "__create_new_branch__:feature/demo",
        checkoutChangeRequestItemValue: null,
      }),
    ).toBe(true);
  });

  it("still filters ordinary ref items by query text", () => {
    expect(
      shouldIncludeRefPickerItem({
        itemValue: "main",
        normalizedQuery: "gh pr checkout 1359",
        createRefItemValue: "__create_new_branch__:gh pr checkout 1359",
        checkoutChangeRequestItemValue: "__checkout_pull_request__:1359",
      }),
    ).toBe(false);
  });
});
