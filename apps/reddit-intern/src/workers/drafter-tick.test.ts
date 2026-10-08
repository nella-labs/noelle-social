import { describe, expect, it, vi } from "vitest";
import { runDrafterTick, decideOpus, decideCommentTarget } from "./drafter-tick.js";
import { BudgetExceededError, GENZ_MARKERS } from "@noelle/runtime";
import * as runtime from "@noelle/runtime";

const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } as never;

/** Deterministic LCG so rotation tests are stable but walk the range. */
const makeLcg = (seed: number) => () => {
  // Math.imul, NOT `*`: seed * 1103515245 exceeds Number.MAX_SAFE_INTEGER,
  // so the state is ROUNDED before the modulus and the stream collapses —
  // 16403 distinct values in 20000 draws instead of 20000.
  seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
  seed %= 2 ** 31;
  return seed / 2 ** 31;
};

const anchorHit = (score: number) => ({
  path: "p.md",
  snippet: "anchor",
  score,
  filePath: "p.md",
  startLine: 1,
  endLine: 1,
  highlights: [],
});

// All three angles — the model returns the full set; the tick keeps only the
// angles the tier allows. Reddit replies carry NO DM.
const fullSubstantial = {
  drafts: [
    { angle: "empathetic", body: "e", char_count: 1 },
    { angle: "technical", body: "t", char_count: 1 },
    { angle: "contrarian", body: "c", char_count: 1 },
  ],
};

const oneLight = {
  drafts: [{ angle: "empathetic", body: "congrats on the launch, the demo looked sharp", char_count: 45 }],
};

const lead = (over: Record<string, unknown> = {}) => ({
  id: "L",
  external_id: "abc123",
  payload: {
    title: "We shipped our MVP",
    text: "post body",
    url: "https://www.reddit.com/r/SaaS/comments/abc123/",
    subreddit: "SaaS",
    score: 12,
    numComments: 3,
  },
  author_handle: "jane_builder",
  author_id: null,
  status: "drafting",
  tier: "T1",
  classifier_label: "substantial",
  classifier_score: 92,
  priority: false,
  ...over,
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

describe("Reddit saved factual context", () => {
  const fact = "Oriole maps Atlas dependency graphs";
  it.each(["light", "substantial"])("saves the %s original review channels through repair and final review", async kind => {
    const { runner, postOutbound, markStatus } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify({ drafts: [
      { angle: "empathetic", body: fact }, { angle: "technical", body: "Atlas graph inspection matters" },
    ] }), engine: "fixture", model: "fixture" });
    let reviews = 0;
    const judge = vi.fn(async () => JSON.stringify({ voice: ++reviews === 1 ? 0.3 : 0.9, grounding: 0.9, relevance: 0.9, reasons: [] }));
    const kb = { search: vi.fn(async (_query: string, _limit: number, options?: { filterDirs?: string[] }) => [{ ...anchorHit(8),
      snippet: options?.filterDirs?.includes("product") ? fact : "Plain spoken" }]) };
    vi.stubEnv("TYPESAFE_API_KEY", ""); vi.stubEnv("AI_GATEWAY_API_KEY", "");
    try {
      await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ tier: "T2", classifier_label: kind })] as never, runner, kb: kb as never,
        postOutbound, markStatus, knowledgeDirs: ["product"], verify: { enabled: true, retries: 1, makeCalls: () => [judge] } });
      for (const row of postOutbound.mock.calls[0]![0].drafts) {
        expect(row.reviewContext).toMatchObject({ version: 1, platform: "reddit", postText: "We shipped our MVP\n\npost body",
          knowledgeAnchors: [fact], personProfile: null });
        for (const channel of ["operatorFacts", "conversation", "imageCaption"]) expect(row.reviewContext).not.toHaveProperty(channel);
      }
      expect(runner.draft).toHaveBeenCalledTimes(2);
      expect(judge.mock.calls.length).toBe(kind === "light" ? 2 : 4);
    } finally { vi.unstubAllEnvs(); }
  });

  it("reports excessive facts without outbound or a swallowed semantic-review error", async () => {
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

describe("runDrafterTick (reddit quality pipeline)", () => {
  it("keeps a strong substantial angle when its companion fails the voice floor", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify({ drafts: [
      { angle: "empathetic", body: "Weak companion" },
      { angle: "technical", body: "Supported technical detail 💀" },
    ] }), engine: "writer", model: "model" });
    const review = vi.spyOn(runtime, "verifyTiered").mockImplementation(async (drafts) => {
      const strong = drafts.length === 1 && drafts[0]!.body === "Supported technical detail";
      return { pass: strong, judgeOk: true, judgeProvider: "legacy", reasons: [], fix: null,
        scores: { voice: strong ? 0.9 : 0.4, grounding: 1, relevance: 1, format: 1, novelty: 1, diversity: 1 } };
    });
    try {
      expect(await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ tier: "T2" })] as never, runner, kb: kb as never, postOutbound, markStatus,
        verify: { enabled: true, retries: 0, voiceFloor: 0.7, makeCalls: () => [vi.fn()] },
      })).toBe(1);
      expect(postOutbound.mock.calls[0]![0].drafts).toEqual([expect.objectContaining({
        angle: "technical", body: "Supported technical detail",
        verifierMeta: expect.objectContaining({ pass: true, judgeOk: true, scores: expect.objectContaining({ voice: 0.9 }) }),
      })]);
    } finally { review.mockRestore(); }
  });

  it.each(["light", "substantial"])("reviews only cleaned retained %s replies", async (kind) => {
    const { postOutbound, runner, kb, markStatus } = deps();
    runner.draft.mockResolvedValue({ text: JSON.stringify({ drafts: [
      { angle: "empathetic", body: "First reply — specific 💀" },
      { angle: "technical", body: "Unused companion" },
    ] }), engine: "writer", model: "model" });
    const review = vi.spyOn(runtime, "verifyTiered").mockResolvedValue({
      pass: true, judgeOk: true, judgeProvider: "legacy", reasons: [], fix: null,
      scores: { voice: 1, grounding: 1, relevance: 1, format: 1, novelty: 1, diversity: 1 },
    });
    try {
      await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ classifier_label: kind, tier: "T3" })] as never,
        runner, kb: kb as never, postOutbound, markStatus,
        verify: { enabled: true, retries: 0, makeCalls: () => [vi.fn()] },
      });
      const queued = postOutbound.mock.calls[0]![0].drafts[0];
      expect(queued.body).not.toMatch(/—|💀/);
      expect(review.mock.calls.at(-1)![0]).toEqual([{ kind: "reply", angle: queued.angle, body: queued.body }]);
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

  it.each(["light", "substantial"])("saves provenance of the selected %s repair", async (kind) => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const response = (body: string, engine: string) => ({ text: JSON.stringify({ drafts: [{ angle: "empathetic", body }] }), engine, model: `${engine}-model` });
    runner.draft.mockResolvedValueOnce(response("Original body", "initial"))
      .mockResolvedValueOnce(response("Repair body", "repair"));
    const verdict = (pass: boolean) => ({ pass, judgeOk: true, judgeProvider: "legacy" as const, reasons: [], fix: "name the source detail",
      scores: { voice: pass ? 1 : 0.2, grounding: 1, relevance: 1, format: 1, novelty: 1, diversity: 1 },
    });
    const review = vi.spyOn(runtime, "verifyTiered").mockResolvedValueOnce(verdict(false)).mockResolvedValue(verdict(true));
    try {
      await runDrafterTick({ log, instance: { id: "i", org_id: "o" } as never,
        claimedLeads: [lead({ classifier_label: kind, tier: "T3" })] as never,
        runner, kb: kb as never, postOutbound, markStatus,
        verify: { enabled: true, retries: 1, makeCalls: () => [vi.fn()] },
      });
      expect(postOutbound.mock.calls[0]![0].drafts[0].body).toBe("Repair body");
      expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ status: "drafted", meta: expect.objectContaining({ engine: "repair", model: "repair-model" }) }));
    } finally { review.mockRestore(); }
  });

  it("T1 substantial: 3 comment angles, NO DM", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const body = postOutbound.mock.calls[0]![0];
    expect(body.platform).toBe("reddit");
    const replies = body.drafts.filter((d: { kind: string }) => d.kind === "reply");
    const dms = body.drafts.filter((d: { kind: string }) => d.kind === "dm");
    expect(replies).toHaveLength(3);
    expect(replies.map((r: { angle: string }) => r.angle)).toEqual(["empathetic", "technical", "contrarian"]);
    expect(dms).toHaveLength(0);
  });

  it("T2 substantial: 2 comment angles (empathetic, technical)", async () => {
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
    const replies = postOutbound.mock.calls[0]![0].drafts.filter((d: { kind: string }) => d.kind === "reply");
    expect(replies.map((r: { angle: string }) => r.angle)).toEqual(["empathetic", "technical"]);
  });

  it("T3 substantial: 1 comment angle (empathetic)", async () => {
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
    const replies = postOutbound.mock.calls[0]![0].drafts.filter((d: { kind: string }) => d.kind === "reply");
    expect(replies.map((r: { angle: string }) => r.angle)).toEqual(["empathetic"]);
  });

  // Regression (2026-07-19, Lyra sibling bug): the model often omits `char_count`
  // or emits garbage (null / string / float). charCount is recomputed off the
  // cleaned body in buildOutbound, so a bad count must never error the lead.
  it("drafts with missing/null/garbage char_count still post (count recomputed)", async () => {
    const { postOutbound, kb, markStatus } = deps();
    const runner = {
      draft: vi.fn().mockResolvedValue({
        text: JSON.stringify({
          drafts: [
            { angle: "empathetic", body: "solid launch" },
            { angle: "technical", body: "t", char_count: null },
            { angle: "contrarian", body: "c", char_count: "1" },
          ],
        }),
        engine: "claude-cli",
        model: "claude-sonnet-4-6",
      }),
    };
    const n = await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T1" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });

    expect(n).toBe(1);
    const replies = postOutbound.mock.calls[0]![0].drafts.filter((d: { kind: string }) => d.kind === "reply");
    expect(replies).toHaveLength(3);
    expect(replies[0].charCount).toBe([..."solid launch"].length);
    expect(markStatus).toHaveBeenCalledWith(expect.objectContaining({ leadId: "L", status: "drafted" }));
  });

  it("low-engagement lead drafts on the default model (sonnet)", async () => {
    const { postOutbound, runner, kb, markStatus } = deps();
    await runDrafterTick({
      log,
      instance: { id: "i", org_id: "o" } as never,
      claimedLeads: [lead({ tier: "T2" })] as never,
      runner: runner as never,
      kb: kb as never,
      postOutbound,
      markStatus,
    });
    expect(runner.draft.mock.calls[0]![0].routing.primary.model).toBe("claude-sonnet-4-6");
  });

  it("light: ONE short supportive reply (kind='reply'), uses the LIGHT system prompt", async () => {
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

  it("combines title + body into the post text the model reads", async () => {
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
    const prompt = runner.draft.mock.calls[0]![0].prompt as string;
    expect(prompt).toContain("We shipped our MVP");
    expect(prompt).toContain("post body");
    expect(prompt).toContain("r/SaaS");
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
