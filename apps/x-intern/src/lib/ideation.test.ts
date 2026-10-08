import { describe, it, expect } from "vitest";
import { IDEA_WRITING_GUIDANCE } from "@noelle/runtime";
import { summarizeOwnPerformance } from "./own-performance.js";
import {
  buildSources,
  buildIdeationSystem,
  rankNetNewPosts,
  assembleIdeas,
  addDays,
  IdeaSynthSchema,
  type IdeationGather,
  type KeywordPost,
} from "./ideation.js";

const kw = (over: Partial<KeywordPost>): KeywordPost => ({
  id: "k",
  text: "t",
  url: "https://x.com/k",
  author: "stranger",
  likes: 10,
  reposts: 1,
  replies: 1,
  ...over,
});

describe("rankNetNewPosts", () => {
  it("excludes engaged authors, drops zero-engagement, sorts by engagement, caps", () => {
    const posts = [
      kw({ id: "a", author: "Engaged-Person", likes: 999, reposts: 0, replies: 0 }), // engaged → out
      kw({ id: "b", author: "viral", likes: 100, reposts: 40, replies: 10 }), // 150
      kw({ id: "c", author: "mid", likes: 20, reposts: 3, replies: 2 }), // 25
      kw({ id: "d", author: "dead", likes: 0, reposts: 0, replies: 0 }), // no signal → out
    ];
    const engaged = new Set(["engaged-person"]); // lowercased
    const out = rankNetNewPosts(posts, engaged, 2);
    expect(out.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("matches engaged handles case-insensitively + @-stripped", () => {
    expect(rankNetNewPosts([kw({ author: "JaneDoe" })], new Set(["janedoe"]), 5)).toHaveLength(0);
    expect(rankNetNewPosts([kw({ author: "@JaneDoe" })], new Set(["janedoe"]), 5)).toHaveLength(0);
  });
});

const gather = (over: Partial<IdeationGather> = {}): IdeationGather => ({
  topAuthors: [],
  keywordPosts: [],
  voiceAnchors: [],
  pillars: [],
  ...over,
});

describe("buildSources", () => {
  it("labels unknown watchlist counts without presenting them as zero engagement", () => {
    const { block, sources } = buildSources(gather({
      topAuthors: [{ authorHandle: "builder", authorName: null, avgEngagement: null,
        observedPostCount: 1, measuredPostCount: 0,
        samplePosts: [{ externalId: "one", url: null, text: "A topic", likes: null, reposts: 0, replies: null }],
      }],
    }));
    expect(block).toContain("unknown likes");
    expect(block).toContain("0 reposts");
    expect(block).toContain("unknown replies");
    expect(block).toContain("bounded observed sample");
    expect(sources.get("W1")?.note).toBe("unknown likes, 0 reposts, unknown replies");
  });

  it("tags replied posts with the operator's real reply as source material", () => {
    const { block, sources } = buildSources(
      gather({
        repliedPosts: [
          {
            leadId: "lead-1",
            url: "https://x.com/builder/status/1",
            author: "builder",
            post: "Most generated posts die because they chase topics instead of tension.",
            reply: "the tension is the source, the topic is just packaging",
            repliedAt: "2026-09-13T12:00:00Z",
          },
        ],
      }),
    );
    expect(block).toContain("[R1]");
    expect(block).toContain("Most generated posts die");
    expect(block).toContain("operator replied: the tension is the source");
    expect(sources.get("R1")).toMatchObject({
      kind: "replied_post",
      leadId: "lead-1",
      url: "https://x.com/builder/status/1",
      author: "builder",
    });
  });

  it("tags watchlist [W] + keyword [K] posts and resolves their refs", () => {
    const { block, sources } = buildSources(
      gather({
        topAuthors: [
          {
            authorHandle: "mentor",
            authorName: "Mentor",
            avgEngagement: 50,
            observedPostCount: 1,
            measuredPostCount: 1,
            samplePosts: [{ externalId: "t1", url: "https://x.com/mentor/1", text: "radar post", likes: 40, reposts: 5, replies: 5 }],
          },
        ],
        keywordPosts: [kw({ id: "kk", author: "viral", likes: 200, reposts: 10, replies: 5 })],
      }),
    );
    expect(sources.get("W1")?.kind).toBe("watchlist_post");
    expect(sources.get("K1")?.kind).toBe("keyword_post");
    expect(block).toContain("[W1]");
    expect(block).toContain("[K1]");
  });

  it("renders empty-source placeholders rather than crashing", () => {
    const { block } = buildSources(gather());
    expect(block).toContain("(none yet)");
    expect(block).toContain("(none — no net-new field posts available this run)");
  });
});

describe("buildIdeationSystem", () => {
  it("treats sparse measured posts as observations rather than winning patterns", () => {
    const measured = summarizeOwnPerformance(
      [
        {
          externalId: "measured-1",
          hook: "a measured post",
          pillar: "tools",
          angle: "observation",
          likes: 2,
          replies: 1,
          reposts: 1,
        },
      ],
      { topPosts: 5 },
    );
    const sys = buildIdeationSystem(null, null, measured);
    expect(sys).not.toContain("winning pillars/angles");
    expect(sys).toContain("Sparse measurements are observations");
    expect(sys).toContain("Keep a recognizable topic focus");
  });

  it("only steers toward sufficiently supported measured patterns", () => {
    const measured = summarizeOwnPerformance(
      Array.from({ length: 3 }, (_, i) => ({
        externalId: `measured-${i}`,
        hook: "a measured post",
        pillar: "tools",
        angle: "observation",
        likes: 2,
        replies: 1,
        reposts: 1,
      })),
      { topPosts: 5 },
    );
    expect(buildIdeationSystem(null, null, measured)).toContain(
      "LEARN FROM SUPPORTED OWN-POST PATTERNS",
    );
    expect(buildIdeationSystem(null, null, measured)).not.toContain(
      "Sparse measurements are observations",
    );
  });

  it("is X-flavored, not LinkedIn", () => {
    const sys = buildIdeationSystem(null);
    expect(sys).toContain("X (Twitter) content strategist");
    expect(sys).toContain("WRITE FOR X, NOT LINKEDIN");
    expect(sys).not.toContain("LinkedIn content strategist");
  });

  it("gives idea generation the shared anti-AI guidance", () => {
    expect(buildIdeationSystem(null)).toContain(IDEA_WRITING_GUIDANCE);
  });
});

describe("assembleIdeas", () => {
  const parsed = IdeaSynthSchema.parse({
    ideas: [
      { hook: "h1", thesis: "t1", angle: "contrarian", pillar: "building", inspiration_tags: ["K1"] },
      { hook: "h2", thesis: "", angle: "", pillar: "", inspiration_tags: [] },
    ],
  });
  const sources = new Map([["K1", { kind: "keyword_post" as const, url: "https://x.com/k", author: "viral" }]]);
  const opts = { idFactory: () => "id", sourceEngine: "codex", model: "gpt-5" };

  it("stamps platform 'x' and defaults the fan-out to ['x']", () => {
    const ideas = assembleIdeas(parsed, sources, opts);
    expect(ideas).toHaveLength(2);
    expect(ideas[0]!.platform).toBe("x");
    expect(ideas[0]!.targetPlatforms).toEqual(["x"]);
    // cited tag resolved to a real ref; uncited idea has none.
    expect(ideas[0]!.inspirationRefs).toHaveLength(1);
    expect(ideas[1]!.inspirationRefs).toHaveLength(0);
  });

  it("honors an explicit fan-out scope (e.g. a cross-platform request)", () => {
    const ideas = assembleIdeas(parsed, sources, { ...opts, targetPlatforms: ["x", "linkedin"] });
    expect(ideas[0]!.targetPlatforms).toEqual(["x", "linkedin"]);
  });

  it("assigns Mon..Sun days for a weekly batch", () => {
    const ideas = assembleIdeas(parsed, sources, { ...opts, weekStart: "2026-06-29" });
    expect(ideas[0]!.suggestedDay).toBe("2026-06-29");
    expect(ideas[1]!.suggestedDay).toBe("2026-06-30");
  });
});

describe("addDays", () => {
  it("adds UTC days without a clock", () => {
    expect(addDays("2026-06-29", 0)).toBe("2026-06-29");
    expect(addDays("2026-06-29", 6)).toBe("2026-07-05");
  });
});
