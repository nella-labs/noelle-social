import { describe, it, expect } from "vitest";
import {
  ObjectiveSchema,
  HandleSchema,
  PublicIdSchema,
  TargetingProposalSchema,
  proposalTouchesWatchlist,
  linkedinPublicId,
  normalizeSubreddit,
  targetingProposalMatchesRole,
  TARGETING_LIST_MAX,
  OBJECTIVE_MAX,
} from "./agent-objective.js";

describe("Reddit targeting proposals", () => {
  it("shares manual normalization and rejects unrelated URL hosts", () => {
    for (const value of ["SaaS", "r/SaaS", "/r/SaaS", "https://www.reddit.com/r/SaaS/comments/abc/title/"]) expect(normalizeSubreddit(value)).toBe("saas");
    for (const value of ["", "u/person", "https://evilreddit.com/r/saas", "https://reddit.com.evil.invalid/r/saas"]) expect(normalizeSubreddit(value)).toBeNull();
  });
  it("allows only fields for a supported instance role", () => {
    const proposal = TargetingProposalSchema.parse({ addSubreddits: ["saas"] });
    expect(targetingProposalMatchesRole(proposal, "reddit_intern")).toBe(true);
    expect(targetingProposalMatchesRole(proposal, "reddit-intern")).toBe(true);
    for (const role of ["x_intern", "linkedin_intern", "ceo", "unknown"]) expect(targetingProposalMatchesRole(proposal, role)).toBe(false);
    expect(targetingProposalMatchesRole(TargetingProposalSchema.parse({ mission: "Meet founders" }), "ceo")).toBe(false);
  });
  it("normalizes and deduplicates subreddit additions and removals", () => {
    const proposal = TargetingProposalSchema.parse({ addSubreddits: ["r/SaaS", "saas", "https://www.reddit.com/r/Entrepreneur/"], removeSubreddits: ["/r/Startups"] });
    expect(proposal).toMatchObject({ addSubreddits: ["saas", "entrepreneur"], removeSubreddits: ["startups"] });
    expect(proposalTouchesWatchlist(proposal)).toBe(true);
  });
  it("caps subreddit changes at the shared list limit", () => {
    const proposal = TargetingProposalSchema.parse({ addSubreddits: Array.from({ length: TARGETING_LIST_MAX + 10 }, (_, i) => "community" + i) });
    expect((proposal as unknown as { addSubreddits: string[] }).addSubreddits).toHaveLength(TARGETING_LIST_MAX);
  });
  it("preserves subreddit changes alongside a mission", () => {
    expect(TargetingProposalSchema.parse({ mission: "Meet founders", addSubreddits: ["SaaS"] })).toMatchObject({ mission: "Meet founders", addSubreddits: ["saas"] });
  });
  it("rejects invalid, conflicting and unknown targeting changes", () => {
    for (const proposal of [
      { addSubreddits: ["u/person"] },
      { addSubreddits: ["r/SaaS"], removeSubreddits: ["saas"] }, { mission: "Meet founders", addCommunities: ["saas"] },
    ]) expect(TargetingProposalSchema.safeParse(proposal).success).toBe(false);
  });
});

describe("ObjectiveSchema", () => {
  it("trims and accepts a normal mission", () => {
    expect(ObjectiveSchema.parse("  find indie founders  ")).toBe(
      "find indie founders",
    );
  });
  it("rejects empty / whitespace", () => {
    expect(ObjectiveSchema.safeParse("").success).toBe(false);
    expect(ObjectiveSchema.safeParse("   ").success).toBe(false);
  });
  it("rejects over-long missions", () => {
    expect(ObjectiveSchema.safeParse("x".repeat(OBJECTIVE_MAX + 1)).success).toBe(
      false,
    );
  });
});

describe("HandleSchema", () => {
  it("strips @ and lowercases", () => {
    expect(HandleSchema.parse("@LevelsIO")).toBe("levelsio");
    expect(HandleSchema.parse("  Marc_Louvion ")).toBe("marc_louvion");
  });
});

describe("linkedinPublicId", () => {
  it("reduces a full profile URL to the bare slug", () => {
    expect(linkedinPublicId("https://www.linkedin.com/in/jane-doe/")).toBe(
      "jane-doe",
    );
  });
  it("strips a query string and lowercases", () => {
    expect(linkedinPublicId("linkedin.com/in/Jane-Doe?x=1")).toBe("jane-doe");
  });
  it("strips a hash fragment", () => {
    expect(linkedinPublicId("https://linkedin.com/in/jane-doe#about")).toBe(
      "jane-doe",
    );
  });
  it("handles a bare /in/ path", () => {
    expect(linkedinPublicId("/in/jane-doe")).toBe("jane-doe");
  });
  it("passes a bare slug through (lowercased)", () => {
    expect(linkedinPublicId("Jane-Doe")).toBe("jane-doe");
  });
  it("returns empty for a blank input", () => {
    expect(linkedinPublicId("   ")).toBe("");
  });
  it("returns empty for a LinkedIn URL with no /in/ segment", () => {
    expect(linkedinPublicId("https://www.linkedin.com/feed/")).toBe("");
  });
});

describe("PublicIdSchema", () => {
  it("normalises a URL to the slug", () => {
    expect(PublicIdSchema.parse("https://www.linkedin.com/in/jane-doe/")).toBe(
      "jane-doe",
    );
  });
  it("rejects an input that yields no slug", () => {
    expect(PublicIdSchema.safeParse("https://linkedin.com/feed/").success).toBe(
      false,
    );
    expect(PublicIdSchema.safeParse("   ").success).toBe(false);
  });
});

describe("TargetingProposalSchema", () => {
  it("normalises + dedupes handles and keywords", () => {
    const p = TargetingProposalSchema.parse({
      addHandles: ["@levelsio", "levelsio", "@Marc_Louvion"],
      addKeywords: ["X growth", "X growth", "ghostwriter"],
    });
    expect(p.addHandles).toEqual(["levelsio", "marc_louvion"]);
    expect(p.addKeywords).toEqual(["X growth", "ghostwriter"]);
    expect(p.removeHandles).toEqual([]);
    expect(p.mission).toBeUndefined();
  });

  it("caps each list at TARGETING_LIST_MAX", () => {
    const many = Array.from({ length: TARGETING_LIST_MAX + 10 }, (_, i) => `kw${i}`);
    const p = TargetingProposalSchema.parse({ addKeywords: many });
    expect(p.addKeywords).toHaveLength(TARGETING_LIST_MAX);
  });

  it("accepts a mission-only proposal", () => {
    const p = TargetingProposalSchema.parse({ mission: "pivot to LLM evals" });
    expect(p.mission).toBe("pivot to LLM evals");
    expect(proposalTouchesWatchlist(p)).toBe(false);
  });

  it("accepts a removal-only proposal", () => {
    const p = TargetingProposalSchema.parse({ removeKeywords: ["crypto"] });
    expect(proposalTouchesWatchlist(p)).toBe(true);
  });

  it("rejects an empty (no-op) proposal", () => {
    expect(TargetingProposalSchema.safeParse({}).success).toBe(false);
    expect(
      TargetingProposalSchema.safeParse({
        addHandles: [],
        removeKeywords: [],
      }).success,
    ).toBe(false);
  });

  // ---- LinkedIn (Lyra) people shape ----

  it("accepts a LinkedIn addPeople proposal and normalises URLs to slugs", () => {
    const p = TargetingProposalSchema.parse({
      addPeople: [
        "https://www.linkedin.com/in/jane-doe/",
        "linkedin.com/in/jane-doe?x=1", // dupe → collapses
        "john-smith",
      ],
    });
    expect(p.addPeople).toEqual(["jane-doe", "john-smith"]);
    expect(p.addHandles).toEqual([]);
    expect(p.addKeywords).toEqual([]);
    expect(proposalTouchesWatchlist(p)).toBe(true);
  });

  it("accepts a LinkedIn mission-only proposal (who's worth replying to)", () => {
    const p = TargetingProposalSchema.parse({
      mission: "focus on YC founders building AI agents",
    });
    expect(p.mission).toBe("focus on YC founders building AI agents");
    expect(p.addPeople).toEqual([]);
    expect(proposalTouchesWatchlist(p)).toBe(false);
  });

  it("accepts a LinkedIn removePeople-only proposal", () => {
    const p = TargetingProposalSchema.parse({
      removePeople: ["https://linkedin.com/in/recruiter-bob"],
    });
    expect(p.removePeople).toEqual(["recruiter-bob"]);
    expect(proposalTouchesWatchlist(p)).toBe(true);
  });

  it("caps addPeople at TARGETING_LIST_MAX", () => {
    const many = Array.from({ length: TARGETING_LIST_MAX + 5 }, (_, i) => `person-${i}`);
    const p = TargetingProposalSchema.parse({ addPeople: many });
    expect(p.addPeople).toHaveLength(TARGETING_LIST_MAX);
  });
});
