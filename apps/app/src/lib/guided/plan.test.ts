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
