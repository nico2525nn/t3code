const WORKTREE_BRANCH_PREFIX = "t3code";

function randomHexToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) {
    return uuid.replace(/-/g, "").slice(0, 8).toLowerCase();
  }

  return Math.random().toString(16).slice(2, 10).padEnd(8, "0");
}

export function buildTemporaryWorktreeBranchName(): string {
  return `${WORKTREE_BRANCH_PREFIX}/${randomHexToken()}`;
}
