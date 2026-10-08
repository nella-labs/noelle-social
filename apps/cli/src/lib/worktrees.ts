import { run } from "./platform.js";

/**
 * Prune stale worktrees under .claude/worktrees/. We only remove a worktree whose branch is fully
 * merged into origin/main AND whose tree is clean — then removal loses nothing
 * (the work is in main). Everything else is reported, never touched.
 */
export interface WorktreeFacts {
  path: string;
  branch: string;
  head: string;
  locked: boolean;
  merged: boolean; // HEAD is an ancestor of origin/main
  dirty: boolean; // has uncommitted changes
}

export function classifyWorktree(
  w: WorktreeFacts,
): "removable" | "unmerged" | "dirty" | "locked-dirty" {
  if (w.dirty) return w.locked ? "locked-dirty" : "dirty";
  if (!w.merged) return "unmerged";
  return "removable";
}

/** Parse `git worktree list --porcelain` into facts (only .claude/worktrees ones). */
export async function listWorktrees(repoRoot: string): Promise<WorktreeFacts[]> {
  const r = await run("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
    allowFailure: false,
  });
  const blocks = r.stdout.trim().split("\n\n");
  const out: WorktreeFacts[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? "";
    if (!path.includes("/.claude/worktrees/")) continue;
    const head = lines.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length) ?? "";
    const branch = (
      lines.find((l) => l.startsWith("branch "))?.slice("branch ".length) ?? ""
    ).replace("refs/heads/", "");
    const locked = lines.some((l) => l === "locked" || l.startsWith("locked "));

    const mergeBase = await run(
      "git",
      ["-C", repoRoot, "merge-base", "--is-ancestor", head, "origin/main"],
      { allowFailure: true },
    );
    const st = await run("git", ["-C", path, "status", "--porcelain"], { allowFailure: true });
    out.push({
      path,
      branch,
      head,
      locked,
      merged: mergeBase.code === 0,
      dirty: st.code !== 0 || st.stdout.trim().length > 0,
    });
  }
  return out;
}

export async function removeWorktree(repoRoot: string, path: string): Promise<boolean> {
  const r = await run("git", ["-C", repoRoot, "worktree", "remove", path], {
    allowFailure: true,
  });
  return r.code === 0;
}
