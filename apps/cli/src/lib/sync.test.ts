import { describe, expect, it } from "vitest";
import {
  RSYNC_EXCLUDES,
  DEPLOY_STAMP_FILE,
  deployStampPayload,
  vmRestartCommand,
  isNativeRuntime,
  ffDecision,
  GIT_DIRTY_ARGS,
  recordDeployFailure,
  selfHealDecision,
  shouldHoldDeploy,
  DEPLOY_MAX_ATTEMPTS,
  isDocsOnlyDiff,
  pnpmInstallArgs,
} from "./sync.js";

describe("isNativeRuntime", () => {
  it("is true only for a native config", () => {
    expect(isNativeRuntime({ runtime: "native" })).toBe(true);
    expect(isNativeRuntime({ runtime: "vm" })).toBe(false);
    expect(isNativeRuntime(null)).toBe(false);
    expect(isNativeRuntime(undefined)).toBe(false);
  });
});

describe("deploy stamp", () => {
  it("builds the ground-truth payload the VM reads", () => {
    expect(deployStampPayload("abc123", "macmini", "2026-07-03T00:00:00.000Z")).toEqual({
      sha: "abc123",
      builtAt: "2026-07-03T00:00:00.000Z",
      builtBy: "macmini",
    });
  });
  it("is NOT excluded from rsync (must ship to the VM)", () => {
    expect([...RSYNC_EXCLUDES]).not.toContain(DEPLOY_STAMP_FILE);
  });
});

describe("ffDecision (native pre-build origin sync)", () => {
  const clean = {
    currentBranch: "main",
    branch: "main",
    dirtyFiles: 0,
    aheadCount: 0,
    behindCount: 3,
  };

  it("fast-forwards a clean, on-branch, behind checkout (merged PRs deploy hands-free)", () => {
    expect(ffDecision(clean).action).toBe("fast-forwarded");
  });

  it("is a no-op when local already matches origin", () => {
    expect(ffDecision({ ...clean, behindCount: 0 }).action).toBe("up-to-date");
  });

  it("skips when the checkout is not on the tracked branch", () => {
    expect(ffDecision({ ...clean, currentBranch: "feature-x" }).action).toBe("skipped-branch");
    expect(ffDecision({ ...clean, currentBranch: "" }).action).toBe("skipped-branch");
  });

  it("skips when the tree is dirty (local edits survive the tick)", () => {
    expect(ffDecision({ ...clean, dirtyFiles: 2 }).action).toBe("skipped-dirty");
  });

  it("skips when local is ahead of origin (local dev still deploys)", () => {
    expect(ffDecision({ ...clean, aheadCount: 1 }).action).toBe("skipped-ahead");
  });

  it("skips when the comparison itself failed (fail toward not merging)", () => {
    expect(ffDecision({ ...clean, aheadCount: null }).action).toBe("skipped-compare");
    expect(ffDecision({ ...clean, behindCount: null }).action).toBe("skipped-compare");
  });

  it("checks branch before dirtiness before ahead-ness", () => {
    expect(
      ffDecision({ ...clean, currentBranch: "other", dirtyFiles: 5, aheadCount: 2 }).action,
    ).toBe("skipped-branch");
    expect(ffDecision({ ...clean, dirtyFiles: 5, aheadCount: 2 }).action).toBe("skipped-dirty");
  });

  it("counts dirtiness with -uno: untracked files never veto the pull", () => {
    // The real checkout permanently carries untracked vendor skills; plain
    // --porcelain would return skipped-dirty on every tick.
    expect([...GIT_DIRTY_ARGS]).toContain("-uno");
  });
});

describe("deploy failure backoff", () => {
  it("pages only on the FIRST failure of a sha", () => {
    const first = recordDeployFailure(null, "abc");
    expect(first).toEqual({ state: { sha: "abc", attempts: 1 }, alert: true });
    const second = recordDeployFailure(first.state, "abc");
    expect(second).toEqual({ state: { sha: "abc", attempts: 2 }, alert: false });
  });

  it("resets the counter (and pages again) when the failing sha changes", () => {
    const r = recordDeployFailure({ sha: "abc", attempts: 3 }, "def");
    expect(r).toEqual({ state: { sha: "def", attempts: 1 }, alert: true });
  });

  it("holds an auto tick after DEPLOY_MAX_ATTEMPTS failures of the same sha", () => {
    expect(shouldHoldDeploy({ sha: "abc", attempts: DEPLOY_MAX_ATTEMPTS }, "abc")).toBe(true);
    expect(shouldHoldDeploy({ sha: "abc", attempts: DEPLOY_MAX_ATTEMPTS - 1 }, "abc")).toBe(false);
    expect(shouldHoldDeploy({ sha: "abc", attempts: 99 }, "def")).toBe(false);
    expect(shouldHoldDeploy(null, "abc")).toBe(false);
    expect(shouldHoldDeploy(undefined, "abc")).toBe(false);
  });
});

describe("selfHealDecision (auto-tick stack self-heal)", () => {
  const allUp = { postgresOk: true, apiOk: true, appOk: true, markedDown: false };

  it("does nothing when the stack is healthy", () => {
    expect(selfHealDecision(allUp)).toEqual({ heal: false, detail: "" });
  });

  it("heals when any component is down and names the dead ones", () => {
    expect(selfHealDecision({ ...allUp, postgresOk: false })).toEqual({
      heal: true,
      detail: "postgres",
    });
    expect(selfHealDecision({ ...allUp, postgresOk: false, apiOk: false, appOk: false })).toEqual({
      heal: true,
      detail: "postgres, api-vm, dashboard",
    });
  });

  it("never heals a stack the operator stopped with `noelle down`", () => {
    const d = selfHealDecision({
      postgresOk: false,
      apiOk: false,
      appOk: false,
      markedDown: true,
    });
    expect(d.heal).toBe(false);
    expect(d.detail).toContain("noelle down");
  });

  it("a healthy stack with a leftover marker stays quiet (no log spam)", () => {
    expect(selfHealDecision({ ...allUp, markedDown: true })).toEqual({ heal: false, detail: "" });
  });
});

describe("isDocsOnlyDiff", () => {
  it("skips the build for docs/tasks/agents/skills/markdown-only merges", () => {
    expect(
      isDocsOnlyDiff([
        "docs/runbook.md",
        "tasks/todo.md",
        ".agents/notes.json",
        ".claude/skills/verify-noelle/SKILL.md",
        "README.md",
      ]),
    ).toBe(true);
  });

  it("builds when any runtime path changed", () => {
    expect(isDocsOnlyDiff(["docs/runbook.md", "apps/cli/src/index.ts"])).toBe(false);
    expect(isDocsOnlyDiff(["packages/runtime/src/tenancy.ts"])).toBe(false);
  });

  it("treats an empty or failed diff as buildable (never skip blindly)", () => {
    expect(isDocsOnlyDiff([])).toBe(false);
  });

  it("does not confuse lookalike paths with the no-build prefixes", () => {
    expect(isDocsOnlyDiff(["docsite/index.ts"])).toBe(false);
    expect(isDocsOnlyDiff(["apps/docs/gen.ts"])).toBe(false);
  });
});

describe("vmRestartCommand", () => {
  it("restarts the VM ecosystem via the bundled pm2 (same resolution as the Mac)", () => {
    const cmd = vmRestartCommand();
    expect(cmd).toContain("~/.noelle/ecosystem.config.cjs");
    expect(cmd).toContain("--filter @noelle/cli exec pm2");
    expect(cmd).toContain("restart");
  });
});

describe("pnpmInstallArgs", () => {
  it("installs offline-first and tolerant, never strict", () => {
    const args = pnpmInstallArgs();
    expect(args[0]).toBe("install");
    // Network-tolerant: the store already has everything on a routine deploy.
    expect(args).toContain("--prefer-offline");
    // Robust, not strict: a manual deploy of a mid-edit working tree must not
    // turn a lockfile drift into a deploy failure.
    expect(args).not.toContain("--frozen-lockfile");
    // No prod-pruning: the build needs devDependencies (tsc, next, vitest).
    expect(args).not.toContain("--prod");
    expect(args).not.toContain("--production");
  });
});
