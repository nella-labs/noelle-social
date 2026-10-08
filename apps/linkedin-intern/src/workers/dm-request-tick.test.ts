import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { runDmRequestTick } from "./drafter-tick.js";
import { buildLadderDmSystem } from "../lib/prompts.js";
import { pickRung } from "../lib/dm-ladder.js";

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;
const instance = { id: "i", org_id: "o", brand_config: null, model_overrides: null } as never;

// Fake `sql`: the count query reads `.n`; the prior-DM query reads `.body`
// (absent here → []). So returning [{ n }] sets sentCount = n and priorDms = [].
function fakeSql(sentCount: number): Sql {
  return ((_s: TemplateStringsArray, ..._v: unknown[]) =>
    Promise.resolve([{ n: sentCount }])) as unknown as Sql;
}

const dmBody =
  "six months for closed-loop force control is no joke\n\nwhat fought back hardest, the actuator or the controller?";
const dmOut = JSON.stringify({ body: dmBody, char_count: dmBody.length });

function lead(over: Record<string, unknown> = {}) {
  return {
    id: "lead-1",
    external_id: "ext-1",
    payload: {
      text: "we shipped closed-loop force control this week",
      authorName: "Kaia Tham",
      authorPublicId: "kaia-tham",
      authorHeadline: "Founder @ Loom Robotics",
    },
    author_handle: "kaia-tham",
    author_id: "fsd-1",
    tier: null,
    classifier_label: null,
    classifier_score: null,
    status: "new",
    priority: false,
    ...over,
  } as never;
}

function deps() {
  const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
  const runner = {
    draft: vi.fn().mockResolvedValue({ text: dmOut, engine: "bedrock", model: "claude-sonnet-4-6" }),
  };
  return { postOutbound, runner };
}

describe("runDmRequestTick (DM ladder)", () => {
  it.each([true, false])("reviews the requested DM itself; clean rewrite=%s", async (cleanRewrite) => {
    const { postOutbound, runner } = deps();
    const bad = JSON.stringify({ body: "Curious how you chose the controller?" });
    runner.draft.mockResolvedValue({ text: bad, engine: "bedrock", model: "m" });
    if (cleanRewrite) runner.draft.mockResolvedValueOnce({ text: bad, engine: "bedrock", model: "m" })
      .mockResolvedValue({ text: dmOut, engine: "bedrock", model: "m" });
    const count = await runDmRequestTick({ log, instance, claimedLeads: [lead()], runner: runner as never, postOutbound, sql: fakeSql(0) });
    expect(runner.draft).toHaveBeenCalledTimes(2);
    expect(count).toBe(cleanRewrite ? 1 : 0);
    if (cleanRewrite) expect(postOutbound.mock.calls[0]![0].drafts[0]).toMatchObject({ body: dmBody, dmVoiceCheck: { pass: true, attempts: 1, reasons: [] } });
    else expect(postOutbound).not.toHaveBeenCalled();
  });

  it("drafts rung 1 (Open) for a person with 0 sent DMs, and forbids a call", async () => {
    const { postOutbound, runner } = deps();
    const n = await runDmRequestTick({
      log,
      instance,
      claimedLeads: [lead()],
      runner: runner as never,
      postOutbound,
      sql: fakeSql(0),
    });
    expect(n).toBe(1);
    expect(runner.draft).toHaveBeenCalledTimes(1);
    const sys = runner.draft.mock.calls[0]![0].system;
    expect(sys).toBe(buildLadderDmSystem(pickRung(0)));
    expect(sys).toContain('rung 1 of 4 — "Open"');
    expect(sys).toMatch(/Do NOT propose a call/i);
    const out = postOutbound.mock.calls[0]![0];
    expect(out.drafts).toHaveLength(1);
    expect(out.drafts[0].kind).toBe("dm");
    expect(out.drafts[0].angle).toBeNull();
    expect(out.drafts[0].dmVoiceCheck).toEqual({ pass: true, attempts: 0, reasons: [] });
  });

  it("advances to rung 4 (Invite) at 3 sent DMs and allows a low-pressure call", async () => {
    const { postOutbound, runner } = deps();
    await runDmRequestTick({
      log,
      instance,
      claimedLeads: [lead()],
      runner: runner as never,
      postOutbound,
      sql: fakeSql(3),
    });
    const sys = runner.draft.mock.calls[0]![0].system;
    expect(sys).toContain('rung 4 of 4 — "Invite"');
    expect(sys).toMatch(/You MAY propose ONE low-pressure/);
  });

  it("strips em-dashes from the drafted DM body", async () => {
    const { postOutbound, runner } = deps();
    runner.draft.mockResolvedValue({
      text: JSON.stringify({ body: "nice work — really sharp", char_count: 24 }),
      engine: "bedrock",
      model: "m",
    });
    await runDmRequestTick({
      log,
      instance,
      claimedLeads: [lead()],
      runner: runner as never,
      postOutbound,
      sql: fakeSql(0),
    });
    expect(postOutbound.mock.calls[0]![0].drafts[0].body).not.toContain("—");
  });

  it("skips a lead with no post text (no LLM call)", async () => {
    const { postOutbound, runner } = deps();
    const n = await runDmRequestTick({
      log,
      instance,
      claimedLeads: [lead({ payload: {} })],
      runner: runner as never,
      postOutbound,
      sql: fakeSql(0),
    });
    expect(n).toBe(0);
    expect(runner.draft).not.toHaveBeenCalled();
  });

  it("works without sql (starts at rung 1, no prior-DM lookup)", async () => {
    const { postOutbound, runner } = deps();
    const n = await runDmRequestTick({
      log,
      instance,
      claimedLeads: [lead()],
      runner: runner as never,
      postOutbound,
    });
    expect(n).toBe(1);
    expect(runner.draft.mock.calls[0]![0].system).toContain("rung 1 of 4");
  });

  it("accepts a DM even when the model omits char_count (it's recomputed anyway)", async () => {
    const { postOutbound, runner } = deps();
    runner.draft.mockResolvedValue({
      text: JSON.stringify({ body: "hey Kaia, six months for force control is wild. what fought back hardest?" }),
      engine: "bedrock",
      model: "m",
    });
    const n = await runDmRequestTick({
      log,
      instance,
      claimedLeads: [lead()],
      runner: runner as never,
      postOutbound,
      sql: fakeSql(0),
    });
    expect(n).toBe(1);
    expect(postOutbound.mock.calls[0]![0].drafts[0].kind).toBe("dm");
  });

  it("fails open per lead (a draft error doesn't throw or abort the tick)", async () => {
    const { postOutbound, runner } = deps();
    runner.draft.mockRejectedValue(new Error("engine down"));
    const n = await runDmRequestTick({
      log,
      instance,
      claimedLeads: [lead()],
      runner: runner as never,
      postOutbound,
      sql: fakeSql(0),
    });
    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
  });
});
