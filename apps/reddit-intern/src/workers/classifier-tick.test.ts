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
