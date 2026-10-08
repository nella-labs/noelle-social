import { describe, it, expect } from "vitest";
import {
  computePercentiles,
  buildAnalystSystem,
  renderAnalystPrompt,
  PlaybookOutputSchema,
  safeJsonParse,
} from "./engagement-analyst.js";

const author = (handle: string) => ({
  authorHandle: handle,
  authorId: `${handle}-id`,
  authorName: handle,
  authorHeadline: null,
  postCount: 4,
  observedPostCount: 4,
  avgEngagement: 120,
  totalEngagement: 480,
  samplePosts: [
    { externalId: "1", text: "a great post", url: "u", likes: 100, replies: 12, reposts: 8 },
  ],
});

describe("computePercentiles", () => {
  it("assigns the same cohort rank to equal observed averages", () => {
    const p = computePercentiles([
      { ...author("a"), avgEngagement: 10 },
      { ...author("b"), avgEngagement: 10 },
      { ...author("c"), avgEngagement: 0 },
    ]);
    expect(p.get("a")).toBe(0.75);
    expect(p.get("b")).toBe(0.75);
    expect(p.get("c")).toBe(0);
    const allZero = computePercentiles([author("a"), author("b")].map(a => ({ ...a, avgEngagement: 0 })));
    expect([...allZero.values()]).toEqual([0.5, 0.5]);
  });

  it("ranks the best-first list from 1 down to 0", () => {
    const p = computePercentiles([
      { ...author("a"), avgEngagement: 20 },
      { ...author("b"), avgEngagement: 10 },
      { ...author("c"), avgEngagement: 0 },
    ]);
    expect(p.get("a")).toBe(1);
    expect(p.get("c")).toBe(0);
    expect(p.get("b")).toBeCloseTo(0.5, 4);
  });

  it("treats a single author as the top performer", () => {
    expect(computePercentiles([author("solo")]).get("solo")).toBe(1);
  });

  it("handles an empty ranking without throwing", () => {
    expect(computePercentiles([]).size).toBe(0);
  });
});

describe("analyst prompt (X wording)", () => {
  it("uses the measured subset and does not infer causal reach or posting cadence", () => {
    const p = renderAnalystPrompt({ ...author("builder"), observedPostCount: 10 });
    expect(p).toContain("4 measured of 10");
    expect(p).toContain("bounded observed sample");
    const sys = buildAnalystSystem();
    expect(sys).toContain("do not establish why a post gained reach");
    expect(sys).toContain("do not infer posting cadence");
    expect(sys).not.toContain("Reverse-engineer WHY");
  });

  it("asks about X, not LinkedIn, and uses X's three engagement counts", () => {
    const sys = buildAnalystSystem();
    expect(sys).toMatch(/X \(Twitter\)/);
    expect(sys).toContain("likes + replies + reposts");
    expect(sys).not.toMatch(/LinkedIn/);
  });

  it("renders the x.com profile URL and all three counts per post", () => {
    const p = renderAnalystPrompt(author("patio11"));
    expect(p).toContain("x.com/patio11");
    expect(p).toContain("100 likes, 12 replies, 8 reposts");
    expect(p).not.toContain("linkedin.com");
  });
});

describe("playbook parsing", () => {
  it("parses a clean playbook", () => {
    const out = PlaybookOutputSchema.safeParse(
      safeJsonParse('{"hook_patterns":["contrarian one-liner"],"structure_notes":"short","cadence_notes":"daily","top_topics":["devtools"]}'),
    );
    expect(out.success).toBe(true);
  });

  it("tolerates a fenced response", () => {
    const out = PlaybookOutputSchema.safeParse(
      safeJsonParse('```json\n{"hook_patterns":[],"structure_notes":"s","cadence_notes":"c","top_topics":[]}\n```'),
    );
    expect(out.success).toBe(true);
  });

  it("defaults every field so a partial object still yields a usable playbook", () => {
    const out = PlaybookOutputSchema.safeParse(safeJsonParse("{}"));
    expect(out.success).toBe(true);
    if (out.success) {
      expect(out.data.hook_patterns).toEqual([]);
      expect(out.data.structure_notes).toBe("");
    }
  });

  it("returns null on unparseable text rather than throwing", () => {
    expect(safeJsonParse("not json at all")).toBeNull();
  });
});
