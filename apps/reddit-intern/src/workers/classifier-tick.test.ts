import { createClassifier } from "../lib/classifier-engine.js";
import { describe, expect, it, vi } from "vitest";
import { createBudgetedBackend, unlimitedBudget, type CapAdapters } from "@noelle/runtime";
import { classifyOneLead, classifierBudgetBlock } from "./classifier-tick.js";

const substantial = {
  q: 92,
  reply_kind: "substantial" as const,
  tier: "T1" as const,
  reason: "real technical pain",
  comment_bait: false,
  usage: { inputTokens: 300, outputTokens: 20 },
  raw: { q: 92, reply_kind: "substantial", tier: "T1", reason: "real technical pain" },
};

const light = {
  q: 60,
  reply_kind: "light" as const,
  tier: null,
  reason: "launch win",
  comment_bait: false,
  usage: { inputTokens: 200, outputTokens: 10 },
  raw: { q: 60, reply_kind: "light", tier: null, reason: "launch win" },
};

const skip = {
  q: 8,
  reply_kind: "skip" as const,
  tier: null,
  reason: "job promo",
  comment_bait: false,
  usage: { inputTokens: 150, outputTokens: 8 },
  raw: { q: 8, reply_kind: "skip", tier: null, reason: "job promo" },
};

const baitLight = {
  q: 65,
  reply_kind: "light" as const,
  tier: null,
  reason: "comment-to-enter giveaway",
  comment_bait: true,
  usage: { inputTokens: 180, outputTokens: 9 },
  raw: { q: 65, reply_kind: "light", tier: null, reason: "comment-to-enter giveaway" },
};

// A tagged-template sql mock that records interpolated values so we can assert
// what markLeadClassified wrote without a real database. Mirrors x-intern.
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
  external_id: "act1",
  payload: { title: "we keep losing context", text: "any tips?", subreddit: "SaaS" },
  author_handle: "jane-builder",
  author_id: "ABC123",
  tier: null,
  classifier_label: null,
  classifier_score: null,
  status: "classifying",
  priority: false,
};

describe("classifyOneLead (reddit)", () => {
  it("classifies a substantial lead → status 'classified', label 'substantial', score=q, tier from band", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(substantial);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(values).toContain("classified");
    expect(values).toContain("substantial");
    expect(values).toContain(0.92); // score = q/100, normalised to 0-1
    expect(values).not.toContain(92); // never the raw 0-100 q (the 7800/100 bug)
    expect(values).toContain("T1");
  });

  it("normalises the 0-100 q into a 0-1 classifier_score (shared approval UI multiplies by 100)", async () => {
    // Regression: LinkedIn stored the raw 0-100 q while the approval UI does
    // Math.round(score * 100), rendering "7800/100" for a q=78 lead. The stored
    // score must be 0-1 like the X intern so the shared UI shows "78/100".
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue({ ...substantial, q: 78 });
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    const stored = values.find((v) => typeof v === "number" && v > 0 && v <= 1);
    expect(stored).toBeCloseTo(0.78, 10);
    expect(values).not.toContain(78); // never the raw 0-100 q
  });

  it("classifies a light lead → status 'classified', label 'light', tier null", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(light);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("classified");
    expect(values).toContain("light");
    expect(values).toContain(0.6); // score = q/100, normalised to 0-1
    expect(values).toContain(null); // tier null
  });

  it("classifies a skip lead → status 'skipped', label 'skip'", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(skip);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("skipped");
    expect(values).toContain("skip");
  });

  it("clamps a SKIP to 'light' for a PRIORITY (vetted-person) lead — never hard-skips", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(skip);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, priority: true }, // profile-first vetted lead
      log: { warn: vi.fn() },
    });
    // The person is the gate, not the post: a skip becomes a light comment.
    expect(values).toContain("classified");
    expect(values).toContain("light");
    expect(values).not.toContain("skipped");
  });

  it("does NOT clamp a skip for a non-priority lead (watchlist/keyword lanes)", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(skip);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, priority: false },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("skipped");
  });

  it("leaves a PRIORITY substantial lead unchanged (clamp only touches skip)", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(substantial);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, priority: true },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("substantial");
    expect(values).toContain("T1");
  });

  it("persists comment_bait=true on the lead when the classifier flags engagement-bait", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(baitLight);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    // markLeadClassified writes comment_bait = true into the UPDATE.
    expect(values).toContain(true);
  });

  it("persists comment_bait=false for a normal lead", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(substantial);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    expect(values).toContain(false);
  });

  const frenchText =
    "Nous avons lancé notre nouvelle application et les retours sont très positifs";

  it("skips a non-English (French) lead before any classify call → status 'skipped'", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn();
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, payload: { ...baseLead.payload, title: frenchText, text: "" } },
      log: { warn: vi.fn() },
    });
    expect(classify).not.toHaveBeenCalled();
    expect(values).toContain("skipped");
    expect(values).toContain("skip"); // reply_kind/classifier_label = 'skip'
    const meta = values.find(
      (v) => v && typeof v === "object" && (v as { classifier?: { skip_reason?: string } }).classifier?.skip_reason,
    ) as { classifier: { skip_reason: string } } | undefined;
    expect(meta?.classifier.skip_reason).toBe("non-english");
  });

  it("skips a non-English lead even when priority is set (gate covers all leads)", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn();
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, priority: true, payload: { ...baseLead.payload, title: frenchText, text: "" } },
      log: { warn: vi.fn() },
    });
    expect(classify).not.toHaveBeenCalled();
    expect(values).toContain("skipped");
  });

  it("still classifies a clearly-English lead (not flagged non-English)", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue(substantial);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead, payload: { ...baseLead.payload, title: "we keep losing context across sessions, any tips?", text: "" } },
      log: { warn: vi.fn() },
    });
    expect(classify).toHaveBeenCalledTimes(1);
    expect(values).toContain("classified");
  });

  it("passes the post text + author name/headline to the classifier engine", async () => {
    const { sql } = makeSql();
    const classify = vi.fn().mockResolvedValue(substantial);
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    expect(classify).toHaveBeenCalledWith({
      postText: "we keep losing context\n\nany tips?",
      authorName: "jane-builder",
      authorHeadline: "posted in r/SaaS",
    });
  });

  it("records one admitted receipt for the actual classifier backend", async () => {
    const { sql } = makeSql();
    const record = vi.fn().mockResolvedValue(undefined);
    const reserveAttempt = vi.fn(async () => ({ attemptId: "classifier_attempt" }));
    const backend = createBudgetedBackend({ call: async () => ({
      text: JSON.stringify({ q: 92, reply_kind: "substantial", tier: "T1", reason: "specific question" }), usage: { input_tokens: 300, output_tokens: 20 },
    }) }, { engine: "vertex", context: { orgId: "o", instanceId: "i", agentRole: "reddit_intern", worker: "classifier", bucket: "classifier" },
      budget: { adapters: { ...unlimitedBudget.adapters, reserveAttempt }, estimateCents: () => 1 }, recorder: { record } });
    const classifier = createClassifier({ backend, evaluate: async () => ({ kind: "unavailable", provider: "jev" }) });
    await classifyOneLead({ sql, classifier, notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false }, lead: { ...baseLead },
      log: { warn: vi.fn() } });
    expect(reserveAttempt).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
    expect(record.mock.calls[0]?.[0]).toMatchObject({ attemptId: "classifier_attempt", engine: "vertex",
      worker: "classifier", bucket: "classifier", agentRole: "reddit_intern", inputTokens: 300 });
  });


  it("a fail-open lead is kept (status 'classified'), never silently lost", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn().mockResolvedValue({
      q: null,
      reply_kind: "light",
      tier: null,
      reason: "fail-open: vertex 500",
      usage: { inputTokens: 0, outputTokens: 0 },
      raw: { fail_open: "vertex 500" },
    });
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o", notify_low_confidence: false },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("classified");
    expect(values).not.toContain("skipped");
  });

  it("notifies on a skip when notify_low_confidence is set", async () => {
    const { sql } = makeSql();
    const classify = vi.fn().mockResolvedValue(skip);
    const notify = vi.fn().mockResolvedValue({ status: "sent" });
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify },
      inst: { id: "i", org_id: "o", notify_low_confidence: true },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("does NOT notify on a kept (substantial) lead even with notify_low_confidence", async () => {
    const { sql } = makeSql();
    const classify = vi.fn().mockResolvedValue(substantial);
    const notify = vi.fn();
    await classifyOneLead({
      sql,
      classifier: { classify },
      notifier: { notify },
      inst: { id: "i", org_id: "o", notify_low_confidence: true },
      lead: { ...baseLead },
      log: { warn: vi.fn() },
    });
    expect(notify).not.toHaveBeenCalled();
  });
});

describe("classifierBudgetBlock", () => {
  const adapters = (
    spend: { bucket: number; org: number; instance: number },
    cap: { bucket: number; org: number; instance: number },
  ): CapAdapters => ({
    fetchSpend: async () => spend,
    fetchCaps: async () => cap,
  });

  it("returns the BudgetExceededError when the classifier bucket is at cap", async () => {
    const blocked = await classifierBudgetBlock(
      adapters({ bucket: 100, org: 100, instance: 100 }, { bucket: 50, org: 9_999_999, instance: 9_999_999 }),
      { orgId: "o", instanceId: "i" },
    );
    expect(blocked).not.toBeNull();
    expect(blocked?.layer).toBe("bucket");
  });

  it("returns null when under every cap layer", async () => {
    const blocked = await classifierBudgetBlock(
      adapters({ bucket: 0, org: 0, instance: 0 }, { bucket: 1000, org: 1000, instance: 1000 }),
      { orgId: "o", instanceId: "i" },
    );
    expect(blocked).toBeNull();
  });

  it("never blocks claude-cli, even with every layer over cap (flat-rate, cents=0)", async () => {
    const blocked = await classifierBudgetBlock(
      adapters({ bucket: 100, org: 100, instance: 100 }, { bucket: 50, org: 50, instance: 50 }),
      { orgId: "o", instanceId: "i", engine: "claude-cli" },
    );
    expect(blocked).toBeNull();
  });

  it("propagates non-budget errors (does not silently skip the tick)", async () => {
    const broken: CapAdapters = {
      fetchSpend: async () => {
        throw new Error("db down");
      },
      fetchCaps: async () => ({ bucket: 1, org: 1, instance: 1 }),
    };
    await expect(
      classifierBudgetBlock(broken, { orgId: "o", instanceId: "i" }),
    ).rejects.toThrow("db down");
  });
});
