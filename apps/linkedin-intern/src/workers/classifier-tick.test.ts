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

// An off-topic skip scored just below the clamp floor (an ISTE-board / hiring
// repost from an algorithmically-discovered author): q=15, outside the configured topic.
const skipOffTopic = {
  q: 15,
  reply_kind: "skip" as const,
  tier: null,
  reason: "off-topic from dev tools, startups, and founder GTM",
  comment_bait: false,
  usage: { inputTokens: 150, outputTokens: 8 },
  raw: { q: 15, reply_kind: "skip", tier: null, reason: "off-topic" },
};

// A genuine personal milestone the engine under-rated to 'skip' but still scored
// above the off-topic floor — the kind of post a hand-picked connection makes
// that deserves a short warm note ('Turning 50 today …').
const skipMilestone = {
  q: 35,
  reply_kind: "skip" as const,
  tier: null,
  reason: "personal milestone from a real person",
  comment_bait: false,
  usage: { inputTokens: 150, outputTokens: 8 },
  raw: { q: 35, reply_kind: "skip", tier: null, reason: "personal milestone" },
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
  payload: { text: "we keep losing context", authorName: "Jane", authorHeadline: "Founder" },
  author_handle: "jane-builder",
  author_id: "ABC123",
  tier: null,
  classifier_label: null,
  classifier_score: null,
  status: "classifying",
  priority: false,
};

describe("classifyOneLead (linkedin)", () => {
  it("never rescues a Jev-rejected browser observation because the author is watched", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn();
    const classifyObserved = vi.fn().mockResolvedValue({ ...skipMilestone, provider: "jev" });
    await classifyOneLead({
      sql, classifier: { classify, classifyObserved }, notifier: { notify: vi.fn() },
      inst: { id: "i", org_id: "o" },
      lead: { ...baseLead, priority: true, payload: { ...baseLead.payload, source: "extension_observed" } },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("skipped");
    expect(values).not.toContain("light");
    expect(classify).not.toHaveBeenCalled();
  });

  it("retains an observed post for retry when Jev is unavailable", async () => {
    const { sql, values } = makeSql();
    const classify = vi.fn();
    const result = await classifyOneLead({
      sql, classifier: { classify, classifyObserved: vi.fn().mockResolvedValue(null) },
      notifier: { notify: vi.fn() }, inst: { id: "i", org_id: "o" },
      lead: { ...baseLead, status: "observed_classifying", payload: { ...baseLead.payload, source: "extension_observed" } },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("observed");
    expect(result).toBe("jev_unavailable");
    expect(values).not.toContain("classified");
    expect(values).not.toContain("substantial");
    expect(classify).not.toHaveBeenCalled();
  });

  it("holds a Jev-qualified browser card for identity resolution before drafting", async () => {
    const { sql, values } = makeSql();
    const classifyObserved = vi.fn().mockResolvedValue({ ...substantial, provider: "jev" });
    await classifyOneLead({
      sql, classifier: { classify: vi.fn(), classifyObserved },
      notifier: { notify: vi.fn() }, inst: { id: "i", org_id: "o" },
      lead: { ...baseLead, external_id: "browser:opaque-card", status: "observed_classifying", payload: { ...baseLead.payload, source: "extension_observed", reactionCount: 22, commentCount: 4 } },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("identity_pending");
    expect(values).not.toContain("classified");
    expect(values).not.toContain("noelle_linkedin_priority");
    expect(values).toContain(0.92);
    expect(classifyObserved).toHaveBeenCalledWith(expect.objectContaining({
      postText: "we keep losing context", reactionCount: 22, commentCount: 4,
    }));
  });

  it("wakes the drafter only after a canonical browser observation qualifies through Jev", async () => {
    const { sql, values } = makeSql();
    await classifyOneLead({
      sql, classifier: { classify: vi.fn(), classifyObserved: vi.fn().mockResolvedValue({ ...substantial, provider: "jev" }) },
      notifier: { notify: vi.fn() }, inst: { id: "i", org_id: "o" },
      lead: { ...baseLead, external_id: "7507055234809114626", status: "observed_classifying", payload: {
        ...baseLead.payload, source: "extension_observed", urn: "urn:li:activity:7507055234809114626",
        url: "https://www.linkedin.com/feed/update/urn:li:activity:7507055234809114626/",
      } },
      log: { warn: vi.fn() },
    });
    expect(values).toContain("classified");
    expect(values).toContain("noelle_linkedin_priority");
    expect(values).toContain("i");
  });

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
