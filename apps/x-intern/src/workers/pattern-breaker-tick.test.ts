import { describe, expect, it, vi } from "vitest";
import { runPatternBreakerTick, runPatternRefineTick } from "./pattern-breaker-tick.js";
import type { RecentPost } from "../lib/pattern-breaker-db.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;
const instance = { id: "i", org_id: "o" } as never;

function corpus(): RecentPost[] {
  return [
    ...Array.from({ length: 6 }, (_, i) => ({ draftId: `d${i}`, body: `substantive take ${i}. congrats`, kind: "reply" as const, platform: "x" })),
    ...Array.from({ length: 4 }, (_, i) => ({ draftId: `c${i}`, body: `varied thought ${i} with no closer`, kind: "reply" as const, platform: "x" })),
  ];
}

const finding = JSON.stringify({
  findings: [
    {
      label: "tacked-on congrats closer",
      kind: "phrase",
      description: "Recent posts end with a bare 'congrats'.",
      instruction: "Do not end a substantive post with a bare 'congrats'.",
      regex: "congrats",
      severity: "high",
      frequencyCount: 6,
      examples: [],
    },
  ],
});

function runner(text: string) {
  return { draft: vi.fn().mockResolvedValue({ text, model: "m", engine: "e" }) };
}

describe("runPatternBreakerTick", () => {
  it("skips (returns 0) when the corpus is below minFrequency, without calling the LLM", async () => {
    const r = runner(finding);
    const persist = vi.fn();
    const out = await runPatternBreakerTick({
      log,
      instance,
      runner: r,
      loadCorpus: async () => [{ draftId: "a", body: "one post", kind: "reply", platform: "x" }],
      loadExistingLabels: async () => [],
      persist,
      minFrequency: 3,
    });
    expect(out).toBe(0);
    expect(r.draft).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("persists + emits one alert for a detected over-used pattern", async () => {
    const r = runner(finding);
    const persist = vi.fn().mockResolvedValue({ ruleId: "r1", alertId: "a1" });
    const emit = vi.fn().mockResolvedValue(undefined);
    const out = await runPatternBreakerTick({
      log,
      instance,
      runner: r,
      loadCorpus: async () => corpus(),
      loadExistingLabels: async () => [],
      persist,
      bus: { emit } as never,
      minFrequency: 3,
    });
    expect(out).toBe(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0]![0].label).toBe("tacked-on congrats closer");
    expect(persist.mock.calls[0]![1]).toBe(10); // tightest window
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0].topic).toBe("pattern.detected");
  });

  it("returns 0 (no persist) when the analyzer finds nothing", async () => {
    const r = runner(JSON.stringify({ findings: [] }));
    const persist = vi.fn();
    const out = await runPatternBreakerTick({
      log,
      instance,
      runner: r,
      loadCorpus: async () => corpus(),
      loadExistingLabels: async () => [],
      persist,
      minFrequency: 3,
    });
    expect(out).toBe(0);
    expect(persist).not.toHaveBeenCalled();
  });

  it("keeps going if one persist throws (counts only the survivors)", async () => {
    const twoFindings = JSON.stringify({
      findings: [
        { label: "congrats closer", kind: "phrase", description: "Recent posts end with a bare congrats.", instruction: "Stop ending posts with a bare congrats.", regex: "congrats", severity: "high", frequencyCount: 6, examples: [] },
        { label: "no closer at all", kind: "phrase", description: "Recent posts trail off with 'no closer'.", instruction: "Stop trailing off without a real closer.", regex: "no closer", severity: "low", frequencyCount: 4, examples: [] },
      ],
    });
    const r = runner(twoFindings);
    const persist = vi
      .fn()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce({ ruleId: "r2", alertId: "a2" });
    const out = await runPatternBreakerTick({
      log,
      instance,
      runner: r,
      loadCorpus: async () => corpus(),
      loadExistingLabels: async () => [],
      persist,
      minFrequency: 3,
    });
    expect(out).toBe(1);
    expect(persist).toHaveBeenCalledTimes(2);
  });
});

describe("runPatternRefineTick", () => {
  const claim = vi.fn(async (item) => item.rule_id && item.current_instruction
    ? { ...item, refine_request_id: "request", refine_claim_id: "claim", sourcePosts: [] } : null);
  const queueItem = {
    alert_id: "a1",
    rule_id: "r1",
    pattern_name: "congrats closer",
    description: "ends posts with congrats",
    current_instruction: "Do not end with a bare congrats.",
    examples: [],
    refine_note: "fine when it's a genuine win",
    refine_request_id: "request", rule_updated_at: "version", rule_snapshot: "fingerprint",
  };

  it("returns 0 when the queue is empty (no LLM call)", async () => {
    const r = runner("{}");
    const applyRefined = vi.fn();
    const out = await runPatternRefineTick({ log, instance, runner: r, loadQueue: async () => [], claim, applyRefined });
    expect(out).toBe(0);
    expect(r.draft).not.toHaveBeenCalled();
  });

  it("rewrites the rule and marks it refined", async () => {
    const r = runner(JSON.stringify({ instruction: "Only add congrats when the post is a genuine win." }));
    const applyRefined = vi.fn().mockResolvedValue(true);
    const emit = vi.fn().mockResolvedValue(undefined);
    const out = await runPatternRefineTick({
      log, instance, runner: r, bus: { emit } as never,
      loadQueue: async () => [queueItem],
      claim, applyRefined,
    });
    expect(out).toBe(1);
    expect(applyRefined).toHaveBeenCalledTimes(1);
    expect(applyRefined.mock.calls[0]![0].instruction).toContain("genuine win");
    expect(emit.mock.calls[0]![0].topic).toBe("pattern.refined");
  });

  it("reports unusable output without claiming a refinement", async () => {
    const r = runner("garbage not json");
    const applyRefined = vi.fn().mockResolvedValue(false);
    const out = await runPatternRefineTick({ log, instance, runner: r, loadQueue: async () => [queueItem], claim, applyRefined });
    expect(out).toBe(0);
    expect(applyRefined.mock.calls[0]![0].instruction).toBeNull();
  });

  it("skips a queued alert whose rule was deleted", async () => {
    const r = runner("{}");
    const applyRefined = vi.fn();
    const out = await runPatternRefineTick({
      log, instance, runner: r, claim, applyRefined,
      loadQueue: async () => [{ ...queueItem, rule_id: null, current_instruction: null } as never],
    });
    expect(out).toBe(0);
    expect(applyRefined).not.toHaveBeenCalled();
  });
});
