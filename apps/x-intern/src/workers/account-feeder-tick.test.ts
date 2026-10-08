import { describe, it, expect, vi } from "vitest";
import { BudgetExceededError, createBudgetedBackend, unlimitedBudget } from "@noelle/runtime";
import { UltraProfileOutput, runAccountFeederTick, type FeederTickDeps } from "./account-feeder-tick.js";

// gemini-2-5-flash is shape-wobbly on the ultra-profile fields — it frequently
// returns `tone` as an array of adjectives. The schema must COERCE (not reject),
// or a perfectly good extraction gets dropped (profilesWritten:0). See the fix in
// account-feeder-tick.ts (flexString / flexStringArray).
describe("UltraProfileOutput (extractor schema)", () => {
  it("coerces a `tone` returned as an array into a joined string", () => {
    const parsed = UltraProfileOutput.safeParse({
      voice_summary: "direct and practical",
      tone: ["direct", "casual", "motivational"],
      structure_notes: "short declaratives",
      hook_patterns: ["they don't know..."],
      signature_phrases: ["make no mistakes"],
      top_topics: ["startups"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.tone).toBe("direct, casual, motivational");
      expect(parsed.data.voice_summary).toBe("direct and practical");
      expect(parsed.data.hook_patterns).toEqual(["they don't know..."]);
    }
  });

  it("coerces a bare string into a 1-item list, and fills defaults for missing keys", () => {
    const parsed = UltraProfileOutput.safeParse({ hook_patterns: "single hook" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.hook_patterns).toEqual(["single hook"]);
      expect(parsed.data.tone).toBe("");
      expect(parsed.data.top_topics).toEqual([]);
    }
  });

  it("still accepts a well-formed profile unchanged", () => {
    const parsed = UltraProfileOutput.safeParse({
      voice_summary: "v",
      tone: "blunt",
      structure_notes: "s",
      hook_patterns: ["a", "b"],
      signature_phrases: ["c"],
      top_topics: ["d"],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.tone).toBe("blunt");
  });
});

describe("feeder backend admission", () => {
  function fixture(blocked = false) {
    const record = vi.fn().mockResolvedValue(undefined);
    const call = vi.fn(async () => ({ text: JSON.stringify({ voice_summary: "direct" }),
      usage: { input_tokens: 100, output_tokens: 20 } }));
    const reserveAttempt = vi.fn(async () => {
      if (blocked) throw new BudgetExceededError({ layer: "org", spent_cents: 10, cap_cents: 10, estimated_cents: 1 });
      return { attemptId: "style_attempt" };
    });
    const deps: FeederTickDeps = {
      log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as unknown as FeederTickDeps["log"],
      instance: { id: "i", org_id: "o" } as FeederTickDeps["instance"],
      sources: [{ id: "source", platform: "x", handle: "builder" } as FeederTickDeps["sources"][number]],
      apify: { userTweets: vi.fn(async () => ({ tweets: [{ id: "post", text: "Useful detail", likes: 1 }],
        resultCount: 1, resultCountComplete: true })) } as unknown as FeederTickDeps["apify"],
      extractor: createBudgetedBackend({ call }, { engine: "vertex",
        context: { orgId: "o", instanceId: "i", agentRole: "x_intern", worker: "x_feeder", bucket: "feeder" },
        budget: { adapters: { ...unlimitedBudget.adapters, reserveAttempt }, estimateCents: () => 1 }, recorder: { record } }),
      recorder: { record }, upsertStylePosts: vi.fn(async (rows) => rows.length),
      getCorpus: vi.fn(async () => [{ externalId: "post", kind: "post" as const, body: "Useful detail", likeCount: 1,
        commentCount: 0, postedAt: null }]),
      upsertUltraProfile: vi.fn(async () => {}), markSourcePulled: vi.fn(async () => {}),
    };
    return { deps, record, call, reserveAttempt };
  }
  it("records one Apify receipt and exactly one admitted extractor receipt", async () => {
    const s = fixture();
    expect((await runAccountFeederTick(s.deps)).profilesWritten).toBe(1);
    expect(s.reserveAttempt).toHaveBeenCalledOnce();
    expect(s.record).toHaveBeenCalledTimes(2);
    expect(s.record.mock.calls.map(([r]) => r.engine).sort()).toEqual(["apify", "vertex"]);
    expect(s.record.mock.calls.find(([r]) => r.engine === "vertex")?.[0]).toMatchObject({ attemptId: "style_attempt" });
  });
  it("keeps missing source measurements unknown at the corpus write boundary", async () => {
    const s = fixture();
    vi.mocked(s.deps.apify.userTweets).mockResolvedValue({ tweets: [{ id: "post", text: "Saved detail" }],
      resultCount: 1, resultCountComplete: true } as never);
    await runAccountFeederTick(s.deps);
    expect(vi.mocked(s.deps.upsertStylePosts).mock.calls[0]?.[0][0]).toMatchObject({ likeCount: null, commentCount: null });
  });
  it("passes measured-only corpus averages and sample IDs to the profile writer", async () => {
    const s = fixture();
    vi.mocked(s.deps.getCorpus).mockResolvedValue([
      { externalId: "unknown", kind: "post", body: "Unknown source text", likeCount: null, commentCount: null, postedAt: null },
      { externalId: "known", kind: "post", body: "Measured source text", likeCount: 20, commentCount: 4, postedAt: null },
    ]);
    await runAccountFeederTick(s.deps);
    expect(vi.mocked(s.deps.upsertUltraProfile).mock.calls[0]?.[0]).toMatchObject({ avgLikeCount: 20,
      avgCommentCount: 4, samplePostIds: ["known"] });
  });
  it("retains corpus while rejecting an extractor before provider dispatch", async () => {
    const s = fixture(true);
    const result = await runAccountFeederTick(s.deps);
    expect(result).toMatchObject({ corpusRows: 1, profilesWritten: 0 });
    expect(s.call).not.toHaveBeenCalled();
    expect(s.deps.upsertUltraProfile).not.toHaveBeenCalled();
    expect(s.record.mock.calls.find(([r]) => r.engine === "vertex")?.[0]).toMatchObject({ status: "budget_exceeded", cents: 0 });
  });
  it("binds each returned embedding to the exact captured source text", async () => {
    const { deps } = fixture();
    const body = "  Captured café\n";
    deps.sources = [];
    deps.listUnembeddedStylePosts = async () => [{ id: "post", body }];
    deps.embed = async texts => { expect(texts).toEqual([body]); return [[1, 0]]; };
    deps.updateStylePostEmbeddings = async rows =>
      rows.filter(row => row.body === body).length;
    expect((await runAccountFeederTick(deps)).embeddedRows).toBe(1);
  });
});
