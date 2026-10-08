import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { installPostCommitHook, renderPlist, renderPostCommitHook } from "./autoupdate.js";

const inputs = {
  nodeBin: "/opt/homebrew/bin/node",
  cliEntry: "/repo/apps/cli/dist/index.js",
  repoRoot: "/repo",
};

describe("renderPlist", () => {
  it("runs Standard, never Background (a sync that revives pm2 must not QoS-clamp the runtime)", () => {
    const plist = renderPlist({
      label: "com.noelle.autoupdate",
      launcher: "/l.sh",
      log: "/l.log",
      intervalSeconds: 600,
    });
    expect(plist).toMatch(/<key>ProcessType<\/key>\s*<string>Standard<\/string>/);
    expect(plist).not.toContain("<string>Background</string>");
  });
});

describe("renderPostCommitHook", () => {
  it("runs noelle sync in the background on commit", () => {
    const h = renderPostCommitHook(inputs);
    expect(h).toContain("post-commit");
    expect(h).toContain("/repo/apps/cli/dist/index.js");
    expect(h).toContain("sync");
    // A marker so install() can detect + safely overwrite its OWN hook.
    expect(h).toMatch(/noelle-managed/);
  });

  it("scrubs the git hook env and gates on the runtime checkout (worktree commits must not deploy)", () => {
    const h = renderPostCommitHook(inputs);
    // Without the scrub, GIT_DIR retargets every `git -C` in the spawned sync
    // at the committing worktree — a branch sha got deployed this way.
    expect(h).toContain("unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE");
    // The gate must run AFTER the scrub, or --show-toplevel answers for the
    // worktree's exported GIT_DIR too.
    expect(h.indexOf("unset GIT_DIR")).toBeLessThan(h.indexOf("--show-toplevel"));
    expect(h).toContain(`[ "$top" = '/repo' ] || exit 0`);
    // The gate must precede the sync spawn.
    expect(h.indexOf("|| exit 0")).toBeLessThan(h.indexOf("sync >/dev/null"));
  });
});

describe("installPostCommitHook", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.length = 0;
  });
  function repo(): string {
    const d = mkdtempSync(resolve(tmpdir(), "noelle-hook-"));
    dirs.push(d);
    mkdirSync(resolve(d, ".git", "hooks"), { recursive: true });
    return d;
  }
  const hook = (d: string) => resolve(d, ".git", "hooks", "post-commit");

  it("writes the hook when the slot is empty", () => {
    const d = repo();
    installPostCommitHook(d, inputs);
    expect(existsSync(hook(d))).toBe(true);
    expect(readFileSync(hook(d), "utf8")).toContain("noelle-managed");
  });

  it("does NOT clobber a user's own non-Noelle hook", () => {
    const d = repo();
    writeFileSync(hook(d), "#!/bin/bash\necho mine\n");
    installPostCommitHook(d, inputs);
    expect(readFileSync(hook(d), "utf8")).toBe("#!/bin/bash\necho mine\n");
  });

  it("overwrites its own previous managed hook (idempotent re-install)", () => {
    const d = repo();
    installPostCommitHook(d, inputs);
    installPostCommitHook(d, { ...inputs, cliEntry: "/repo2/apps/cli/dist/index.js" });
    expect(readFileSync(hook(d), "utf8")).toContain("/repo2/apps/cli/dist/index.js");
  });
});
