import { describe, it, expect } from "vitest";
import { distillUltraProfile, type TeardownWithMetrics } from "./distill.js";
import type { VideoTeardown } from "@noelle/contracts";

function td(over: Partial<VideoTeardown> = {}): VideoTeardown {
  return {
    hook: { text: "stop scrolling", type: "pattern_interrupt", reason: "abrupt visual" },
    beats: [{ tStart: 0, tEnd: 3, purpose: "hook" }, { tStart: 3, tEnd: 10, purpose: "payoff" }],
    transitions: [{ t: 3, type: "jump_cut" }],
    onscreen: [],
    pacing: { cutsPerSec: 1, avgBeatSec: 3, wordsPerSec: 2 },
    cta: { present: true, text: "follow", placement: "end" },
    sound: { trending: true, energy: "high" },
    whyItWorked: "fast",
    ...over,
  };
}

describe("distillUltraProfile", () => {
  it("rolls up hooks, transitions, pacing, sound + avg metrics", () => {
    const items: TeardownWithMetrics[] = [
      { clipId: "a", teardown: td(), views: 100, likes: 10, comments: 1 },
      {
        clipId: "b",
        teardown: td({
          hook: { text: "did you know", type: "question", reason: "open loop" },
          transitions: [{ t: 2, type: "jump_cut" }, { t: 5, type: "zoom" }],
        }),
        views: 300,
        likes: 30,
        comments: 3,
      },
    ];
    const d = distillUltraProfile(items);
    expect(d.clipsAnalyzed).toBe(2);
    expect(d.avgViews).toBe(200);
    expect(d.profile.transitionVocabulary[0]).toBe("jump_cut"); // most frequent
    expect(d.profile.hookLibrary.map((h) => h.type).sort()).toEqual(["pattern_interrupt", "question"]);
    expect(d.profile.pacingFingerprint?.cutsPerSec).toBe(1);
    expect(d.profile.soundPatterns).toContain("trending audio");
    expect(d.sampleClipIds[0]).toBe("b"); // highest views first
    expect(d.profile.whatPerforms).toContain("question"); // top-by-views (b) leads with a question hook
  });

  it("carries the concrete artifacts: hook line, reason, views, strongest-first", () => {
    const items: TeardownWithMetrics[] = [
      {
        clipId: "low",
        teardown: td({ hook: { text: "small hook", type: "tease", reason: "withholds" } }),
        views: 50,
        likes: 1,
        comments: 0,
      },
      {
        clipId: "high",
        teardown: td({ hook: { text: "I quit my job", type: "bold_claim", reason: "status drop" } }),
        views: 9000,
        likes: 1,
        comments: 0,
      },
    ];
    const d = distillUltraProfile(items);
    // Strongest hook first.
    expect(d.profile.hookLibrary[0]?.type).toBe("bold_claim");
    expect(d.profile.hookLibrary[0]?.example).toBe("I quit my job");
    expect(d.profile.hookLibrary[0]?.reason).toBe("status drop");
    expect(d.profile.hookLibrary[0]?.views).toBe(9000);
    // The prose names the actual winning line + a real CTA, not just the category.
    expect(d.profile.whatPerforms).toContain("I quit my job");
    expect(d.profile.whatPerforms).toContain("follow");
    // Real CTA lines are surfaced.
    expect(d.profile.ctaExamples).toContain("follow");
  });

  it("keeps the best example per hook type", () => {
    const items: TeardownWithMetrics[] = [
      {
        clipId: "weak",
        teardown: td({ hook: { text: "weak claim", type: "bold_claim" } }),
        views: 10,
        likes: 0,
        comments: 0,
      },
      {
        clipId: "strong",
        teardown: td({ hook: { text: "strong claim", type: "bold_claim" } }),
        views: 5000,
        likes: 0,
        comments: 0,
      },
    ];
    const d = distillUltraProfile(items);
    const bold = d.profile.hookLibrary.find((h) => h.type === "bold_claim");
    expect(bold?.example).toBe("strong claim"); // higher views wins
    expect(bold?.views).toBe(5000);
  });

  it("dedups structure templates by beat sequence, keeping the top performer", () => {
    const seq: VideoTeardown["beats"] = [
      { tStart: 0, tEnd: 3, purpose: "hook" },
      { tStart: 3, tEnd: 8, purpose: "proof" },
      { tStart: 8, tEnd: 12, purpose: "payoff" },
    ];
    const items: TeardownWithMetrics[] = [
      { clipId: "a", teardown: td({ beats: seq, hook: { text: "low one", type: "stat" } }), views: 100, likes: 0, comments: 0 },
      { clipId: "b", teardown: td({ beats: seq, hook: { text: "high one", type: "stat" } }), views: 8000, likes: 0, comments: 0 },
    ];
    const d = distillUltraProfile(items);
    const same = d.profile.structureTemplates.filter((s) => s.beats.join(">") === "hook>proof>payoff");
    expect(same).toHaveLength(1); // deduped
    expect(same[0]?.example).toBe("high one"); // top performer's hook line
    expect(same[0]?.views).toBe(8000);
  });

  it("handles empty input", () => {
    const d = distillUltraProfile([]);
    expect(d.clipsAnalyzed).toBe(0);
    expect(d.profile.hookLibrary).toEqual([]);
    expect(d.profile.ctaExamples).toEqual([]);
    expect(d.avgViews).toBeNull();
  });
  it("averages measured counts only, retains fractional means and samples measured views", () => {
    const input = [{ clipId: "unknown", teardown: td(), views: null, likes: null, comments: null },
      { clipId: "zero", teardown: td(), views: 0, likes: 0, comments: 0 },
      { clipId: "known", teardown: td(), views: 3, likes: 1, comments: 1 }] as unknown as TeardownWithMetrics[];
    const d = distillUltraProfile(input);
    expect([d.avgViews, d.avgLikes, d.avgComments]).toEqual([1.5, 0.5, 0.5]);
    expect(d.sampleClipIds).toEqual(["known", "zero"]);
    expect(d.clipsAnalyzed).toBe(3);
  });
  it("retains all-unknown structural artifacts without claiming measured winners", () => {
    const d = distillUltraProfile([{ clipId: "unknown", teardown: td(), views: null, likes: null, comments: null }] as unknown as TeardownWithMetrics[]);
    expect([d.avgViews, d.avgLikes, d.avgComments]).toEqual([null, null, null]);
    expect(d.profile.hookLibrary[0]?.example).toBe("stop scrolling");
    expect(d.profile.hookLibrary[0]?.views).toBeUndefined();
    expect(d.profile.structureTemplates[0]?.views).toBeUndefined();
    expect(d.profile.whatPerforms).toContain("Observed clips");
    expect(d.sampleClipIds).toEqual([]);
  });
});
