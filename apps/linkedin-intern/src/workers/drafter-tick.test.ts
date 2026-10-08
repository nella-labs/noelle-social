import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDrafterTick, decideOpus, buildStyleSource } from "./drafter-tick.js";
import { BudgetExceededError, createFormVariantRotation, GENZ_MARKERS } from "@noelle/runtime";
import * as runtime from "@noelle/runtime";
import { withMeteredApifyCall } from "@noelle/runtime/apify-metering";

describe("buildStyleSource", () => {
  const ex = (accountHandle: string) => ({ accountHandle, body: "x", likeCount: 0, commentCount: 0 });

  it("returns null when there is no style selection (base voice only)", () => {
    expect(buildStyleSource(null)).toBeNull();
    expect(buildStyleSource({ exemplars: [], styleNotes: "" })).toBeNull();
  });

  it("weights a lone source at 1.0", () => {
    expect(buildStyleSource({ exemplars: [ex("kaia"), ex("kaia")], styleNotes: "" })).toEqual({
      blend: [{ handle: "kaia", weight: 1 }],
    });
  });

  it("splits the blend by each account's share of the chosen exemplars, sorted desc", () => {
    const out = buildStyleSource({
      exemplars: [ex("kaia"), ex("kaia"), ex("kaia"), ex("devon")],
      styleNotes: "",
    });
    expect(out).toEqual({
      blend: [
        { handle: "kaia", weight: 0.75 },
        { handle: "devon", weight: 0.25 },
      ],
    });
  });

  it("ignores blank handles", () => {
    expect(buildStyleSource({ exemplars: [ex("kaia"), ex("  ")], styleNotes: "" })).toEqual({
      blend: [{ handle: "kaia", weight: 1 }],
    });
  });
});

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

const anchorHit = (score: number) => ({
  path: "p.md",
  snippet: "anchor",
  score,
  filePath: "p.md",
  startLine: 1,
  endLine: 1,
  highlights: [],
});

// All three angles + a DM — the model returns the full set; the tick keeps only
// the angles the tier allows and the DM only for T1.
const fullSubstantial = {
  drafts: [
    { angle: "empathetic", body: "e", char_count: 1 },
    { angle: "technical", body: "t", char_count: 1 },
    { angle: "contrarian", body: "c", char_count: 1 },
  ],
  dm: { body: "x".repeat(500), char_count: 500 },
};

const oneLight = {
  drafts: [{ angle: "empathetic", body: "congrats on the launch, the demo looked sharp", char_count: 45 }],
};

const leadPayload = {
  text: "post text",
  url: "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/",
  authorName: "Jane",
  authorHeadline: "Founder",
  authorPublicId: "jane-builder",
};

const lead = (over: Record<string, unknown> = {}) => ({
  id: "L",
  external_id: "7000000000000000001",
  payload: { ...leadPayload },
  author_handle: "jane-builder",
  author_id: "ABC123",
  status: "drafting",
  tier: "T1",
  classifier_label: "substantial",
  classifier_score: 92,
  priority: false,
  ...over,
});

describe("LinkedIn saved factual context", () => {
  const fact = "Oriole maps Atlas dependency graphs";
  it.each(["light", "substantial"])("saves the %s review facts through repair and retained-body review", async kind => {
    const { runner, postOutbound, markStatus } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify({ drafts: [
      { angle: "empathetic", body: fact }, { angle: "technical", body: "Atlas graph inspection matters" },
    ] }), engine: "fixture", model: "fixture" });
    let reviews = 0;
    const judge = vi.fn(async (_system: string, _prompt: string) => JSON.stringify({ voice: ++reviews === 1 ? 0.3 : 0.9, grounding: 0.9, relevance: 0.9, reasons: [] }));
    const captionFn = vi.fn().mockResolvedValue("A measured Atlas graph");
    const kb = { search: vi.fn(async (_query: string, _limit: number, options?: { filterDirs?: string[] }) => [{ ...anchorHit(8),
      snippet: options?.filterDirs?.includes("product") ? fact : "Plain spoken" }]) };
    vi.stubEnv("TYPESAFE_API_KEY", ""); vi.stubEnv("AI_GATEWAY_API_KEY", "");
    try {
      await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ tier: "T2", classifier_label: kind, payload: { ...leadPayload,
          authorName: "Casey", authorHeadline: "Builds Atlas", images: ["https://image.test/graph.jpg"] } })] as never,
        runner, kb: kb as never, captionFn, postOutbound, markStatus, knowledgeDirs: ["product"],
        verify: { enabled: true, retries: 1, makeCalls: () => [judge] } });
      const rows = postOutbound.mock.calls[0]![0].drafts;
      for (const row of rows) {
        expect(row.reviewContext).toMatchObject({ version: 1, platform: "linkedin", postText: "post text", knowledgeAnchors: [fact] });
        expect(row.reviewContext.personProfile).toBe("Name: Casey\nHeadline: Builds Atlas");
        expect(row.reviewContext.imageCaption).toBe("A measured Atlas graph");
        expect(row.reviewContext).not.toHaveProperty("operatorFacts");
        expect(row.reviewContext).not.toHaveProperty("conversation");
      }
      expect(runner.draft).toHaveBeenCalledTimes(2);
      expect(judge.mock.calls.length).toBe(kind === "light" ? 2 : 4);
      expect(captionFn).toHaveBeenCalledOnce();
      for (const [, prompt] of judge.mock.calls) {
        const evidence = prompt.split("DRAFTS TO GRADE")[0]!;
        expect(evidence).toContain(fact);
        expect(evidence).toContain("Name: Casey");
        expect(evidence).toContain("A measured Atlas graph");
      }
    } finally { vi.unstubAllEnvs(); }
  });

  it("reports excessive facts without handoff or hiding the failure as a judge outage", async () => {
    const { runner, postOutbound, markStatus } = deps();
    const kb = { search: vi.fn(async (_query: string, _limit: number, options?: { filterDirs?: string[] }) => [{ ...anchorHit(8),
      snippet: options?.filterDirs?.includes("product") ? "k".repeat(8_001) : "Plain spoken" }]) };
    const judge = vi.fn(async () => JSON.stringify({ voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [] }));
    await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never, claimedLeads: [lead({ tier: "T3" })] as never,
      runner, kb: kb as never, postOutbound, markStatus, knowledgeDirs: ["product"],
      verify: { enabled: true, retries: 0, makeCalls: () => [judge] } });
    expect(postOutbound).not.toHaveBeenCalled();
    expect(judge).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ leadId: "L", status: "errored" }));
  });
});

function deps(over: Record<string, unknown> = {}) {
  const postOutbound = vi.fn().mockResolvedValue({ id: "a", approval_id: "a" });
  const runner = {
    draft: vi.fn().mockResolvedValue({ text: JSON.stringify(fullSubstantial), engine: "bedrock", model: "claude-sonnet-4-6" }),
  };
  const kb = { search: vi.fn().mockResolvedValue([anchorHit(8.0)]) };
  const markStatus = vi.fn().mockResolvedValue(undefined);
  return { postOutbound, runner, kb, markStatus, ...over };
}

describe("runDrafterTick (linkedin quality pipeline)", () => {
  it.each(["substantial", "light"])("preserves measured and unknown source time for %s replies", async (kind) => {
    for (const postedAt of [undefined, null, "", "2026-02-30T00:00:00Z", "2026-10-01T12:34:56.000Z"]) {
      const { postOutbound, runner, kb, markStatus } = deps();
      runner.draft.mockResolvedValue({ text: JSON.stringify(kind === "light" ? oneLight : fullSubstantial),
        engine: "bedrock", model: "claude-sonnet-4-6" });
      await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ classifier_label: kind, payload: { ...leadPayload, posted_at: postedAt } })] as never,
        runner, kb: kb as never, postOutbound, markStatus });
      expect(postOutbound).toHaveBeenCalledTimes(1);
      expect(postOutbound.mock.calls[0]![0].postedAt).toBe(postedAt === "2026-10-01T12:34:56.000Z" ? postedAt : null);
    }
  });

  it.each([false, true])("reviews only prepared retained substantial candidates (repair=%s)", async (repair) => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const response = (label: string) => ({ text: JSON.stringify({ drafts: [
      { angle: "empathetic", body: `${label} reply 💀` },
      { angle: "technical", body: "Unused technical companion" },
      { angle: "empathetic", body: "Unused duplicate companion" },
    ], dm: { body: "Unused DM companion" } }), engine: label, model: `${label}-model` });
    runner.draft.mockResolvedValueOnce(response("Original")).mockResolvedValue(response("Repair"));
    const verdict = (pass: boolean) => ({
      pass, judgeOk: true, judgeProvider: "legacy" as const, reasons: [], fix: "narrow the claim",
      scores: { voice: pass ? 0.9 : 0.4, grounding: 0.9, relevance: 0.9, format: 1, novelty: 1, diversity: 1 },
    });
    const review = vi.spyOn(runtime, "verifyTiered").mockResolvedValueOnce(verdict(!repair)).mockResolvedValue(verdict(true));
    try {
      await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ tier: "T3" })] as never,
        runner, kb: kb as never, postOutbound, markStatus,
        verify: { enabled: true, retries: 1, makeCalls: () => [vi.fn()] },
      });
      for (const [drafts] of review.mock.calls) {
        expect(drafts).toHaveLength(1);
        expect(drafts[0]).toMatchObject({ kind: "reply", angle: "empathetic" });
        expect(drafts[0]!.body).not.toMatch(/💀|Unused/);
      }
      const saved = postOutbound.mock.calls[0]![0].drafts[0];
      expect(review.mock.calls.at(-1)![0][0]!.body).toBe(saved.body);
      const selected = repair ? "Repair" : "Original";
      expect(saved.body).toBe(`${selected} reply`);
      expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({
        status: "drafted", meta: expect.objectContaining({ engine: selected, model: `${selected}-model` }),
      }));
    } finally { review.mockRestore(); }
  });

  it("does not request or judge a T1 companion DM when auto-DM is disabled", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const review = vi.spyOn(runtime, "verifyTiered").mockResolvedValue({
      pass: true, judgeOk: true, judgeProvider: "legacy", reasons: [], fix: null,
      scores: { voice: 1, grounding: 1, relevance: 1, format: 1, novelty: 1, diversity: 1 },
    });
    try {
      await runDrafterTick({ log, instance: { id: "i", org_id: "o", dm_autodraft_enabled: false } as never,
        claimedLeads: [lead({ tier: "T1" })] as never,
        runner, kb: kb as never, postOutbound, markStatus,
        verify: { enabled: true, retries: 0, makeCalls: () => [vi.fn()] },
      });
      expect(review.mock.calls.every(([drafts]) => drafts.every((draft) => draft.kind === "reply"))).toBe(true);
      expect(postOutbound.mock.calls[0]![0].drafts.every((draft: { kind: string }) => draft.kind === "reply")).toBe(true);
      expect(runner.draft.mock.calls[0]![0].prompt).toMatch(/do not include.*dm/i);
    } finally { review.mockRestore(); }
  });

  it("reviews only the cleaned selected light reply and its normalized angle", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify({ drafts: [
      { angle: "supportive", body: "First reply 💀" },
      { angle: "technical", body: "Unused companion" },
    ] }), engine: "writer", model: "model" });
    const review = vi.spyOn(runtime, "verifyTiered").mockResolvedValue({
      pass: true, judgeOk: true, judgeProvider: "legacy", reasons: [], fix: null,
      scores: { voice: 1, grounding: 1, relevance: 1, format: 1, novelty: 1, diversity: 1 },
    });
    try {
      await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ classifier_label: "light", tier: null })] as never,
        runner, kb: kb as never, postOutbound, markStatus,
        verify: { enabled: true, retries: 0, makeCalls: () => [vi.fn()] },
      });
      const queued = postOutbound.mock.calls[0]![0].drafts[0];
      expect(queued).toMatchObject({ body: "First reply", angle: "empathetic" });
      expect(review.mock.calls[0]![0]).toEqual([{ kind: "reply", angle: queued.angle, body: queued.body }]);
    } finally { review.mockRestore(); }
  });

  it("drops a committing light reply before it reaches outbound", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify({ drafts: [
      { angle: "empathetic", body: "I'll send you the demo tomorrow" },
    ] }), engine: "writer", model: "model" });
    expect(await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null })] as never,
      runner, kb: kb as never, postOutbound, markStatus,
    })).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "skipped" }));
  });

  it("keeps good replies when the companion DM fails its own bounded voice check", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify({ ...fullSubstantial, dm: { body: "Curious how you chose this tool?" } }), engine: "bedrock", model: "m" });
    expect(await runDrafterTick({ log, instance: { id: "i", org_id: "o", dm_autodraft_enabled: true } as never, claimedLeads: [lead()] as never, runner: runner as never, kb: kb as never, postOutbound, markStatus })).toBe(1);
    expect(runner.draft).toHaveBeenCalledTimes(2);
    const rows = postOutbound.mock.calls[0]![0].drafts;
    expect(rows.filter((row: { kind: string }) => row.kind === "reply")).toHaveLength(3);
    expect(rows.filter((row: { kind: string }) => row.kind === "dm")).toHaveLength(0);
  });

  it("T1 substantial with auto-DM ON: 3 comment angles + 1 DM", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const n = await runDrafterTick({
      log,
      // Auto-DM is opt-in (0036) — enable it to exercise the DM path.
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: true } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.platform).toBe("linkedin");
    const replies = body.drafts.filter((d: { kind: string }) => d.kind === "reply");
    const dms = body.drafts.filter((d: { kind: string }) => d.kind === "dm");
    expect(replies).toHaveLength(3);
    expect(replies.map((r: { angle: string }) => r.angle)).toEqual(["empathetic", "technical", "contrarian"]);
    expect(dms).toHaveLength(1);
    expect(dms[0].dmVoiceCheck).toEqual({ pass: true, attempts: 0, reasons: [] });
  });

  it("T1 with auto-DM OFF (default): 3 comment angles, NO DM", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      // dm_autodraft_enabled absent → opt-in default off → replies only.
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    const body = postOutbound.mock.calls[0]![0];
    const replies = body.drafts.filter((d: { kind: string }) => d.kind === "reply");
    const dms = body.drafts.filter((d: { kind: string }) => d.kind === "dm");
    expect(replies).toHaveLength(3);
    expect(dms).toHaveLength(0);
  });

  it("drafts an operator-requested reply with guidance and review tags while bypassing ordinary gates", async () => {
    const orgId = "11111111-1111-4111-8111-111111111111";
    const agentInstanceId = "33333333-3333-4333-8333-333333333333";
    const { postOutbound, runner, kb, markStatus } = deps();
    kb.search.mockResolvedValue([{ snippet: "anchor", score: 0.1, filePath: "p.md", startLine: 1, endLine: 1, highlights: [] }]);
    const pinNotification = vi.fn();

    const n = await runDrafterTick({
      log,
      instance: { id: agentInstanceId, org_id: orgId } as never,
      claimedLeads: [lead({ classifier_label: "light", classifier_score: 0, payload: { text: "thanks!", url: "https://www.linkedin.com/feed/update/urn:li:activity:123/", source: "notification", authorPublicId: "ada", reply_request: { request_key: "manual-li", instructions: "ask about the database constraint", force_human_review: true } } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      pinNotification,
      relevanceThreshold: 99,
      dailyLightCap: 0,
    });

    expect(n).toBe(1);
    expect(pinNotification).not.toHaveBeenCalled();
    expect(runner.draft.mock.calls[0]![0].prompt).toContain("ask about the database constraint");
    const outbound = postOutbound.mock.calls[0]![0];
    expect(outbound.owner).toEqual({ orgId, agentInstanceId });
    expect(outbound.replyRequestKey).toBe("manual-li");
    expect(outbound.humanReviewRequired).toBe(true);
    expect(outbound.drafts.every((d: { kind: string }) => d.kind === "reply")).toBe(true);
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "drafted", meta: expect.objectContaining({ reply_request_key: "manual-li" }) }));
  });

  it("watchlist (priority) lead with low engagement drafts on the default model (sonnet), NOT Opus", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T2", priority: true })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    // Priority/watchlist no longer forces Opus — only reaction-based tiering does.
    expect(runner.draft.mock.calls[0]![0].routing.primary.model).toBe("claude-sonnet-4-6");
  });

  it("low-engagement lead drafts on the default model (sonnet)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T2", priority: false })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    // DEFAULT_ROUTING.primary is sonnet — the everyday draft model. Opus is
    // reserved for genuinely high-engagement leads via reaction tiering.
    expect(runner.draft.mock.calls[0]![0].routing.primary.model).toBe("claude-sonnet-4-6");
  });

  it("T2 substantial: 2 comment angles (empathetic, technical), NO DM", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T2", classifier_score: 85 })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const body = postOutbound.mock.calls[0]![0];
    const replies = body.drafts.filter((d: { kind: string }) => d.kind === "reply");
    const dms = body.drafts.filter((d: { kind: string }) => d.kind === "dm");
    expect(replies.map((r: { angle: string }) => r.angle)).toEqual(["empathetic", "technical"]);
    expect(dms).toHaveLength(0);
  });

  it("T3 substantial: 1 comment angle (empathetic), NO DM", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T3", classifier_score: 77 })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const body = postOutbound.mock.calls[0]![0];
    const replies = body.drafts.filter((d: { kind: string }) => d.kind === "reply");
    const dms = body.drafts.filter((d: { kind: string }) => d.kind === "dm");
    expect(replies.map((r: { angle: string }) => r.angle)).toEqual(["empathetic"]);
    expect(dms).toHaveLength(0);
  });

  // Regression (2026-07-19: 14/37 leads lost in one run): the model often omits
  // `char_count` or emits it at the top level instead of inside each draft. The
  // count is recomputed off the cleaned body before anything ships, so a missing
  // count must never error a lead that has a perfectly good body.
  it("substantial WITHOUT char_count still drafts (count recomputed from body)", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const text = "two teams pitched an agent and one shipped a RAG in six hours, wild";
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "empathetic", body: text }] }),
        engine: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T3", classifier_score: 77 })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].body).toBe(text);
    expect(body.drafts[0].charCount).toBe([...text].length);
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ leadId: "L", status: "drafted" }));
  });

  it("substantial with char_count at the TOP level (wrong spot) still drafts", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "solid launch" }], char_count: 12 }),
        engine: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T3", classifier_score: 77 })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
  });

  it("substantial with null / string char_count still drafts (garbage tolerated)", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "solid launch", char_count: null },
            { angle: "technical", body: "the RAG angle is the sharp part", char_count: "31" },
          ],
        }),
        engine: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T2", classifier_score: 85 })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const replies = postOutbound.mock.calls[0]![0].drafts.filter((d: { kind: string }) => d.kind === "reply");
    expect(replies).toHaveLength(2);
    expect(replies[0].charCount).toBe([..."solid launch"].length);
    expect(replies[1].charCount).toBe([..."the RAG angle is the sharp part"].length);
  });

  it("T1 with a DM missing char_count still drafts all rows", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "e" },
            { angle: "technical", body: "t" },
            { angle: "contrarian", body: "c" },
          ],
          dm: { body: "x".repeat(500) },
        }),
        engine: "claude-cli",
        model: "claude-opus-4-6",
      }),
    };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: true } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts.filter((d: { kind: string }) => d.kind === "reply")).toHaveLength(3);
    const dm = body.drafts.find((d: { kind: string }) => d.kind === "dm");
    expect(dm.charCount).toBe(500);
  });

  it("light WITHOUT char_count still drafts", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const text = "congrats, the demo looked sharp";
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({ drafts: [{ angle: "empathetic", body: text }] }),
        engine: "claude-cli",
        model: "claude-haiku-4-5",
      }),
    };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null, classifier_score: 60 })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    expect(postOutbound.mock.calls[0]![0].drafts[0].charCount).toBe([...text].length);
  });

  it("light: ONE short supportive reply (kind='reply'), NO DM", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null, classifier_score: 60 })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.drafts).toHaveLength(1);
    expect(body.drafts[0].kind).toBe("reply");
    expect(body.drafts.some((d: { kind: string }) => d.kind === "dm")).toBe(false);
    // It used the LIGHT system prompt (no pitch / celebrate variant).
    expect(runner.draft.mock.calls[0]![0].system).toContain("supportive");
  });

  it("light leads bypass the relevance threshold (a congrats needs no anchor)", async () => {
    const { postOutbound, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    const kb = { search: vi.fn().mockResolvedValue([anchorHit(0.1)]) };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });
    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
  });

  // Vault relevance gates cold outbound. Conversation notifications bypass
  // that gate because they already concern a reply to the operator.
  it("a NOTIFICATION lead bypasses the relevance gate — a reply to us is not a stranger", async () => {
    const { postOutbound, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    // The fixture score remains well below the cold-outbound threshold.
    const kb = { search: vi.fn().mockResolvedValue([anchorHit(0.1)]) };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({
          tier: "T1",
          priority: true,
          payload: {
            ...leadPayload,
            source: "notification",
            // Must be something the notification TRIAGE answers, or it is
            // dropped upstream of the relevance gate and this test proves
            // nothing. A real question from a real person.
            text: "how do you handle the case where the agent never sees the dependency drift?",
          },
        }),
      ] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });
    expect(n).toBe(1);
    expect(postOutbound).toHaveBeenCalledTimes(1);
    expect(markStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ relevance_threshold: 1.5 }) }),
    );
  });

  // The exemption is keyed on SOURCE, not on `lead.priority`, because on
  // LinkedIn essentially every lead is priority=true — profile_search, keyword
  // and discovery all set it. Keying on priority would have switched the
  // relevance gate off for the entire pipeline (1,340 non-notification priority
  // leads in 14 days vs 17 notification ones) and flooded the queue with
  // low-relevance cold outbound. This is the test that pins that distinction.
  // "is weirdly making responses like one that starts" — Lyra had NO thread
  // context at all (X built a <thread_context> block; LinkedIn built nothing),
  // so it answered people mid-conversation as if commenting cold on a post.
  it("a notification lead's prompt carries the CONVERSATION, not just the post", async () => {
    const { postOutbound, markStatus } = deps();
    const draft = vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" });
    const kb = { search: vi.fn().mockResolvedValue([anchorHit(9)]) };
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({
          tier: "T1",
          priority: true,
          payload: {
            ...leadPayload,
            source: "notification",
            text: "how do you handle the case where the agent never sees the dependency drift?",
            conversation: {
              root_post_text: "shipping fast is a process problem, not a tooling one",
              our_reply_text: "only if you ship rarely - the loop is what makes it safe",
            },
          },
        }),
      ] as never,
      runner: { draft } as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });
    expect(draft).toHaveBeenCalled();
    const prompt: string = draft.mock.calls[0]![0].prompt;
    expect(prompt).toContain("NOT a cold lead");
    expect(prompt).toContain("shipping fast is a process problem");
    expect(prompt).toContain("only if you ship rarely");
    // ...and it comes FIRST, before the post, so the model frames the whole
    // thing as a continuation rather than a cold comment.
    expect(prompt.indexOf("NOT a cold lead")).toBeLessThan(prompt.indexOf("LinkedIn post by"));
  });

  it("a COLD lead's prompt is unchanged - no conversation block", async () => {
    const { postOutbound, markStatus } = deps();
    const draft = vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" });
    const kb = { search: vi.fn().mockResolvedValue([anchorHit(9)]) };
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: { draft } as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });
    expect(draft.mock.calls[0]![0].prompt).not.toContain("NOT a cold lead");
  });

  // Conversation replies below the voice floor still reach human review.
  // Dropping them would mark notifications handled without an approval row.
  it("a conversation reply below the voice floor is SERVED, never dropped", async () => {
    const { postOutbound, markStatus } = deps();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify(oneLight),
        engine: "bedrock",
        model: "m",
        }),
    };
    const kb = { search: vi.fn().mockResolvedValue([anchorHit(9)]) };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({
          tier: "T1",
          priority: true,
          payload: {
            ...leadPayload,
            source: "notification",
            text: "how do you handle the case where the agent never sees the dependency drift?",
          },
        }),
      ] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
      // A floor high enough that any verdict fails it.
      verify: { enabled: true, retries: 0, voiceFloor: 0.99, makeCalls: () => [] },
    } as never);
    // It must NOT have been skipped for low voice.
    expect(markStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ meta: expect.objectContaining({ skip_reason: "low-voice" }) }),
    );
    expect(n).toBeGreaterThan(0);
  });

  it("a PRIORITY lead that is NOT a notification is still gated", async () => {
    const { postOutbound, markStatus } = deps();
    const draft = vi.fn();
    const kb = { search: vi.fn().mockResolvedValue([anchorHit(0.1)]) };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      // Exactly how a profile_search / keyword lead arrives.
      claimedLeads: [lead({ tier: "T1", priority: true })] as never,
      runner: { draft } as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });
    expect(n).toBe(0);
    expect(draft).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "skipped",
        meta: expect.objectContaining({ relevance_threshold: 1.5 }),
      }),
    );
  });

  it("substantial lead below the relevance threshold is skipped without an LLM call", async () => {
    const { postOutbound, markStatus } = deps();
    const draft = vi.fn();
    const kb = { search: vi.fn().mockResolvedValue([anchorHit(0.1)]) };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: { draft } as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      relevanceThreshold: 1.5,
    });
    expect(n).toBe(0);
    expect(draft).not.toHaveBeenCalled();
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(
      expect.objectContaining({ status: "skipped", meta: expect.objectContaining({ relevance_threshold: 1.5 }) }),
    );
  });

  it("NEVER includes an autoSend field on the outbound payload (draft-only invariant)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      // auto_send_enabled has no meaning for Lyra; even if a stray flag were set,
      // the drafter must never stamp an autoSend block.
      instance: { id: "i", org_id: "o", auto_send_enabled: true } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    const body = postOutbound.mock.calls[0]![0];
    expect(body.autoSend).toBeUndefined();
