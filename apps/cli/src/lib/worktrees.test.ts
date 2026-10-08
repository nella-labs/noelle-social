import { describe, expect, it } from "vitest";
import { classifyWorktree } from "./worktrees.js";

const wt = (o: Partial<Parameters<typeof classifyWorktree>[0]> = {}) => ({
  path: "/wt/x",
  branch: "feat/x",
  head: "abc",
  locked: false,
  merged: true,
  dirty: false,
  ...o,
});

describe("classifyWorktree", () => {
  it("removable when merged to origin/main and clean", () => {
    expect(classifyWorktree(wt())).toBe("removable");
  });
  it("unmerged when not an ancestor of origin/main (keep — would lose work)", () => {
    expect(classifyWorktree(wt({ merged: false }))).toBe("unmerged");
  });
  it("dirty when it has uncommitted changes (keep)", () => {
    expect(classifyWorktree(wt({ dirty: true }))).toBe("dirty");
  });
  it("keeps a locked worktree that is also dirty", () => {
    expect(classifyWorktree(wt({ locked: true, dirty: true }))).toBe("locked-dirty");
  });
  it("still removable when locked but merged + clean (locked alone is not a reason to keep)", () => {
    expect(classifyWorktree(wt({ locked: true }))).toBe("removable");
  });
});
