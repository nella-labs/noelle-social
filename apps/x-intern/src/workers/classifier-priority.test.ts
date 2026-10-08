import { describe, expect, it, vi } from "vitest";
import { createBudgetedBackend, unlimitedBudget, type CapAdapters } from "@noelle/runtime";
import { classifyOneLead, classifierBudgetBlock } from "./classifier-tick.js";
import { createClassifier } from "../lib/classifier-engine.js";

const meteredOnBrand = {
  on_brand: true,
  on_brand_reason: "ok",
  kind: "question",
  velocity_score: 40,
  tier: "T2" as const,
  usage: { inputTokens: 300, outputTokens: 20 },
  raw: {},
};

// A tagged-template sql mock that records the interpolated values so we can
// assert what markLeadClassified wrote without a real database.
function makeSql() {
  const values: unknown[] = [];
  const sql = Object.assign(
    vi.fn(async (_strings: TemplateStringsArray, ...vals: unknown[]) => {
      values.push(...vals);
      return [];
    }),
    { json: (x: unknown) => x, unsafe: vi.fn() },
  );
  return { sql: sql as never, values };
}

const baseLead = {
  id: "L",
  external_id: "x",
  payload: { text: "hi" },
  author_handle: "u",
  author_id: "uid",
  tier: null,
  classifier_label: null,
  classifier_score: null,
  status: "classifying",
};

describe("classifyOneLead", () => {
  // CONTRACT CHANGE (#503 follow-up, port of Lyra #323): a watchlist lead is no
  // longer BYPASSED with a forged score=1 / tier=T1. It is classified like any
  // other lead and merely PROTECTED from a skip verdict — otherwise ~70% of
  // Vega's drafted output was never graded at all.
  const clsOut = (over: Record<string, unknown> = {}) => ({
    on_brand: true,
    on_brand_reason: "ok",
    kind: "question",
    velocity_score: 40,
    q: 70,
    reply_kind: "substantial",
    comment_bait: false,
    tier: "T3",
    ai_slop: false,
    ai_slop_reason: null,
    vip: null,
    usage: { inputTokens: 0, outputTokens: 0 },
    raw: {},
    ...over,
  });

  const icp = { headlineKeywords: ["founder", "devtools"], headlineExcludeKeywords: ["crypto"] };

  it("does not clamp a rejected browser observation from a watched author", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn();
    const classifyObserved = vi.fn().mockResolvedValue(clsOut({
      on_brand: false, reply_kind: "skip", q: 60, tier: null,
      raw: { judge: "jev", probability: 0.6 },
    }));
    await classifyOneLead({
      sql, classifier: { classify, classifyObserved }, notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false, classifier_threshold: 80 },
      lead: { ...baseLead, priority: true, payload: { text: "Specific founder lesson", source: "extension_observed" } },
      log: { warn: vi.fn() },
    });
    expect(classifyObserved).toHaveBeenCalledWith(expect.anything(), 80);
    expect(classify).not.toHaveBeenCalled();
    expect(values).toContain("skipped");
    expect(values).not.toContain("light");
  });

  it.each([
    { name: "explicit 30", threshold: 30, status: "classified" },
    { name: "unconfigured 80 floor", threshold: null, status: "skipped" },
  ])("honors the browser observation threshold: $name", async ({ threshold, status }) => {
    const { sql, values } = makeSql();
    const classifier = createClassifier({
      backend: { call: vi.fn() } as never,
      evaluate: vi.fn().mockResolvedValue({
        kind: "choice", choice: "substantial", probability: 0.79,
        probabilities: { substantial: 0.79, light: 0.12, skip: 0.09 },
        provider: "jev",
      }),
    });
    await classifyOneLead({
      sql, classifier, notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", classifier_threshold: threshold },
      observedThreshold: 50,
      lead: { ...baseLead, priority: false, payload: {
        text: "We changed onboarding after users showed us where they got stuck",
        source: "extension_observed",
      } },
      log: { warn: vi.fn() },
    });
    expect(values[0]).toBe(status);
  });

  it("requeues a browser observation when Jev is unavailable", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn();
    const outcome = await classifyOneLead({
      sql,
      classifier: { classify, classifyObserved: vi.fn().mockResolvedValue(null) },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, priority: false, payload: { text: "Specific founder lesson", source: "extension_observed" } },
      log: { warn: vi.fn() },
    });
    expect(outcome).toBe("jev_unavailable");
    expect(values).toContain("observed");
    expect(values).not.toContain("classified");
    expect(classify).not.toHaveBeenCalled();
  });

  it.each([undefined, new Date(Date.now() - 2 * 60 * 60_000).toISOString(),
    new Date(Date.now() - 31 * 24 * 60 * 60_000).toISOString()])(
    "keeps a Jev-qualified post eligible with timestamp %s",
    async (postedAt) => {
      const { sql, values } = makeSql();
      const classifyObserved = vi.fn().mockResolvedValue(clsOut({
        q: 92, tier: "T1", raw: { judge: "jev", probability: 0.92 },
      }));
      await classifyOneLead({
        sql, classifier: { classify: vi.fn(), classifyObserved },
        notifier: { notify: vi.fn() },
        inst: { id: "i", org_id: "o", notify_low_confidence: false },
        lead: { ...baseLead, priority: false, payload: {
          text: "Specific founder lesson", source: "extension_observed", ...(postedAt ? { posted_at: postedAt } : {}),
        } },
        log: { warn: vi.fn() },
      });
      expect(values).toContain("classified");
      expect(values).toContain(0.92);
      expect(values).toContain("noelle_x_priority");
    },
  );

  it("drops an off-ICP author BEFORE the LLM call when icp_config is set", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn();
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false, icp_config: icp },
      lead: { ...baseLead, priority: false, payload: { ...baseLead.payload, author_bio: "crypto degen, NFTs" } },
      log: { warn: vi.fn() },
    });
    // The whole point: no classifier spend on someone never in the ICP.
    expect(classify).not.toHaveBeenCalled();
    expect(values).toContain("off_icp");
  });

  it("keeps an ON-ICP author and still classifies them", async () => {
    const { sql } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut());
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false, icp_config: icp },
      lead: { ...baseLead, priority: false, payload: { ...baseLead.payload, author_bio: "founder, building devtools" } },
      log: { warn: vi.fn() },
    });
    expect(classify).toHaveBeenCalled();
  });

  it("FAILS OPEN on a missing bio — the actor often omits it", async () => {
    // Failing closed here would silently kill the entire keyword lane the first
    // time the Apify actor changed its payload shape.
    const { sql } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut());
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false, icp_config: icp },
      lead: { ...baseLead, priority: false },
      log: { warn: vi.fn() },
    });
    expect(classify).toHaveBeenCalled();
  });

  it("never gates a PRIORITY lead on ICP (the operator already chose them)", async () => {
    const { sql } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut());
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false, icp_config: icp },
      lead: { ...baseLead, priority: true, payload: { ...baseLead.payload, author_bio: "crypto degen, NFTs" } },
      log: { warn: vi.fn() },
    });
    expect(classify).toHaveBeenCalled();
  });

  it("stays OFF when icp_config has no keywords (byte-identical)", async () => {
    const { sql } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut());
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false, icp_config: { headlineKeywords: [] } },
      lead: { ...baseLead, priority: false, payload: { ...baseLead.payload, author_bio: "crypto degen" } },
      log: { warn: vi.fn() },
    });
    expect(classify).toHaveBeenCalled();
  });

  // A notification lead is someone who REPLIED TO US. The classifier's rules are
  // written for cold discovery and actively disqualify a conversation — SYSTEM_X
  // lists "replies to threads" as off-brand, and these are by definition replies.
  // Live data: 8 of 8 were classified 'reply'/'other' and skipped, so the
  // notifications actor produced nothing.
  const convoLead = {
    ...baseLead,
    priority: false,
    payload: { ...baseLead.payload, source: "notification" },
  };

  it("CLAMPS a skip verdict on a conversation lead (they spoke to us first)", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut({ reply_kind: "skip", q: 60, tier: null }));
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: convoLead,
      log: { warn: vi.fn() },
    });
    expect(values).toContain("light");
    expect(values).toContain("classified");
  });

  it("does not drop a conversation lead on the AI-slop or follower floors", async () => {
    for (const over of [{ ai_slop: true }, { q: 70, tier: "T3" }]) {
      const { sql, values } = makeSql();
      const classify = vi.fn().mockResolvedValue(clsOut(over));
      await classifyOneLead({
        sql,
        classifier: { classify },
        notifier: { notify: vi.fn() },
        inst: { id: "i", org_id: "o", notify_low_confidence: false },
        lead: {
          ...convoLead,
          payload: { ...convoLead.payload, author_followers: 30 },
        },
        log: { warn: vi.fn() },
      });
      expect(values).toContain("classified");
    }
  });

  it("still honours the off-topic floor for a conversation lead", async () => {
    // Protection is not a blank cheque: a genuinely off-topic reply is still a
    // skip, exactly as for a hand-picked watchlist person.
    const { sql, values } = makeSql();
    const classify = vi
      .fn()
      .mockResolvedValue(clsOut({ reply_kind: "skip", q: 5, on_brand: false, tier: null }));
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: convoLead,
      log: { warn: vi.fn() },
    });
    expect(values).not.toContain("light");
  });

  it("CLASSIFIES a priority lead instead of bypassing it", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut());
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, priority: true },
      log: { warn: vi.fn() },
    });
    expect(classify).toHaveBeenCalled();
    expect(values).toContain("classified");
    // Graded on its real reply-worthiness (q=70 → 0.7), not a forged 1.
    expect(values).not.toContain(1);
  });

  it("CLAMPS a skip verdict on a priority lead to light (the person is the gate)", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut({ reply_kind: "skip", q: 60, tier: null }));
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, priority: true },
      log: { warn: vi.fn() },
    });
    // Rescued: labelled 'light' and status 'classified' (markLeadClassified only
    // writes that when onBrand is true), so it reaches the drafter.
    expect(values).toContain("light");
    expect(values).toContain("classified");
  });

  it("honours the skip when a priority lead is genuinely OFF-TOPIC (below the floor)", async () => {
    const { sql, values } = makeSql();
    // q=5 is far below CLAMP_MIN_Q (25): a hand-picked person posting something
    // unrelated is still a skip. "The person is the gate" must not become
    // "reply to anything they post".
    const classify = vi.fn().mockResolvedValue(clsOut({ reply_kind: "skip", q: 5, on_brand: false, tier: null }));
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, priority: true },
      log: { warn: vi.fn() },
    });
    expect(values).not.toContain("light");
  });

  // The engine's REAL fail-open shape: q null AND reply_kind forced to
  // 'substantial' (a q:null + reply_kind:'skip' pair is unreachable, so mocking
  // it proved nothing). Paired with a mid-size follower count, this is the
  // outage case that actually used to drop a watched person.
  it("never drops a priority lead when scoring FAILED (real fail-open shape)", async () => {
    const { sql, values } = makeSql();
    const classify = vi
      .fn()
      .mockResolvedValue(clsOut({ reply_kind: "substantial", q: null, tier: null }));
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: {
        ...baseLead,
        priority: true,
        payload: { ...baseLead.payload, author_followers: 300 },
      },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("classified");
  });

  it("does NOT drop a small watched author on the follower floor", async () => {
    // The floor grades strangers. Before the exemption, removing the bypass made
    // a 300-follower hand-picked author terminal-skip unless they scored T1.
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut({ q: 70, tier: "T3" }));
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: {
        ...baseLead,
        priority: true,
        payload: { ...baseLead.payload, author_followers: 300 },
      },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("classified");
  });

  it("STILL applies the follower floor to a stranger", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(clsOut({ q: 70, tier: "T3" }));
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: {
        ...baseLead,
        priority: false,
        payload: { ...baseLead.payload, author_followers: 12 },
      },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("skipped");
  });

