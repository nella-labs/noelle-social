import { describe, expect, test } from "vitest";
import { buildGuidedPlan } from "./plan";
import { GUIDED_STEPS } from "./registry";
import type { GuidedSignals } from "./types";

const ORG = "selected";
const VEGA = "bd267e43-3859-4c33-aac5-a9fe5fa29da5";

/** A brand-new org: nothing done at all. */
function emptySignals(): GuidedSignals {
  return {
    vaultStage: null,
    hasApifyToken: false,
    discoveredAny: false,
    agents: [],
    draftedAny: false,
    pendingApprovals: 0,
    actionedAny: false,
    xPostingReady: false,
  };
}

function withVega(overrides: Partial<GuidedSignals["agents"][number]> = {}) {
  return {
    role: "x_intern" as const,
    instanceId: VEGA,
    displayName: "Vega",
    status: "paused",
    hasTargeting: false,
    replySendEnabled: false,
    ...overrides,
  };
}

function stateOf(plan: ReturnType<typeof buildGuidedPlan>, id: string) {
  const view = plan.steps.find((s) => s.step.id === id);
  if (!view) throw new Error(`step ${id} missing from plan`);
  return view.state;
}

test("active untargeted and paused targeted interns do not complete a working setup", () => {
  const s = { ...emptySignals(), hasApifyToken: true, actionedAny: true,
    agents: [withVega({ status: "active" }), { ...withVega({ hasTargeting: true }), role: "linkedin_intern" as const, instanceId: "li" }] };
  const plan = buildGuidedPlan(s, ORG);
  expect(plan.complete).toBe(false); expect(stateOf(plan, "activate")).toBe("current");
});

test("setup completion does not claim observed worker execution", () => {
  const plan = buildGuidedPlan({ ...emptySignals(), hasApifyToken: true, actionedAny: true,
    agents: [withVega({ status: "active", hasTargeting: true })] }, ORG);
  expect(plan.status).toMatch(/required setup.*complete/i);
  expect(plan.status).not.toMatch(/runs on its own/i);
});

describe("buildGuidedPlan — empty org", () => {
  const plan = buildGuidedPlan(emptySignals(), ORG);

  test("renders every registry step", () => {
    expect(plan.steps).toHaveLength(GUIDED_STEPS.length);
  });

  test("nothing is done and the flow is incomplete", () => {
    expect(plan.complete).toBe(false);
    expect(plan.requiredDone).toBe(0);
    expect(plan.steps.every((s) => s.state !== "done")).toBe(true);
  });

  test("the first actionable required step is current", () => {
    // `voice` is recommended, not required, so it never becomes current.
    expect(plan.currentId).toBe("data-source");
    expect(stateOf(plan, "voice")).toBe("todo");
  });

  test("steps that depend on a hired intern are blocked, with a reason", () => {
    expect(stateOf(plan, "targeting")).toBe("blocked");
    expect(stateOf(plan, "activate")).toBe("blocked");
    const targeting = plan.steps.find((s) => s.step.id === "targeting")!;
    expect(targeting.reason).toMatch(/set up a channel/i);
  });

  test("exactly one step is current", () => {
    expect(plan.steps.filter((s) => s.state === "current")).toHaveLength(1);
  });
});

describe("buildGuidedPlan — vault does not gate anything", () => {
  test("an org that skipped the vault can still complete every required step", () => {
    const s: GuidedSignals = {
      vaultStage: null,
      hasApifyToken: true,
      discoveredAny: false,
      agents: [withVega({ status: "active", hasTargeting: true })],
      draftedAny: true,
      pendingApprovals: 0,
      actionedAny: true,
      xPostingReady: false,
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(plan.complete).toBe(true);
    expect(stateOf(plan, "voice")).toBe("todo");
    expect(plan.currentId).toBeNull();
  });
});

describe("buildGuidedPlan — blocked before hire", () => {
  test("targeting unblocks once an intern exists", () => {
    const s = { ...emptySignals(), hasApifyToken: true, agents: [withVega()] };
    const plan = buildGuidedPlan(s, ORG);
    expect(stateOf(plan, "hire")).toBe("done");
    expect(stateOf(plan, "targeting")).toBe("current");
    expect(stateOf(plan, "activate")).toBe("todo");
  });
});

describe("buildGuidedPlan — waiting state", () => {
  test("approve waits on the pipeline once the operator's part is done", () => {
    const s: GuidedSignals = {
      ...emptySignals(),
      hasApifyToken: true,
      discoveredAny: false,
      agents: [withVega({ status: "active", hasTargeting: true })],
      draftedAny: false,
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(stateOf(plan, "approve")).toBe("waiting");
    // A waiting step is never "current" — there is nothing to click.
    expect(plan.currentId).not.toBe("approve");
    const approve = plan.steps.find((s) => s.step.id === "approve")!;
    expect(approve.reason).toBeTruthy();
  });

  test("approve becomes actionable the moment a draft is pending", () => {
    const s: GuidedSignals = {
      ...emptySignals(),
      hasApifyToken: true,
      discoveredAny: false,
      agents: [withVega({ status: "active", hasTargeting: true })],
      draftedAny: true,
      pendingApprovals: 3,
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(stateOf(plan, "approve")).toBe("current");
  });

  test("approve is done once anything has been actioned", () => {
    const s: GuidedSignals = {
      ...emptySignals(),
      hasApifyToken: true,
      discoveredAny: false,
      agents: [withVega({ status: "active", hasTargeting: true })],
      draftedAny: true,
      actionedAny: true,
    };
    expect(stateOf(buildGuidedPlan(s, ORG), "approve")).toBe("done");
  });
});

describe("buildGuidedPlan — a waitlist placeholder is not a hire", () => {
  // Historical pending rows must not enable controls until setup completes.
  const waitlisted = (): GuidedSignals => ({
    ...emptySignals(),
    hasApifyToken: true,
    agents: [withVega({ status: "provisioning_alpha" })],
  });

  test("hire is not done, and is the current step", () => {
    const plan = buildGuidedPlan(waitlisted(), ORG);
    expect(stateOf(plan, "hire")).toBe("current");
    expect(plan.requiredDone).toBe(1); // data-source only
  });

  test("targeting and activate stay blocked", () => {
    const plan = buildGuidedPlan(waitlisted(), ORG);
    expect(stateOf(plan, "targeting")).toBe("blocked");
    expect(stateOf(plan, "activate")).toBe("blocked");
  });

  test("a legacy placeholder directs setup to channel settings", () => {
    const hire = buildGuidedPlan(waitlisted(), ORG).steps.find((v) => v.step.id === "hire")!;
    expect(hire.reason).toMatch(/needs setup.*channel settings/i);
  });

  test("publishing is blocked: a waitlisted Vega cannot post", () => {
    expect(stateOf(buildGuidedPlan(waitlisted(), ORG), "publishing")).toBe("blocked");
  });

  test("a real hire alongside the placeholder still counts", () => {
    const s: GuidedSignals = {
      ...emptySignals(),
      hasApifyToken: true,
      agents: [
        withVega({ status: "provisioning_alpha" }),
        {
          role: "linkedin_intern" as const,
          instanceId: "aaaaaaaa-0000-4000-8000-000000000000",
          displayName: "Lyra",
          status: "active",
          hasTargeting: true,
          replySendEnabled: false,
        },
      ],
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(stateOf(plan, "hire")).toBe("done");
    expect(stateOf(plan, "targeting")).toBe("done");
    // Deep links must point at Lyra, never at the placeholder.
    expect(plan.steps.find((v) => v.step.id === "activate")!.href).toBe(`/app/${ORG}/agents/lyra`);
  });
});

describe("buildGuidedPlan — data source on the shared fallback token", () => {
  test("explains why leads arrive with no token of your own", () => {
    // Workers fall back to the shared env/SM token when the in-use pool is empty,
    // so "no token" and "no leads" are not the same thing. Don't just nag.
    const s: GuidedSignals = {
      ...emptySignals(),
      hasApifyToken: false,
      discoveredAny: true,
      agents: [withVega({ status: "active", hasTargeting: true })],
    };
    const plan = buildGuidedPlan(s, ORG);
    const ds = plan.steps.find((v) => v.step.id === "data-source")!;
    expect(ds.state).toBe("current");
    expect(ds.reason).toMatch(/shared fallback|capped/i);
  });

  test("no note before anything has been discovered", () => {
    const plan = buildGuidedPlan(emptySignals(), ORG);
    expect(plan.steps.find((v) => v.step.id === "data-source")!.reason).toBeNull();
  });

  test("no note once the org has its own live token", () => {
    const s = { ...emptySignals(), hasApifyToken: true, discoveredAny: true };
    const ds = buildGuidedPlan(s, ORG).steps.find((v) => v.step.id === "data-source")!;
    expect(ds.state).toBe("done");
    expect(ds.reason).toBeNull();
  });
});

describe("buildGuidedPlan — progress accounting", () => {
  test("only required steps count toward progress", () => {
    const plan = buildGuidedPlan(emptySignals(), ORG);
    const required = GUIDED_STEPS.filter((s) => s.tier === "required");
    expect(plan.requiredTotal).toBe(required.length);
    expect(plan.requiredTotal).toBeGreaterThan(0);
  });

  test("finishing the recommended vault step does not change required progress", () => {
    const a = buildGuidedPlan(emptySignals(), ORG);
    const b = buildGuidedPlan({ ...emptySignals(), vaultStage: "light" }, ORG);
    expect(b.requiredDone).toBe(a.requiredDone);
    expect(stateOf(b, "voice")).toBe("done");
  });

  test("complete only when every required step is done, ignoring advanced", () => {
    const s: GuidedSignals = {
      vaultStage: "rich",
      hasApifyToken: true,
      discoveredAny: false,
      agents: [withVega({ status: "active", hasTargeting: true })],
      draftedAny: true,
      pendingApprovals: 0,
      actionedAny: true,
      xPostingReady: false,
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(plan.complete).toBe(true);
    // `publishing` is advanced and still incomplete — that must not block completion.
    expect(stateOf(plan, "publishing")).not.toBe("done");
  });
});

describe("buildGuidedPlan — publishing is X-only and advanced", () => {
  test("blocked without an X intern", () => {
    const s = {
      ...emptySignals(),
      agents: [
        {
          role: "linkedin_intern" as const,
          instanceId: "aaaaaaaa-0000-4000-8000-000000000000",
          displayName: "Lyra",
          status: "active",
          hasTargeting: true,
          replySendEnabled: false,
        },
      ],
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(stateOf(plan, "publishing")).toBe("blocked");
    expect(plan.steps.find((s) => s.step.id === "publishing")!.reason).toMatch(/vega|x intern/i);
  });

  test("done when creds exist and reply sending is switched on", () => {
    const s = {
      ...emptySignals(),
      agents: [withVega({ status: "active", hasTargeting: true, replySendEnabled: true })],
      xPostingReady: true,
    };
    expect(stateOf(buildGuidedPlan(s, ORG), "publishing")).toBe("done");
  });

  test("not done when the kill switch is off, even with creds", () => {
    const s = {
      ...emptySignals(),
      agents: [withVega({ status: "active", replySendEnabled: false })],
      xPostingReady: true,
    };
    expect(stateOf(buildGuidedPlan(s, ORG), "publishing")).not.toBe("done");
  });

  test("sending on but no visible creds explains that cookies live outside the DB", () => {
    // X session cookies (ct0/auth_token) are read from the runtime env, never a
    // noelle.* row — so this must not read as "you forgot to connect X".
    const s = {
      ...emptySignals(),
      agents: [withVega({ status: "active", replySendEnabled: true })],
      xPostingReady: false,
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(stateOf(plan, "publishing")).toBe("waiting");
    expect(plan.steps.find((v) => v.step.id === "publishing")!.reason).toMatch(/cookies/i);
  });
});

describe("buildGuidedPlan — hrefs", () => {
  test("every step resolves to a route under the org", () => {
    const plan = buildGuidedPlan(emptySignals(), ORG);
    for (const view of plan.steps) {
      expect(view.href.startsWith(`/app/${ORG}`)).toBe(true);
    }
  });

  test("targeting and activate point at the hired intern", () => {
    const s = { ...emptySignals(), agents: [withVega()] };
    const plan = buildGuidedPlan(s, ORG);
    const targeting = plan.steps.find((v) => v.step.id === "targeting")!;
    expect(targeting.href).toBe(`/app/${ORG}/agents/${withVega().instanceId}/watchlist`);
    const activate = plan.steps.find((v) => v.step.id === "activate")!;
    expect(activate.href).toBe(`/app/${ORG}/agents/vega`);
  });
});

describe("buildGuidedPlan — Orion caveat", () => {
  test("a Reddit role does not claim the runtime is missing", () => {
    const s = {
      ...emptySignals(),
      agents: [
        {
          role: "reddit_intern" as const,
          instanceId: "bbbbbbbb-0000-4000-8000-000000000000",
          displayName: "Orion",
          status: "active",
          hasTargeting: true,
          replySendEnabled: false,
        },
      ],
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(plan.caveats).toEqual([]);
  });

  test("no caveats for a plain Vega org", () => {
    const s = { ...emptySignals(), agents: [withVega()] };
    expect(buildGuidedPlan(s, ORG).caveats).toEqual([]);
  });
});

describe("buildGuidedPlan — status line", () => {
  test("tells a fresh org what to do first", () => {
    expect(buildGuidedPlan(emptySignals(), ORG).status).toMatch(/apify|parked/i);
  });

  test("an advanced step's waiting note never hijacks the current required step", () => {
    // Vega hired with reply-sending on, but no Apify token yet. `publishing`
    // (advanced) is waiting; `data-source` (required) is current. The operator
    // must be told to add a token, not read a note about X cookies.
    const s: GuidedSignals = {
      ...emptySignals(),
      hasApifyToken: false,
      discoveredAny: false,
      agents: [withVega({ status: "active", replySendEnabled: true })],
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(plan.currentId).toBe("data-source");
    expect(stateOf(plan, "publishing")).toBe("waiting");
    expect(plan.status).not.toMatch(/cookies/i);
    expect(plan.status).toMatch(/apify|parked/i);
  });

  test("a required step's waiting note does surface when nothing is actionable", () => {
    const s: GuidedSignals = {
      ...emptySignals(),
      hasApifyToken: true,
      discoveredAny: false,
      agents: [withVega({ status: "active", hasTargeting: true })],
    };
    const plan = buildGuidedPlan(s, ORG);
    expect(plan.currentId).toBeNull();
    expect(plan.status).toMatch(/discovering|poll cycle/i);
  });
