import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./platform.js";
import { listWorktrees, removeWorktree } from "./worktrees.js";

describe("native worktree cleanup boundary", () => {
  let repo: string;
  let tree: string;
  beforeEach(async () => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), "noelle-worktree-test-")));
    tree = join(repo, ".claude", "worktrees", "fixture");
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    const git = (args: string[]) => run("git", ["-C", repo, ...args]);
    await git(["init", "-b", "main"]);
    await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "--allow-empty", "-m", "fixture"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(["worktree", "add", "-b", "fixture", tree]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("keeps an unavailable worktree whose git status cannot prove cleanliness", async () => {
    rmSync(tree, { recursive: true });
    expect(await listWorktrees(repo)).toMatchObject([{ path: tree, dirty: true }]);
  });
  it("does not force away edits made after the cleanup inventory", async () => {
    expect(await listWorktrees(repo)).toMatchObject([{ dirty: false, merged: true }]);
    writeFileSync(join(tree, "unsaved.txt"), "keep this work");
    expect(await removeWorktree(repo, tree)).toBe(false);
    expect(await listWorktrees(repo)).toMatchObject([{ dirty: true }]);
  });
  it("reports a failed inventory rather than a successful empty list", async () => {
    await expect(listWorktrees(join(repo, "missing"))).rejects.toThrow();
  });
});
