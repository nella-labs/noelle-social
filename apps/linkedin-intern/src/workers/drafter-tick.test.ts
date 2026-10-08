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
    expect("autoSend" in body).toBe(false);
  });

  it("enforces the daily SUBSTANTIAL cap: defers the lead to 'classified', does not draft", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const sqlCalls: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (_s: TemplateStringsArray, ...vals: unknown[]) => {
        sqlCalls.push(vals);
        return [];
      }),
      { json: (x: unknown) => x },
    );
    const n = await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", classifier_label: "substantial" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      dailySubstantialCap: 30,
      dailyLightCap: 20,
      // Already drafted 30 substantial today → cap reached.
      draftedTodayByKind: async (kind) => (kind === "substantial" ? 30 : 0),
      sql: sql as never,
    });

    expect(n).toBe(0);
    expect(runner.draft).not.toHaveBeenCalled();
    expect(postOutbound).not.toHaveBeenCalled();
    // The lead was re-set to 'classified' (deferred), not drafted/skipped.
    expect(sqlCalls.flat()).toContain("L");
  });

  it("enforces the daily LIGHT cap independently of the substantial cap", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    const sql = Object.assign(
      vi.fn(async () => []),
      { json: (x: unknown) => x },
    );
    const n = await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      dailySubstantialCap: 30,
      dailyLightCap: 20,
      // Substantial budget is wide open, but light is exhausted → defer.
      draftedTodayByKind: async (kind) => (kind === "light" ? 20 : 0),
      sql: sql as never,
    });

    expect(n).toBe(0);
    expect(runner.draft).not.toHaveBeenCalled();
    expect(postOutbound).not.toHaveBeenCalled();
  });

  it("draws down the daily budget within a tick: 2nd substantial lead is deferred when cap=1", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const sql = Object.assign(vi.fn(async () => []), { json: (x: unknown) => x });
    const n = await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({ id: "L1", external_id: "1", tier: "T3", classifier_score: 77 }),
        lead({ id: "L2", external_id: "2", tier: "T3", classifier_score: 77 }),
      ] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      dailySubstantialCap: 1,
      dailyLightCap: 20,
      draftedTodayByKind: async () => 0,
      sql: sql as never,
    });

    expect(n).toBe(1); // only the first lead drafted; second deferred.
    expect(postOutbound).toHaveBeenCalledTimes(1);
  });

  it("treats cap=0 as UNLIMITED, not as 'draft nothing'", async () => {
    // Regression guard. The defaults are 0 (= no daily cap). The destructuring
    // default in runDrafterTick only fires for `undefined`, so a raw 0 arriving
    // here must be normalized to unlimited — otherwise "remove the cap" would
    // invert into "defer every lead", silently starving the approval queue.
    const { postOutbound, runner, kb, markStatus } = deps();
    const sql = Object.assign(vi.fn(async () => []), { json: (x: unknown) => x });
    const n = await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({ id: "L1", external_id: "1", tier: "T3", classifier_score: 77 }),
        lead({ id: "L2", external_id: "2", tier: "T3", classifier_score: 77 }),
      ] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      dailySubstantialCap: 0,
      dailyLightCap: 0,
      // A big prior-day count must ALSO not re-impose a ceiling when uncapped.
      draftedTodayByKind: async () => 500,
      sql: sql as never,
    });

    expect(n).toBe(2);
    expect(postOutbound).toHaveBeenCalledTimes(2);
  });

  it("skips leads with empty post text", async () => {
    const { postOutbound, markStatus } = deps();
    const runner = { draft: vi.fn() };
    const kb = { search: vi.fn().mockResolvedValue([]) };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ payload: { text: "" } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith({ leadId: "L", status: "skipped", meta: { skip_reason: "empty post text" } });
  });

  it("marks lead errored when drafter output schema fails", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: "not valid json", engine: "bedrock", model: "m" }) };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    expect(n).toBe(0);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith({ leadId: "L", status: "errored", meta: { error: "schema" } });
  });

  it("DEFERS the lead (not errored) when the runner throws BudgetExceededError", async () => {
    // Budget exhaustion is a temporary, org-wide condition — the monthly cap
    // resets and the operator can raise it — so it is NOT a defect of the lead.
    // Marking it 'errored' stranded it permanently (recoverable only by a manual
    // requeue). It must go back to 'classified' so a later tick re-drafts it.
    const { postOutbound, kb, markStatus } = deps();
    const runner = {
      draft: vi.fn(async () => {
        throw new BudgetExceededError({ layer: "instance", spent_cents: 9999, cap_cents: 10000, estimated_cents: 200 });
      }),
    };
    const statements: string[] = [];
    const sqlValues: unknown[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: unknown, ...vals: unknown[]) => {
        statements.push((strings as string[] | undefined)?.join("?") ?? "");
        sqlValues.push(...vals);
        return [];
      }),
      { json: (x: unknown) => x },
    );
    await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      sql: sql as never,
    });

    expect(postOutbound).not.toHaveBeenCalled();
    // Never stranded as errored.
    expect(markStatus).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "errored" }),
    );
    // Deferred back to 'classified', stamped with the budget reason.
    const deferStmt = statements.find((s) => s.includes("status = 'classified'"));
    expect(deferStmt).toBeDefined();
    expect(sqlValues).toContain("L");
    expect(sqlValues).toContainEqual({ budget_deferred: "substantial" });
  });

  it("stamps a budget-deferred LIGHT lead with kind 'light'", async () => {
    // Covers the inner light branch of the single-call loop (light leads always
    // carry a precomputed ctx, so they are handled and `continue`d there).
    const { postOutbound, kb, markStatus } = deps();
    const runner = {
      draft: vi.fn(async () => {
        throw new BudgetExceededError({ layer: "instance", spent_cents: 9999, cap_cents: 10000, estimated_cents: 200 });
      }),
    };
    const sqlValues: unknown[] = [];
    const sql = Object.assign(
      vi.fn(async (_s: unknown, ...vals: unknown[]) => {
        sqlValues.push(...vals);
        return [];
      }),
      { json: (x: unknown) => x },
    );
    await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      sql: sql as never,
    });

    expect(sqlValues).toContainEqual({ budget_deferred: "light" });
    expect(markStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "errored" }));
  });

  it("stops paying for pre-draft gathering once the budget cap trips", async () => {
    // The spend cap is org-wide, so after the first BudgetExceededError every
    // remaining lead this tick would hit the same wall. The gathering that runs
    // BEFORE the model call is NOT free (vision caption + a metered Apify
    // comment fetch, and Apify is outside the LLM cap), and budget-deferred
    // leads retry next tick — so re-paying it per lead would burn real money in
    // a ~30s loop. Only the FIRST lead may pay; the rest defer untouched.
    const { postOutbound, kb, markStatus } = deps();
    const runner = {
      draft: vi.fn(async () => {
        throw new BudgetExceededError({ layer: "instance", spent_cents: 9999, cap_cents: 10000, estimated_cents: 200 });
      }),
    };
    const fetchPostComments = vi.fn(async () => [{ text: "nice", authorName: "a" }]);
    const sql = Object.assign(vi.fn(async () => []), { json: (x: unknown) => x });
    await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({ id: "L1", external_id: "1", tier: "T3", classifier_score: 77 }),
        lead({ id: "L2", external_id: "2", tier: "T3", classifier_score: 77 }),
        lead({ id: "L3", external_id: "3", tier: "T3", classifier_score: 77 }),
      ] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      fetchPostComments: fetchPostComments as never,
      commentFetchMinCount: 1,
      sql: sql as never,
    });

    // The model was attempted exactly once: lead 1 tripped the cap, 2 and 3 were
    // deferred without ever reaching a paid call.
    expect(runner.draft).toHaveBeenCalledTimes(1);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).not.toHaveBeenCalledWith(expect.objectContaining({ status: "errored" }));
  });

  it("uses the linkedin feed-update URL fallback when payload has no url", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", payload: { text: "hi" } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    const body = postOutbound.mock.calls[0]![0];
    expect(body.originalPostUrl).toContain("linkedin.com/feed/update/urn:li:activity:");
  });

  it("weaves the per-person profile + objective into the substantial system prompt", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const sql = vi
      .fn()
      .mockResolvedValueOnce([
        {
          fsd_profile_id: "ABC123",
          public_id: "jane-builder",
          summary: "Ships fast, posts about DX.",
          topics: ["dx", "agents"],
          tone: "earnest",
          engagement_notes: "be concrete",
        },
      ])
      .mockResolvedValueOnce([{ public_id: "jane-builder", objective: "befriend and learn from her" }]);

    await runDrafterTick({
      patternRules: [],
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      sql: sql as never,
    });

    const system: string = runner.draft.mock.calls[0]![0].system;
    expect(system).toContain("PER-PERSON CONTEXT");
    expect(system).toContain("Ships fast, posts about DX.");
    expect(system).toContain("befriend and learn from her");
  });
});

describe("decideOpus (reaction-based tiering rule)", () => {
  const th = { likesThreshold: 80, commentsThreshold: 30 };

  it("uses Opus when likes > threshold", () => {
    expect(decideOpus({ likes: 104, comments: 2, commentBait: false, ...th }).useOpus).toBe(true);
  });

  it("uses Opus when genuine comments > threshold (not bait)", () => {
    expect(decideOpus({ likes: 5, comments: 40, commentBait: false, ...th }).useOpus).toBe(true);
  });

  it("does NOT use Opus when comments > threshold but the post is comment-bait", () => {
    // 1158 comments but it's a comment-farming giveaway → comment count ignored.
    expect(decideOpus({ likes: 5, comments: 1158, commentBait: true, ...th }).useOpus).toBe(false);
  });

  it("STILL uses Opus on a comment-bait post when likes clear the threshold (likes always reliable)", () => {
    expect(decideOpus({ likes: 240, comments: 1158, commentBait: true, ...th }).useOpus).toBe(true);
  });

  it("does NOT use Opus for a normal low-engagement post", () => {
    expect(decideOpus({ likes: 10, comments: 3, commentBait: false, ...th }).useOpus).toBe(false);
  });

  it("uses strict > (equal to threshold does not trip Opus)", () => {
    expect(decideOpus({ likes: 80, comments: 30, commentBait: false, ...th }).useOpus).toBe(false);
  });

  it("treats missing/null engagement as 0", () => {
    expect(decideOpus({ likes: null, comments: undefined, commentBait: false, ...th }).useOpus).toBe(false);
  });
});

describe("runDrafterTick — reaction-based Opus model override", () => {
  const opusArgs = { opusLikesThreshold: 80, opusCommentsThreshold: 30, opusModel: "claude-opus-4-6" };

  function routingOf(runner: { draft: { mock: { calls: unknown[][] } } }) {
    return (runner.draft.mock.calls[0]![0] as { routing: { primary: { model: string }; fallback?: { model: string } } }).routing;
  }

  it("overrides to Opus when post likes > 80", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", payload: { text: "post", reactions: 104, comments: 2 } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      ...opusArgs,
    });
    expect(routingOf(runner).primary.model).toBe("claude-opus-4-6");
    // Tiering's fallback is the base routing's primary (now sonnet), so a draft
    // is never left unrun if Opus is unavailable.
    expect(routingOf(runner).fallback?.model).toBe("claude-sonnet-4-6");
  });

  it("uses browser-observed reactions for substantial model tiering", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ payload: { text: "post", source: "extension_observed", reactionCount: 104, commentCount: 2 } })] as never,
      runner: runner as never, kb: kb as never, postOutbound, markStatus, ...opusArgs,
    });
    expect(routingOf(runner).primary.model).toBe("claude-opus-4-6");
  });

  it("overrides to Opus when genuine comments > 30 (comment_bait=false)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({ tier: "T1", comment_bait: false, payload: { text: "post", reactions: 5, comments: 40 } }),
      ] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      ...opusArgs,
    });
    expect(routingOf(runner).primary.model).toBe("claude-opus-4-6");
  });

  it("does NOT override to Opus when comments > 30 but comment_bait=true and likes below threshold", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({ tier: "T1", comment_bait: true, payload: { text: "post", reactions: 10, comments: 1158 } }),
      ] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      ...opusArgs,
    });
    // bait comment count ignored + likes under threshold → tiering does NOT fire,
    // so the draft runs on the un-tiered base routing (sonnet primary, opus
    // fallback) rather than being upgraded to Opus.
    expect(routingOf(runner).primary.model).toBe("claude-sonnet-4-6");
    expect(routingOf(runner).fallback?.model).toBe("claude-opus-4-6");
  });

  it("uses the default model (sonnet) for a normal low-engagement lead", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", payload: { text: "post", reactions: 10, comments: 3 } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      ...opusArgs,
    });
    // Sonnet is the everyday floor; Opus only via reaction tiering.
    expect(routingOf(runner).primary.model).toBe("claude-sonnet-4-6");
  });

  it("applies Opus tiering on the LIGHT path too (high-engagement win post)", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [
        lead({ classifier_label: "light", tier: null, payload: { text: "we shipped!", reactions: 240, comments: 5 } }),
      ] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      ...opusArgs,
    });
    expect((runner.draft.mock.calls[0]![0] as { routing: { primary: { model: string } } }).routing.primary.model).toBe(
      "claude-opus-4-6",
    );
  });

  it("uses browser-observed reactions for light model tiering", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null, payload: { text: "we shipped!", source: "extension_observed", reactionCount: 104, commentCount: 2 } })] as never,
      runner: runner as never, kb: kb as never, postOutbound, markStatus, ...opusArgs,
    });
    expect((runner.draft.mock.calls[0]![0] as { routing: { primary: { model: string } } }).routing.primary.model).toBe("claude-opus-4-6");
  });

  it("Opus tiering never trips when thresholds are left at default (omitted) — defensive", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", payload: { text: "post", reactions: 999999, comments: 999999 } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      // no opus* args → thresholds default to MAX_SAFE_INTEGER, tiering never trips.
    });
    // Tiering doesn't trip and the DEFAULT routing primary is sonnet, so the
    // draft runs on sonnet (the everyday floor).
    expect(routingOf(runner).primary.model).toBe("claude-sonnet-4-6");
  });
});

describe("runDrafterTick comment-energy", () => {
  const commentLead = (over: Record<string, unknown> = {}) =>
    lead({
      tier: "T1",
      payload: {
        text: "post text",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/",
        authorName: "Jane",
        authorPublicId: "jane-builder",
        comments: 12,
      },
      ...over,
    });

  it("fetches comments, injects the COMMENT SECTION into the prompt, and records apify spend", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const fetchPostComments = vi.fn().mockResolvedValue([
      { id: "c1", url: "", text: "commenting is the real distribution channel", authorName: "Dev", authorHeadline: "Founder", reactions: 9, repliesCount: 1, createdAt: "" },
      { id: "c2", url: "", text: "love the consistency angle", authorName: "Mia", authorHeadline: null, reactions: 2, repliesCount: 0, createdAt: "" },
    ]);
    const record = vi.fn().mockResolvedValue(undefined);

    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [commentLead()] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      fetchPostComments: url => withMeteredApifyCall({
        client: { drainRunReceipts: () => [{ runId: "comment-run", actor: "linkedin-post-comments",
          actualUsd: 0.01, credentialId: "comment-token", status: "SUCCEEDED", terminal: true,
          resultCount: 2, resultCountComplete: true, fetchedResultCount: 2 }] },
        recorder: { record }, log, orgId: "o", instanceId: "i", agentRole: "linkedin_intern",
        worker: "drafter", actor: "linkedin-post-comments", startedAt: new Date(),
      }, () => fetchPostComments(url)),
    });

    expect(fetchPostComments).toHaveBeenCalledWith(
      "https://www.linkedin.com/feed/update/urn:li:activity:7000000000000000001/",
    );
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("THE COMMENT SECTION");
    expect(prompt).toContain("commenting is the real distribution channel");
    expect(prompt).toContain("12 comments"); // saturation signal from the known count

    // Apify spend recorded as engine='apify' for the comment fetch.
    const apifyRows = record.mock.calls.map((c) => c[0]).filter((r) => r.engine === "apify");
    expect(apifyRows).toHaveLength(1);
    expect(apifyRows[0]!.model).toBe("apify/linkedin-post-comments");
    expect(apifyRows[0]!.cents).toBe(1); // Reported receipt cost, independent of normalized count.
  });

  it("uses browser-observed commentCount for existing comment context", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const fetchPostComments = vi.fn().mockResolvedValue([
      { id: "c1", url: "", text: "A useful comment", authorName: "Dev", authorHeadline: null, reactions: 1, repliesCount: 0, createdAt: "" },
    ]);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [commentLead({ payload: { text: "post text", url: leadPayload.url, source: "extension_observed", reactionCount: 4, commentCount: 12 } })] as never,
      runner: runner as never, kb: kb as never, postOutbound, markStatus, fetchPostComments,
    });
    expect(fetchPostComments).toHaveBeenCalledWith(leadPayload.url);
    expect((runner.draft.mock.calls[0]![0] as { prompt: string }).prompt).toContain("12 comments");
  });

  it("skips the fetch (no spend) when the post has fewer comments than the min", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const fetchPostComments = vi.fn();
    const record = vi.fn();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [commentLead({ payload: { text: "post text", url: "https://x/y", comments: 1 } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      fetchPostComments,
    });
    expect(fetchPostComments).not.toHaveBeenCalled();
    expect(record.mock.calls.filter((c) => c[0].engine === "apify")).toHaveLength(0);
  });

  it("fails open: an Apify error still drafts (no comment context, no spend)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const fetchPostComments = vi.fn().mockRejectedValue(new Error("apify 402"));
    const record = vi.fn();
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [commentLead()] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      fetchPostComments,
    });
    expect(n).toBe(1); // draft still shipped
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("THE COMMENT SECTION");
    expect(record.mock.calls.filter((c) => c[0].engine === "apify")).toHaveLength(0);
  });

  it("reframes the comment section as NEGATIVE exemplars (slop to differentiate from)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const fetchPostComments = vi.fn().mockResolvedValue([
      { id: "c1", url: "", text: "Congrats! 🎉", authorName: "Bob", authorHeadline: null, reactions: 1, repliesCount: 0, createdAt: "" },
      { id: "c2", url: "", text: "commenting is the real distribution channel, here's why it compounds", authorName: "Dev", authorHeadline: "Founder", reactions: 9, repliesCount: 1, createdAt: "" },
    ]);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [commentLead()] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      fetchPostComments,
    });
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    // Adversarial framing, not "match the register".
    expect(prompt).toContain("NEGATIVE exemplars");
    expect(prompt).toContain("Do NOT blend in");
    expect(prompt).not.toContain("Match the register of these comments");
    // The generic "Congrats! 🎉" is surfaced before the substantive comment.
    expect(prompt.indexOf("Congrats! 🎉")).toBeLessThan(prompt.indexOf("commenting is the real distribution channel"));
  });
});

describe("runDrafterTick — knowledge grounding (grounded-drafting)", () => {
  it("scopes the voice search to voiceDirs when configured (single pass, filterDirs)", async () => {
    const { postOutbound, runner, markStatus } = deps();
    const kb = { search: vi.fn().mockResolvedValue([anchorHit(8.0)]) };
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      voiceDirs: ["02-brand"],
    });
    expect(kb.search).toHaveBeenCalledTimes(1);
    expect(kb.search.mock.calls[0]![2]).toEqual({ filterDirs: ["02-brand"] });
  });

  it("runs a SECOND knowledge pass and injects 'Product knowledge' into the prompt", async () => {
    const { postOutbound, runner, markStatus } = deps();
    const kb = {
      search: vi.fn().mockImplementation((_q: string, _k: number, opts?: { filterDirs?: string[] }) => {
        if (opts?.filterDirs?.includes("01-business")) {
          return Promise.resolve([
            { snippet: "Nella does AST-aware code search", score: 9, filePath: "01-business/x.md", startLine: 1, endLine: 1, highlights: [] },
          ]);
        }
        return Promise.resolve([anchorHit(8.0)]);
      }),
    };
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      knowledgeDirs: ["01-business"],
      knowledgeTopK: 4,
    });
    // Two retrieval passes: voice (no/other filterDirs) + knowledge (01-business).
    expect(kb.search).toHaveBeenCalledTimes(2);
    expect(kb.search.mock.calls.some((c) => c[2]?.filterDirs?.includes("01-business"))).toBe(true);
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("Product knowledge");
    expect(prompt).toContain("AST-aware code search");
  });

  it("skips the knowledge pass when no knowledge dirs are configured (one search, no block)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    expect(kb.search).toHaveBeenCalledTimes(1);
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("Product knowledge");
  });

  it("injects product knowledge on the LIGHT path too", async () => {
    const { postOutbound, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    const kb = {
      search: vi.fn().mockImplementation((_q: string, _k: number, opts?: { filterDirs?: string[] }) =>
        opts?.filterDirs?.includes("01-business")
          ? Promise.resolve([{ snippet: "free tier is 5K/mo", score: 9, filePath: "01-business/p.md", startLine: 1, endLine: 1, highlights: [] }])
          : Promise.resolve([anchorHit(8.0)]),
      ),
    };
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      knowledgeDirs: ["01-business"],
    });
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("Product knowledge");
    expect(prompt).toContain("free tier is 5K/mo");
  });
});

describe("runDrafterTick — vision caption (grounded-drafting)", () => {
  it.each(["substantial", "light", "batch-light"])("defers %s before paid drafting when caption admission rejects", async (kind) => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const values: unknown[] = [];
    const sql = Object.assign(vi.fn(async (_s: unknown, ...v: unknown[]) => { values.push(...v); return []; }),
      { json: (x: unknown) => x });
    const captionFn = vi.fn().mockRejectedValue(new BudgetExceededError({ layer: "instance", spent_cents: 1, cap_cents: 1, estimated_cents: 1 }));
    expect(await runDrafterTick({
      patternRules: [], log, instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: kind === "substantial" ? "substantial" : "light",
        payload: { ...leadPayload, images: ["https://image.test/a.jpg"] } })] as never,
      runner: runner as never, kb: kb as never, postOutbound, markStatus, captionFn, sql: sql as never,
      ...(kind === "batch-light" ? { batch: { enabled: true } } : {}) })).toBe(0);
    expect(runner.draft).not.toHaveBeenCalled();
    expect(postOutbound).not.toHaveBeenCalled();
    expect(values).toContainEqual({ budget_deferred: kind === "substantial" ? "substantial" : "light" });
  });

  it("captions the post's images and injects 'THE POST'S IMAGE SHOWS:' into the prompt", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const captionFn = vi.fn().mockResolvedValue("a line chart of MRR doubling over 3 months");
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", payload: { text: "we hit a milestone", images: ["https://media.licdn.com/a.jpg"] } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      captionFn,
    });
    expect(captionFn).toHaveBeenCalledTimes(1);
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).toContain("THE POST'S IMAGE SHOWS:");
    expect(prompt).toContain("a line chart of MRR doubling");
  });

  it("no captionFn → no image line (drafting unchanged)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", payload: { text: "post", images: ["https://media.licdn.com/a.jpg"] } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("THE POST'S IMAGE SHOWS:");
  });

  it("fails open when the vision call throws (drafting proceeds, no image line)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const captionFn = vi.fn().mockRejectedValue(new Error("vision 500"));
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", payload: { text: "post", images: ["https://media.licdn.com/a.jpg"] } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      captionFn,
    });
    expect(n).toBe(1); // draft still shipped
    const prompt = (runner.draft.mock.calls[0]![0] as { prompt: string }).prompt;
    expect(prompt).not.toContain("THE POST'S IMAGE SHOWS:");
  });
});

describe("runDrafterTick — verifier (grounded-drafting)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("privately traces only the selected browser reply and each rejected rewrite", async () => {
    const home = mkdtempSync(join(tmpdir(), "noelle-review-trace-"));
    const selectedId = "11111111-1111-4111-8111-111111111111";
    vi.stubEnv("HOME", home);
    vi.stubEnv("NOELLE_LINKEDIN_REVIEW_TRACE_LEAD_ID", selectedId);
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft
      .mockResolvedValueOnce({ text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "First weak reply" }] }), engine: "bedrock", model: "m" })
      .mockResolvedValueOnce({ text: JSON.stringify({ drafts: [{ angle: "empathetic", body: "Second weak reply" }] }), engine: "bedrock", model: "m" });
    const judge = vi.fn().mockResolvedValue(verdict(false));
    try {
      await runDrafterTick({
        log,
        instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ id: selectedId, tier: "T1", payload: { ...leadPayload, source: "extension_observed", text: "SECRET SOURCE POST", authorName: "SECRET AUTHOR" } })] as never,
        runner: runner as never,
        kb: kb as never,
        postOutbound,
        markStatus,
        verify: { enabled: true, retries: 1, voiceFloor: 0.8, makeCalls: () => [judge] },
      });
      const directory = join(home, ".noelle", "private-review-traces");
      const files = readdirSync(directory);
      expect(files).toEqual([`linkedin-${selectedId}.json`]);
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      const path = join(directory, files[0]!);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const raw = readFileSync(path, "utf8");
      expect(raw).not.toContain("SECRET SOURCE POST");
      expect(raw).not.toContain("SECRET AUTHOR");
      const trace = JSON.parse(raw) as { attempts: Array<{ drafts: Array<{ body: string }>; verdict: { pass: boolean; judgeProvider: string; scores: { voice: number }; reasons: string[]; fix: string } }> };
      expect(trace.attempts).toHaveLength(2);
      expect(trace.attempts.map((attempt) => attempt.drafts[0]?.body)).toEqual(["First weak reply", "Second weak reply"]);
      expect(trace.attempts[0]?.verdict).toMatchObject({ pass: false, judgeProvider: "legacy", scores: { voice: 0.3 }, reasons: expect.arrayContaining(["too generic"]), fix: "name a concrete detail" });
      expect(postOutbound).not.toHaveBeenCalled();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  const verdict = (pass: boolean) =>
    JSON.stringify(
      pass
        ? { voice: 0.9, grounding: 0.9, relevance: 0.9, reasons: [], fix: null }
        : { voice: 0.3, grounding: 0.4, relevance: 0.5, reasons: ["too generic"], fix: "name a concrete detail" },
    );

  it("disabled by default → no judge calls, verifierMeta null", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    expect(runner.draft).toHaveBeenCalledTimes(1);
    expect(postOutbound.mock.calls[0]![0].verifierMeta).toBeNull();
  });

  it("passes on the first try → no regenerate, verdict attached", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn().mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(runner.draft).toHaveBeenCalledTimes(1); // no regenerate
    expect(judge).toHaveBeenCalledTimes(4); // aggregate set, then three exact reply angles
    const meta = postOutbound.mock.calls[0]![0].verifierMeta;
    expect(meta.pass).toBe(true);
    expect(meta.attempts).toBe(0);
    expect(meta.judgeOk).toBe(true);
    expect(meta.judgeProvider).toBe("legacy");
  });

  it("reviews each cleaned substantial reply angle separately after the aggregate review", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({
      text: JSON.stringify({
        ...fullSubstantial,
        drafts: [{ ...fullSubstantial.drafts[0], body: "The customer feedback loop is strong 🎉" }, ...fullSubstantial.drafts.slice(1)],
      }),
      engine: "bedrock", model: "m",
    });
    const judge = vi.fn()
      .mockResolvedValueOnce(verdict(true)) // aggregate set
      .mockResolvedValueOnce(verdict(true)) // empathetic
      .mockResolvedValueOnce(verdict(false)) // technical
      .mockResolvedValueOnce(verdict(true)); // contrarian
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: true } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 0, makeCalls: () => [judge] },
    });

    const outbound = postOutbound.mock.calls[0]![0];
    const replies = outbound.drafts.filter((d: { kind: string }) => d.kind === "reply");
    expect(replies).toHaveLength(3);
    expect(replies[0]!.body).not.toContain("🎉");
    expect(judge).toHaveBeenCalledTimes(4);
    for (let index = 0; index < replies.length; index++) {
      const prompt = judge.mock.calls[index + 1]![1] as string;
      expect(prompt).toContain(`[reply/${replies[index]!.angle}] ${replies[index]!.body}`);
      for (const sibling of replies.filter((_: unknown, siblingIndex: number) => siblingIndex !== index)) {
        expect(prompt).not.toContain(`[reply/${sibling.angle}] ${sibling.body}`);
      }
      expect(prompt).not.toContain("[dm]");
      expect(replies[index]!.verifierMeta).toEqual(expect.objectContaining({ judgeOk: true, judgeProvider: "legacy" }));
    }
    expect(judge.mock.calls[1]![1]).not.toContain("🎉");
    expect(replies.map((d: { verifierMeta: { pass: boolean } }) => d.verifierMeta.pass)).toEqual([true, false, true]);
    expect(outbound.verifierMeta.pass).toBe(true); // aggregate result remains for regeneration history
    const dms = outbound.drafts.filter((d: { kind: string }) => d.kind === "dm");
    expect(dms).toHaveLength(1);
    expect(dms[0]!.verifierMeta).toBeUndefined();
  });

  it("marks a per-angle judge outage as failing even when the verifier fails open", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn()
      .mockResolvedValueOnce(verdict(true))
      .mockResolvedValueOnce(verdict(true))
      .mockRejectedValueOnce(new Error("judge unavailable"))
      .mockResolvedValueOnce(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 0, makeCalls: () => [judge] },
    });
    const technical = postOutbound.mock.calls[0]![0].drafts.find((d: { angle: string }) => d.angle === "technical");
    expect(technical.verifierMeta).toEqual(expect.objectContaining({
      pass: false, judgeOk: false, judgeProvider: "none", attempts: 0,
    }));
  });

  it("still reviews the final reply when multiple generated variants collapse to one angle", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({
      text: JSON.stringify({ drafts: [
        { angle: "empathetic", body: "The customer feedback loop matters here." },
        { angle: "empathetic", body: "A duplicate angle." },
      ] }),
      engine: "bedrock", model: "m",
    });
    const judge = vi.fn().mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 0, makeCalls: () => [judge] },
    });
    const drafts = postOutbound.mock.calls[0]![0].drafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.verifierMeta).toEqual(expect.objectContaining({ pass: true, judgeOk: true }));
    expect(judge).toHaveBeenCalledTimes(2);
    expect(judge.mock.calls[1]![1]).not.toContain("A duplicate angle.");
  });

  it("keeps strong reply angles when a weak sibling lowers the aggregate voice score", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn()
      .mockResolvedValueOnce(verdict(false)) // the set failed and retries are exhausted
      .mockResolvedValueOnce(verdict(true)) // empathetic is strong
      .mockResolvedValueOnce(verdict(false)) // technical is weak
      .mockResolvedValueOnce(verdict(true)); // contrarian is strong
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 0, voiceFloor: 0.8, makeCalls: () => [judge] },
    });
    expect(n).toBe(1);
    expect(judge).toHaveBeenCalledTimes(4);
    const outbound = postOutbound.mock.calls[0]![0];
    expect(outbound.verifierMeta.scores.voice).toBe(0.3);
    expect(outbound.drafts.map((draft: { angle: string }) => draft.angle)).toEqual(["empathetic", "contrarian"]);
    expect(outbound.drafts.every((draft: { verifierMeta: { pass: boolean; scores: { voice: number } } }) =>
      draft.verifierMeta.pass && draft.verifierMeta.scores.voice >= 0.8)).toBe(true);
    expect(markStatus).not.toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped", meta: expect.objectContaining({ skip_reason: "low-voice" }),
    }));
  });

  it("reviews a sole reply without the companion DM before applying its voice floor", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({
      text: JSON.stringify({ drafts: [fullSubstantial.drafts[0]], dm: fullSubstantial.dm }),
      engine: "bedrock", model: "m",
    });
    const judge = vi.fn().mockResolvedValueOnce(verdict(false)).mockResolvedValueOnce(verdict(true));
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: true } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 0, voiceFloor: 0.8, makeCalls: () => [judge] },
    });
    expect(n).toBe(1);
    expect(judge).toHaveBeenCalledTimes(2);
    const drafts = postOutbound.mock.calls[0]![0].drafts;
    expect(drafts.filter((draft: { kind: string }) => draft.kind === "reply")).toEqual([
      expect.objectContaining({ verifierMeta: expect.objectContaining({ pass: true, judgeOk: true, scores: expect.objectContaining({ voice: 0.9 }) }) }),
    ]);
    expect(drafts.filter((draft: { kind: string }) => draft.kind === "dm")).toHaveLength(1);
    expect(drafts.find((draft: { kind: string }) => draft.kind === "dm")!.verifierMeta).toBeUndefined();
  });

  it("skips cold outbound when every final reply is below the floor, including a companion DM", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn().mockResolvedValue(verdict(false));
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o", dm_autodraft_enabled: true } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 0, voiceFloor: 0.8, makeCalls: () => [judge] },
    });
    expect(n).toBe(0);
    expect(judge).toHaveBeenCalledTimes(4);
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped", meta: expect.objectContaining({ skip_reason: "low-voice" }),
    }));
  });

  it("regenerates with the critique on a failing verdict, keeps the improved draft", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn().mockResolvedValueOnce(verdict(false)).mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(runner.draft).toHaveBeenCalledTimes(2); // initial + 1 regenerate
    expect((runner.draft.mock.calls[1]![0] as { prompt: string }).prompt).toContain("REVIEW FEEDBACK");
    const meta = postOutbound.mock.calls[0]![0].verifierMeta;
    expect(meta.pass).toBe(true);
    expect(meta.attempts).toBe(1);
  });

  it.each(["substantial", "light"] as const)("keeps browser %s verification on Codex-primary routing and uses Opus only for the final rewrite", async (replyKind) => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    if (replyKind === "light") {
      runner.draft.mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" });
    }
    const judge = vi.fn().mockResolvedValue(verdict(false));
    const makeCalls = vi.fn(() => [judge]);
    const sourcePost = "If someone sees seven posts, they may warm up; separately, one prospect viewed my profile.";
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({
        tier: "T3",
        classifier_label: replyKind,
        payload: { ...leadPayload, source: "extension_observed", text: sourcePost },
      })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      opusModel: "claude-opus-4-6",
      verify: { enabled: true, retries: 2, voiceFloor: 0.8, makeCalls },
    });
    expect(makeCalls).toHaveBeenCalledWith(false);
    expect(runner.draft.mock.calls.map((call) => (call[0] as { routing: { primary: { model: string } } }).routing.primary.model))
      .toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-opus-4-6"]);
    expect(runner.draft.mock.calls.every((call) => !("directRouting" in call[0]))).toBe(true);
    const finalCall = runner.draft.mock.calls[2]![0] as { prompt: string; system: string };
    const firstRepair = runner.draft.mock.calls[1]![0] as { prompt: string };
    expect(finalCall.prompt).toContain(sourcePost);
    expect(finalCall.prompt).toContain("REVIEW FEEDBACK");
    expect(finalCall.prompt).toContain("name a concrete detail");
    expect(firstRepair.prompt).not.toContain("FINAL BROWSER REPAIR");
    expect(finalCall.prompt).toContain("FINAL BROWSER REPAIR");
    expect(finalCall.prompt).toMatch(/one compact comment.*natural.*rhythm/i);
    expect(finalCall.prompt).not.toMatch(/two short, independent lines/i);
    expect(finalCall.prompt).not.toMatch(/avoid `, so`|avoid `, because`/i);
    expect(finalCall.prompt).toMatch(/learned.*pattern rules.*still apply/i);
    expect(finalCall.prompt).toMatch(/antithesis/i);
    expect(finalCall.prompt).toMatch(/source.*specific/i);
    expect(finalCall.prompt).toMatch(/learned.*rules/i);
    expect(finalCall.prompt).toContain("NO FULL STOPS");
    expect(finalCall.system).toContain("never import their personal experience");
    expect(postOutbound).not.toHaveBeenCalled();
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped", meta: expect.objectContaining({ skip_reason: "low-voice" }),
    }));
  });

  it("keeps a legacy lead's final rejected rewrite on its original writer", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn().mockResolvedValue(verdict(false));
    const makeCalls = vi.fn(() => [judge]);
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T3", payload: { ...leadPayload, source: "apify" } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, makeCalls },
    });
    expect(makeCalls.mock.calls).toEqual([[false]]);
    expect(runner.draft.mock.calls.map((call) => (call[0] as { routing: { primary: { model: string } } }).routing.primary.model))
      .toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6", "claude-sonnet-4-6"]);
    expect(runner.draft.mock.calls.every((call) => !("directRouting" in call[0]))).toBe(true);
    expect((runner.draft.mock.calls[2]![0] as { prompt: string }).prompt).not.toContain("FINAL BROWSER REPAIR");
  });

  it("does not escalate a browser rewrite that passes before the final retry", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn().mockResolvedValueOnce(verdict(false)).mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T3", payload: { ...leadPayload, source: "extension_observed" } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(runner.draft.mock.calls.map((call) => (call[0] as { routing: { primary: { model: string } } }).routing.primary.model))
      .toEqual(["claude-sonnet-4-6", "claude-sonnet-4-6"]);
  });

  it.each(["substantial", "light"] as const)("keeps the ordinary fallback on an already-Opus browser %s final rewrite", async (replyKind) => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    if (replyKind === "light") runner.draft.mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" });
    const judge = vi.fn().mockResolvedValue(verdict(false));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({
        tier: "T3",
        classifier_label: replyKind,
        payload: { ...leadPayload, source: "extension_observed", reactionCount: 104 },
      })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      opusLikesThreshold: 80,
      verify: { enabled: true, retries: 1, voiceFloor: 0.8, makeCalls: () => [judge] },
    });
    const routes = runner.draft.mock.calls.map((call) => (call[0] as { routing: { primary: { model: string }; fallback?: { model: string } } }).routing);
    expect(routes.map((route) => route.primary.model)).toEqual(["claude-opus-4-6", "claude-opus-4-6"]);
    expect(routes[1]?.fallback?.model).toBe("claude-sonnet-4-6");
  });

  it.each(["substantial", "light"] as const)("records the winning Opus browser %s rewrite as its actual model", async (replyKind) => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    const output = replyKind === "light" ? oneLight : fullSubstantial;
    runner.draft.mockImplementation(async ({ routing }: { routing: { primary: { engine: string; model: string } } }) => ({
      text: JSON.stringify(output),
      engine: routing.primary.engine,
      model: routing.primary.model,
    }));
    const judge = vi.fn().mockResolvedValueOnce(verdict(false)).mockResolvedValueOnce(verdict(false)).mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T3", classifier_label: replyKind, payload: { ...leadPayload, source: "extension_observed" } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, voiceFloor: 0.8, makeCalls: () => [judge] },
    });
    expect(postOutbound).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({
      status: "drafted", meta: expect.objectContaining({ engine: "bedrock", model: "claude-opus-4-6" }),
    }));
  });

  it("keeps the post's uncertainty and sentence-case rule in browser repair feedback", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("AI_GATEWAY_API_KEY", "");
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn().mockResolvedValueOnce(verdict(false)).mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", payload: { ...leadPayload, source: "extension_observed", text: "If prospects see seven posts, they may warm up; separately, one prospect visited my profile." } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 1, makeCalls: () => [judge] },
    });
    const repair = (runner.draft.mock.calls[1]![0] as { prompt: string }).prompt;
    expect(repair).toContain("REVIEW FEEDBACK");
    expect(repair).toMatch(/keep.*conditional.*source/i);
    expect(repair).toMatch(/capital.*start.*no full stops/i);
  });

  it("gives up after `retries`, queues the best attempt with a failing verdict", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn().mockResolvedValue(verdict(false)); // always fails
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(runner.draft).toHaveBeenCalledTimes(3); // initial + 2 retries
    expect(postOutbound).toHaveBeenCalledTimes(1); // still queued
    const meta = postOutbound.mock.calls[0]![0].verifierMeta;
    expect(meta.pass).toBe(false);
    expect(meta.attempts).toBe(2);
  });

  it("verifier machinery runs whatever judge panel makeCalls returns (here 3)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const judge = vi.fn().mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1", priority: true })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, makeCalls: (priority) => (priority ? [judge, judge, judge] : [judge]) },
    });
    expect(judge).toHaveBeenCalledTimes(12); // 3 judges on the set and each reply angle
  });

  it("does NOT flag a long LinkedIn comment on length (no charLimit)", async () => {
    const { postOutbound, kb, markStatus } = deps();
    // A 600-char comment — would blow X's 250 cap, but LinkedIn omits charLimit,
    // so the format dimension must NOT fail it. The judge passes the content dims;
    // the verdict should pass (no length penalty).
    const longBody = "a".repeat(600);
    const longDraft = JSON.stringify({
      drafts: [
        { angle: "empathetic", body: longBody, char_count: 600 },
        { angle: "technical", body: "t", char_count: 1 },
        { angle: "contrarian", body: "c", char_count: 1 },
      ],
    });
    const runner = { draft: vi.fn().mockResolvedValue({ text: longDraft, engine: "bedrock", model: "m" }) };
    // Real judge wiring would be an LLM; here the judge passes content dims so the
    // ONLY thing that could fail is the deterministic format/length check.
    const judge = vi.fn().mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(runner.draft).toHaveBeenCalledTimes(1); // passed → no regenerate
    const meta = postOutbound.mock.calls[0]![0].verifierMeta;
    expect(meta.pass).toBe(true);
    expect(meta.scores.format).toBe(1); // no length penalty applied
  });

  it("verifies the LIGHT path too (one supportive comment)", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    const judge = vi.fn().mockResolvedValue(verdict(true));
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      verify: { enabled: true, retries: 2, makeCalls: () => [judge] },
    });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(postOutbound.mock.calls[0]![0].verifierMeta.pass).toBe(true);
  });

  const browserDraft = {
    drafts: [
      { angle: "empathetic", body: "The customer feedback loop you described gives the launch a useful direction.", char_count: 75 },
      { angle: "technical", body: "The event stream makes this easier to debug.", char_count: 43 },
      { angle: "contrarian", body: "Speed can hide maintenance cost.", char_count: 32 },
    ],
    dm: { body: "A separate cold outreach message that must not be reviewed or queued.", char_count: 67 },
  };

  const productBrand = {
    persona: { name: "Ari", bio: "Building a social workspace" },
    product: { name: "Noelle", description: "A social content workspace", surfaces: [], fits_when: [] },
    pitch_policy: "when_relevant",
    qa: [{ q: "How does Noelle work?", a: "Click approve; nothing auto-posts." }],
    reply_style: {
      voice_notes: "Direct, specific, warm, and curious.",
      never_do: ["Avoid stale filler closers from my style notes", "Never bolt Noelle onto unrelated posts"],
    },
  };

  it("keeps browser-observed substantial replies focused on the post, without product FAQ or mission", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify(browserDraft), engine: "bedrock", model: "m" });
    kb.search.mockResolvedValue([{ ...anchorHit(8), snippet: "Noelle approval workflow voice anchor." }]);

    const drafted = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o", objective: "Grow Noelle through approval clicks", brand_config: productBrand } as never,
      claimedLeads: [lead({ tier: "T1", payload: { ...leadPayload, source: "extension_observed", text: "I shipped a code editor with local-first sync." } })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
      knowledgeDirs: ["product"],
      knowledgeTopK: 1,
      relevanceThreshold: 6,
    });

    expect(drafted).toBe(1);
    expect(kb.search).not.toHaveBeenCalled();
    const call = runner.draft.mock.calls[0]![0] as { system: string; prompt: string };
    expect(call.system).toContain("Ari");
    expect(call.system).toContain("Direct, specific, warm, and curious.");
    expect(call.system).toContain("Avoid stale filler closers from my style notes");
    expect(call.system).toContain("Never bolt Noelle onto unrelated posts");
    expect(call.system + call.prompt).not.toContain("Click approve; nothing auto-posts.");
    expect(call.system + call.prompt).not.toContain("Grow Noelle through approval clicks");
    expect(call.prompt).not.toContain("Noelle approval workflow voice anchor.");
    expect(call.prompt).toContain("I shipped a code editor with local-first sync.");
  });

  it("keeps browser-observed light replies free of the product mission and knowledge", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = { draft: vi.fn().mockResolvedValue({ text: JSON.stringify(oneLight), engine: "bedrock", model: "m" }) };
    kb.search.mockImplementation(async (_query: string, _topK: number, opts?: { filterDirs?: string[] }) =>
      opts?.filterDirs?.includes("02-brand")
        ? [{ ...anchorHit(8), snippet: "Noelle approval workflow voice anchor." }]
        : [{ ...anchorHit(8), snippet: "A concrete peer observation." }]);

    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o", objective: "Grow Noelle through approval clicks", brand_config: productBrand } as never,
      claimedLeads: [lead({ classifier_label: "light", tier: null, payload: { ...leadPayload, source: "extension_observed", text: "We launched our code editor today!" } })] as never,
