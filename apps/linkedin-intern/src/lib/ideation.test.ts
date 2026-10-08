import { describe, it, expect } from "vitest";
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
  url: "https://li/k",
  author: "stranger",
  reactions: 10,
  comments: 2,
  ...over,
});

describe("rankNetNewPosts", () => {
  it("excludes engaged authors, drops zero-engagement, sorts by engagement, caps", () => {
    const posts = [
      kw({ id: "a", author: "Engaged-Person", reactions: 999, comments: 0 }), // engaged → out
      kw({ id: "b", author: "viral", reactions: 100, comments: 50 }), // 150
      kw({ id: "c", author: "mid", reactions: 20, comments: 5 }), // 25
      kw({ id: "d", author: "dead", reactions: 0, comments: 0 }), // no signal → out
    ];
    const engaged = new Set(["engaged-person"]); // lowercased
    const out = rankNetNewPosts(posts, engaged, 2);
    expect(out.map((p) => p.id)).toEqual(["b", "c"]);
  });

  it("matches engaged handles case-insensitively", () => {
    const out = rankNetNewPosts([kw({ author: "JaneDoe" })], new Set(["janedoe"]), 5);
    expect(out).toHaveLength(0);
  });
});

const gather: IdeationGather = {
  repliedPosts: [
    {
      leadId: "lead-r1",
      url: "https://li/r1",
      author: "carla",
      post: "Most CRM automations fail because they start from dashboards, not the sales floor.",
      reply: "the sales-floor bit is the part most teams skip",
      repliedAt: "2026-09-14T10:00:00Z",
    },
  ],
  topAuthors: [
    {
      authorHandle: "alice",
      authorId: "urn-alice",
      authorName: "Alice",
      authorHeadline: "Founder",
      postCount: 4,
      avgEngagement: 120,
      totalEngagement: 480,
      samplePosts: [
        { externalId: "p1", text: "I fired my best eng", url: "https://li/p1", reactions: 200, comments: 30 },
        { externalId: "p2", text: "raising is a trap", url: "https://li/p2", reactions: 90, comments: 10 },
      ],
    },
  ],
  keywordPosts: [
    { id: "k1", text: "AI agents are eating SaaS", url: "https://li/k1", author: "bob", reactions: 50, comments: 5 },
  ],
  playbooks: [
    {
      authorHandle: "alice",
      hookPatterns: ["contrarian one-liner", "number + claim"],
      structureNotes: "short",
      cadenceNotes: "hiring",
      topTopics: ["hiring", "founders"],
      engagementPercentile: 1,
    },
  ],
  voiceAnchors: ["I write in lowercase, blunt, first person"],
  pillars: ["hiring", "building in public"],
};

describe("buildSources", () => {
  it("tags watchlist (W), keyword (K), playbook (P) sources and maps refs", () => {
    const { block, sources } = buildSources(gather);
    expect(block).toContain("[R1]");
    expect(block).toContain("[W1]");
    expect(block).toContain("[K1]");
    expect(block).toContain("[P1]");
    expect(block).toContain("operator replied:");
    expect(sources.get("R1")?.kind).toBe("replied_post");
    expect(sources.get("R1")?.leadId).toBe("lead-r1");
    expect(sources.get("W1")?.kind).toBe("watchlist_post");
    expect(sources.get("W1")?.url).toBe("https://li/p1");
    expect(sources.get("K1")?.kind).toBe("keyword_post");
    expect(sources.get("P1")?.kind).toBe("playbook");
    expect(sources.get("P1")?.author).toBe("alice");
  });
});

describe("buildIdeationSystem", () => {
  it("includes the shared anti-AI writing rules for idea text", () => {
    expect(buildIdeationSystem(null)).toContain("NEVER MARK SIGNIFICANCE");
    expect(buildIdeationSystem(null)).toContain("TIER-1 VOCABULARY");
  });

  it("enforces first-person POV and bans fabricated biography", () => {
    const sys = buildIdeationSystem(null, null).toLowerCase();
    // Must require the post be written as the operator, first person.
    expect(sys).toContain("first person");
    // Must explicitly forbid third-person / name-as-character narration.
    expect(sys).toContain("third person");
    // Must forbid inventing life events / personal history.
    expect(sys).toMatch(/invent|fabricat|made-up|made up|fak/);
    expect(sys).toMatch(/history|backstory|anecdote/);
    // Must reject posing as a guru with it all figured out.
    expect(sys).toMatch(/uncertain|still (figuring|not sure)|oracle|guru/);
  });

  it("prefers net-new viral structure over mirroring the engaged watchlist", () => {
    const sys = buildIdeationSystem(null, null).toLowerCase();
    expect(sys).toContain("net-new");
    // must warn against anchoring ideas on the people the operator engages
    expect(sys).toMatch(/do not anchor|do not mirror|copied them/);
    // hook-first virality
    expect(sys).toContain("hook");
  });

  it("treats saved replied posts as preferred evidence without impersonating authors", () => {
    const sys = buildIdeationSystem(null, null).toLowerCase();
    expect(sys).toContain("prefer [r]");
    expect(sys).toContain("saved engagement history");
    expect(sys).toContain("do not impersonate the source author");
    expect(sys).toContain("do not lift");
  });

  it("keeps the brand block and objective when supplied", () => {
    const sys = buildIdeationSystem("grow the waitlist", "BRAND: Acme, a CRM.");
    expect(sys).toContain("grow the waitlist");
    expect(sys).toContain("BRAND: Acme, a CRM.");
  });
});

describe("assembleIdeas", () => {
  let counter = 0;
  const idFactory = () => `idea-${++counter}`;

  it("resolves cited tags into inspiration refs and stamps fields", () => {
    counter = 0;
    const { sources } = buildSources(gather);
    const parsed = IdeaSynthSchema.parse({
      ideas: [
        { hook: "Stop hiring seniors.", thesis: "Juniors compound.", angle: "contrarian", pillar: "hiring", inspiration_tags: ["W1", "P1", "ZZ"] },
      ],
    });
    const ideas = assembleIdeas(parsed, sources, {
      idFactory,
      sourceEngine: "bedrock",
      model: "m",
      batchId: null,
      weekStart: null,
    });
    expect(ideas).toHaveLength(1);
    expect(ideas[0]!.id).toBe("idea-1");
    expect(ideas[0]!.inspirationRefs).toHaveLength(2); // W1 + P1; ZZ unknown dropped
    expect(ideas[0]!.suggestedDay).toBeNull();
    expect(ideas[0]!.platform).toBe("linkedin");
  });

  it("assigns Mon-Sun days in batch mode", () => {
    counter = 0;
    const { sources } = buildSources(gather);
    const parsed = IdeaSynthSchema.parse({
      ideas: Array.from({ length: 3 }, (_, i) => ({
        hook: `hook ${i}`,
        thesis: "",
        angle: "",
        pillar: "",
        inspiration_tags: [],
      })),
    });
    const ideas = assembleIdeas(parsed, sources, {
      idFactory,
      sourceEngine: "bedrock",
      model: "m",
      batchId: "batch-1",
      weekStart: "2026-06-22", // a Monday
    });
    expect(ideas.map((x) => x.suggestedDay)).toEqual(["2026-06-22", "2026-06-23", "2026-06-24"]);
    expect(ideas.every((x) => x.batchId === "batch-1")).toBe(true);
  });

  it("resolves replied-post inspiration refs", () => {
    counter = 0;
    const { sources } = buildSources(gather);
    const parsed = IdeaSynthSchema.parse({
      ideas: [
        {
          hook: "Dashboards do not fix a broken sales floor.",
          thesis: "Automation ideas should start from where reps actually lose time.",
          angle: "observation",
          pillar: "sales",
          inspiration_tags: ["R1"],
        },
      ],
    });
    const ideas = assembleIdeas(parsed, sources, {
      idFactory,
      sourceEngine: "codex",
      model: "m",
      batchId: null,
      weekStart: null,
    });
    expect(ideas[0]!.inspirationRefs).toMatchObject([
      { kind: "replied_post", leadId: "lead-r1", url: "https://li/r1", author: "carla" },
    ]);
  });
});

describe("addDays", () => {
  it("adds days across a month boundary in UTC", () => {
    expect(addDays("2026-06-29", 3)).toBe("2026-07-02");
    expect(addDays("2026-06-22", 0)).toBe("2026-06-22");
  });
});
