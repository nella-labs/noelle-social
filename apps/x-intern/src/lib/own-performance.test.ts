import { describe, it, expect } from "vitest";
import {
  summarizeOwnPerformance,
  renderOwnPerformanceBlock,
  hasOwnPerformanceSignal,
  type OwnPerfInputRow,
} from "./own-performance.js";
import { buildIdeationSystem, renderIdeationPrompt, type IdeationGather } from "./ideation.js";

const row = (over: Partial<OwnPerfInputRow>): OwnPerfInputRow => ({
  externalId: "1",
  hook: "a hook",
  pillar: "craft",
  angle: "contrarian",
  likes: 10,
  reposts: 2,
  replies: 1,
  ...over,
});

describe("summarizeOwnPerformance", () => {
  it("ranks top posts by engagement, drops flops from highlights", () => {
    const perf = summarizeOwnPerformance(
      [
        row({ externalId: "a", hook: "big", likes: 100, reposts: 20, replies: 5 }), // 125
        row({ externalId: "b", hook: "mid", likes: 10, reposts: 1, replies: 1 }), // 12
        row({ externalId: "c", hook: "flop", likes: 0, reposts: 0, replies: 0 }), // 0 → not a highlight
      ],
      { topPosts: 5 },
    );
    expect(perf.topPosts.map((p) => p.hook)).toEqual(["big", "mid"]);
    expect(perf.topPosts[0]?.engagement).toBe(125);
  });

  it("caps the highlight list at topPosts", () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      row({ externalId: String(i), hook: `h${i}`, likes: i + 1, reposts: 0, replies: 0 }),
    );
    const perf = summarizeOwnPerformance(rows, { topPosts: 3 });
    expect(perf.topPosts).toHaveLength(3);
    // best-first: highest likes (8,7,6)
    expect(perf.topPosts.map((p) => p.likes)).toEqual([8, 7, 6]);
  });

  it("rolls up pillars/angles by AVG engagement, including flops", () => {
    const perf = summarizeOwnPerformance(
      [
        row({ externalId: "a", pillar: "craft", likes: 100, reposts: 0, replies: 0 }), // 100
        row({ externalId: "b", pillar: "craft", likes: 0, reposts: 0, replies: 0 }), // 0 → drags craft avg to 50
        row({ externalId: "c", pillar: "money", likes: 60, reposts: 0, replies: 0 }), // 60
      ],
      { topPosts: 5 },
    );
    // money (60) outranks craft (avg 50) even though craft has the single best post
    expect(perf.pillarRanking.map((b) => b.key)).toEqual(["money", "craft"]);
    const craft = perf.pillarRanking.find((b) => b.key === "craft")!;
    expect(craft.avgEngagement).toBe(50);
    expect(craft.posts).toBe(2);
  });

  it("ignores null/blank pillars and angles in the rollup", () => {
    const perf = summarizeOwnPerformance(
      [row({ pillar: null, angle: "  " }), row({ externalId: "2", pillar: "craft", angle: "story" })],
      { topPosts: 5 },
    );
    expect(perf.pillarRanking.map((b) => b.key)).toEqual(["craft"]);
    expect(perf.angleRanking.map((b) => b.key)).toEqual(["story"]);
  });
});

describe("hasOwnPerformanceSignal", () => {
  it("is false for null / empty, true once there's a post or pillar", () => {
    expect(hasOwnPerformanceSignal(null)).toBe(false);
    expect(hasOwnPerformanceSignal({ topPosts: [], pillarRanking: [], angleRanking: [] })).toBe(false);
    const perf = summarizeOwnPerformance([row({ likes: 5 })], { topPosts: 5 });
    expect(hasOwnPerformanceSignal(perf)).toBe(true);
  });
});

describe("renderOwnPerformanceBlock", () => {
  it("returns empty string with no signal (so the prompt drops it)", () => {
    expect(renderOwnPerformanceBlock(null)).toBe("");
    expect(renderOwnPerformanceBlock({ topPosts: [], pillarRanking: [], angleRanking: [] })).toBe("");
  });

  it("renders own posts + winning pillars/angles when there's signal", () => {
    const perf = summarizeOwnPerformance(
      [row({ hook: "my winning take", pillar: "craft", angle: "contrarian", likes: 90, reposts: 5, replies: 3 })],
      { topPosts: 5 },
    );
    const block = renderOwnPerformanceBlock(perf);
    expect(block).toContain("What's already working for YOU");
    expect(block).toContain("my winning take");
    expect(block).toContain("Insufficient comparable posts");
    expect(block).toContain("craft");
  });
});

describe("ideation prompt integration", () => {
  const gather = (over: Partial<IdeationGather>): IdeationGather => ({
    topAuthors: [],
    keywordPosts: [],
    voiceAnchors: ["dry and specific"],
    pillars: ["craft"],
    ...over,
  });

  it("system prompt adds the learn-loop guidance only when there's signal", () => {
    const perf = summarizeOwnPerformance(
      ["a", "b", "c"].map((externalId) => row({ externalId, likes: 50 })), { topPosts: 5 },
    );
    expect(buildIdeationSystem(null, null, perf)).toContain("LEARN FROM SUPPORTED OWN-POST PATTERNS");
    // no signal → no guidance
    expect(buildIdeationSystem(null, null, null)).not.toContain("LEARN FROM SUPPORTED OWN-POST PATTERNS");
  });

  it("render prompt includes the own-performance block when present", () => {
    const perf = summarizeOwnPerformance(
      [row({ hook: "proven hook", likes: 80, reposts: 4, replies: 2 })],
      { topPosts: 5 },
    );
    const withPerf = renderIdeationPrompt(gather({ ownPerformance: perf }), { count: 3 });
    expect(withPerf).toContain("proven hook");
    const without = renderIdeationPrompt(gather({ ownPerformance: null }), { count: 3 });
    expect(without).not.toContain("What's already working for YOU");
  });
});
