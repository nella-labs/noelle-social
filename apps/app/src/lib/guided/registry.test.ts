import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { GUIDED_STEPS, guidedCaveats, hiredInterns, primaryIntern, targetingNoun, xIntern } from "./registry";
import { INTERN_ROLES, type GuidedSignals } from "./types";

const ORG = "acme";

function signals(over: Partial<GuidedSignals> = {}): GuidedSignals {
  return {
    vaultStage: null,
    hasApifyToken: false,
    agents: [],
    discoveredAny: false,
    draftedAny: false,
    pendingApprovals: 0,
    actionedAny: false,
    xPostingReady: false,
    ...over,
  };
}

const agent = (role: (typeof INTERN_ROLES)[number], over = {}) => ({
  role,
  instanceId: `${role}-id`,
  displayName: null,
  status: "paused",
  hasTargeting: false,
  replySendEnabled: false,
  ...over,
});

describe("registry invariants", () => {
  test("step ids are unique", () => {
    const ids = GUIDED_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every step has copy and a predicate", () => {
    for (const s of GUIDED_STEPS) {
      expect(s.title.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(0);
      expect(s.cta.length).toBeGreaterThan(0);
      expect(typeof s.isComplete).toBe("function");
    }
  });

  test("every step routes under the org, for every signal shape", () => {
    const shapes = [
      signals(),
      signals({ agents: [agent("x_intern")] }),
      signals({ agents: [agent("reddit_intern")] }),
      signals({ agents: INTERN_ROLES.map((r) => agent(r)) }),
    ];
    for (const s of shapes) {
      for (const step of GUIDED_STEPS) {
        expect(step.href(ORG, s).startsWith(`/app/${ORG}`)).toBe(true);
      }
    }
  });

  test("at least one required step exists, and required steps precede advanced ones", () => {
    const tiers = GUIDED_STEPS.map((s) => s.tier);
    expect(tiers).toContain("required");
    const lastRequired = tiers.lastIndexOf("required");
    const firstAdvanced = tiers.indexOf("advanced");
    if (firstAdvanced !== -1) expect(firstAdvanced).toBeGreaterThan(lastRequired);
  });

  test("predicates are total — no step throws on an empty org", () => {
    for (const step of GUIDED_STEPS) {
      expect(() => step.isComplete(signals())).not.toThrow();
      expect(() => step.blockedBy?.(signals())).not.toThrow();
      expect(() => step.waitingOn?.(signals())).not.toThrow();
      expect(() => step.note?.(signals())).not.toThrow();
    }
  });

  test("a completed step is never also blocked", () => {
    const done = signals({
      vaultStage: "rich",
      hasApifyToken: true,
      agents: [agent("x_intern", { status: "active", hasTargeting: true, replySendEnabled: true })],
      draftedAny: true,
      actionedAny: true,
      xPostingReady: true,
    });
    for (const step of GUIDED_STEPS) {
      if (step.isComplete(done)) expect(step.blockedBy?.(done) ?? null).toBeNull();
    }
  });
});

describe("guided flow never redirects", () => {
  // The flow this replaces hard-redirected the dashboard root into the vault
  // wizard, which looped forever on Next 15. Assert the property structurally.
  test("no guided module imports or calls redirect()", () => {
    const dir = join(__dirname);
    for (const f of ["registry.ts", "plan.ts", "types.ts", "signals.ts"]) {
      const src = readFileSync(join(dir, f), "utf8");
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(code, `${f} must not redirect`).not.toMatch(/\bredirect\s*\(/);
    }
  });
});

describe("signal helpers", () => {
  test("one targeted intern supplies targeting and activation links", () => {
    const s = signals({ agents: [agent("x_intern", { status: "active" }), agent("linkedin_intern", { hasTargeting: true })] });
    expect(primaryIntern(s)?.role).toBe("linkedin_intern");
    for (const id of ["targeting", "activate"]) {
      const step = GUIDED_STEPS.find(step => step.id === id)!;
      expect(step.href(ORG, s)).toContain("linkedin_intern-id");
    }
    expect(GUIDED_STEPS.find(step => step.id === "activate")!.isComplete(s)).toBe(false);
  });

  test("an active targeted intern outranks earlier incomplete hires", () => {
    const s = signals({ agents: [agent("x_intern"), agent("linkedin_intern", { status: "active", hasTargeting: true })] });
    expect(primaryIntern(s)?.role).toBe("linkedin_intern");
    for (const id of ["targeting", "activate"]) {
      const step = GUIDED_STEPS.find(step => step.id === id)!;
      expect(step.isComplete(s)).toBe(true); expect(step.href(ORG, s)).toContain("linkedin_intern-id");
    }
  });

  test("completed voice revisits the explicit saved identity step", () => {
    const step = GUIDED_STEPS.find(step => step.id === "voice")!;
    expect(step.href(ORG, signals({ vaultStage: "rich" }))).toBe(`/app/${ORG}/onboarding/vault?step=light`);
  });

  test("hiredInterns filters non-intern roles and sorts X first", () => {
    const s = signals({
      // Deliberately out of order, plus a chat-only role the flow must ignore.
      agents: [
        agent("video_intern"),
        // @ts-expect-error — `ceo` is not an InternRole; the helper must drop it.
        { role: "ceo", instanceId: "ceo", displayName: "Retired coordinator", status: "active", hasTargeting: false, replySendEnabled: false },
        agent("x_intern"),
      ],
    });
    expect(hiredInterns(s).map((a) => a.role)).toEqual(["x_intern", "video_intern"]);
    expect(primaryIntern(s)?.role).toBe("x_intern");
  });

  test("primaryIntern is null for an org with only chat roles", () => {
    // @ts-expect-error — see above.
    const s = signals({ agents: [{ role: "cmo", instanceId: "c", displayName: "Retired coordinator", status: "active", hasTargeting: false, replySendEnabled: false }] });
    expect(primaryIntern(s)).toBeNull();
    expect(xIntern(s)).toBeNull();
  });

  test("targetingNoun names the right thing per agent", () => {
    expect(targetingNoun(signals({ agents: [agent("x_intern")] }))).toMatch(/handles/);
    expect(targetingNoun(signals({ agents: [agent("reddit_intern")] }))).toMatch(/subreddits/);
    expect(targetingNoun(signals())).toBe("targets");
  });
});

describe("caveats", () => {
  test("silent about an agent that is only a waitlist placeholder", () => {
    const s = signals({ agents: [agent("reddit_intern", { status: "provisioning_alpha" })] });
    expect(guidedCaveats(s)).toEqual([]);
  });

  test("silent for X and LinkedIn", () => {
    expect(guidedCaveats(signals({ agents: [agent("x_intern"), agent("linkedin_intern")] }))).toEqual([]);
  });

  test("does not infer Reddit runtime availability from the role alone", () => {
    const c = guidedCaveats(signals({ agents: [agent("reddit_intern")] }));
    expect(c).toEqual([]);
  });

  test("marks short video harvesting unavailable while retaining script tools", () => {
    const c = guidedCaveats(signals({ agents: [agent("video_intern")] }));
    expect(c[0]).toMatch(/harvesting is unavailable/);
    expect(c[0]).toMatch(/script tools remain available/);
    expect(c[0]).not.toMatch(/every worker restart/i);
  });
});
