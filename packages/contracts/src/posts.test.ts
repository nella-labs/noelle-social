import { describe, it, expect } from "vitest";
import {
  PostPlatformSchema,
  PostIdeasCreateSchema,
  PostIdeaInSchema,
  PostGenerateInSchema,
  PostDraftCreateSchema,
  PostMarkPostedInSchema,
  IdeationTriggerInSchema,
  ManualIdeaInSchema,
  PostChatInSchema,
  PostDismissInSchema,
  PostReplaceOutSchema,
} from "./posts.js";
import { RELATIONSHIP_DM_DAILY_CAPS, resolveLaneConfig, LaneConfigSchema } from "./lane-config.js";

const UUID_A = "11111111-1111-1111-1111-111111111111";

describe("PostPlatformSchema", () => {
  it("accepts linkedin, x, and reddit", () => {
    expect(PostPlatformSchema.parse("linkedin")).toBe("linkedin");
    expect(PostPlatformSchema.parse("x")).toBe("x");
    expect(PostPlatformSchema.parse("reddit")).toBe("reddit");
  });
  it("rejects unknown platforms", () => {
    expect(() => PostPlatformSchema.parse("mastodon")).toThrow();
  });
  it("accepts a reddit idea batch", () => {
    const parsed = PostIdeasCreateSchema.parse({
      platform: "reddit",
      ideas: [{ id: UUID_A, platform: "reddit", hook: "ship logs > standups" }],
    });
    expect(parsed.platform).toBe("reddit");
  });
});

describe("PostIdeasCreateSchema platform consistency + id", () => {
  it("rejects an idea whose platform differs from the batch platform", () => {
    expect(() =>
      PostIdeasCreateSchema.parse({
        platform: "linkedin",
        ideas: [{ id: UUID_A, platform: "x", hook: "h" }],
      }),
    ).toThrow();
  });
  it("requires idea.id to be a UUID", () => {
    expect(() =>
      PostIdeasCreateSchema.parse({
        platform: "linkedin",
        ideas: [{ id: "idea-1", platform: "linkedin", hook: "h" }],
      }),
    ).toThrow();
  });
});

describe("PostIdeaInSchema", () => {
  const base = {
    id: UUID_A,
    platform: "linkedin" as const,
    hook: "I fired my best engineer. Best decision I made.",
  };

  it("accepts a minimal idea and defaults inspirationRefs to []", () => {
    const parsed = PostIdeaInSchema.parse(base);
    expect(parsed.inspirationRefs).toEqual([]);
  });

  it("validates suggestedDay as an ISO date", () => {
    expect(() => PostIdeaInSchema.parse({ ...base, suggestedDay: "2026-06-22" })).not.toThrow();
    expect(() => PostIdeaInSchema.parse({ ...base, suggestedDay: "June 22" })).toThrow();
  });

  it("caps inspirationRefs at 12", () => {
    const refs = Array.from({ length: 13 }, () => ({
      kind: "watchlist_post" as const,
      url: "https://linkedin.com/x",
    }));
    expect(() => PostIdeaInSchema.parse({ ...base, inspirationRefs: refs })).toThrow();
  });
});

describe("PostIdeasCreateSchema", () => {
  it("requires at least one idea", () => {
    expect(() => PostIdeasCreateSchema.parse({ platform: "linkedin", ideas: [] })).toThrow();
  });
});

describe("cross-platform fan-out (targetPlatforms)", () => {
  it("accepts a LinkedIn-home idea that targets X + LinkedIn", () => {
    const parsed = PostIdeasCreateSchema.parse({
      platform: "linkedin",
      ideas: [
        {
          id: UUID_A,
          platform: "linkedin",
          targetPlatforms: ["linkedin", "x"],
          hook: "ship logs > standups",
        },
      ],
    });
    expect(parsed.ideas[0]!.targetPlatforms).toEqual(["linkedin", "x"]);
  });
  it("targetPlatforms is optional (absent ⇒ home platform only, server-side)", () => {
    const parsed = PostIdeaInSchema.parse({ id: UUID_A, platform: "linkedin", hook: "h" });
    expect(parsed.targetPlatforms).toBeUndefined();
  });
  it("rejects an unknown target platform", () => {
    expect(() =>
      PostIdeaInSchema.parse({
        id: UUID_A,
        platform: "linkedin",
        targetPlatforms: ["mastodon"],
        hook: "h",
      }),
    ).toThrow();
  });
  it("the home-platform refine is independent of targetPlatforms", () => {
    // batch platform must still match each idea's HOME platform, even when the
    // idea fans out to other platforms via targetPlatforms.
    expect(() =>
      PostIdeasCreateSchema.parse({
        platform: "linkedin",
        ideas: [{ id: UUID_A, platform: "x", targetPlatforms: ["x", "linkedin"], hook: "h" }],
      }),
    ).toThrow();
  });
});

describe("PostDraftCreateSchema", () => {
  it("accepts a durable generation request id for worker-created drafts", () => {
    const parsed = PostDraftCreateSchema.parse({
      ideaId: UUID_A,
      platform: "linkedin",
      body: "draft body",
      charCount: 10,
      generationRequestId: UUID_A,
      qualityScore: 0.9,
      qualityPassed: true,
      verifierMeta: {
        pass: true,
        scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 0.9 },
        reasons: ["specific"],
        attempts: 0,
      },
    });
    expect(parsed.generationRequestId).toBe(UUID_A);
  });
});

describe("PostGenerateInSchema", () => {
  it("accepts an empty body (regenerate every target platform)", () => {
    expect(PostGenerateInSchema.parse({}).platforms).toBeUndefined();
  });
  it("accepts a single-platform regen subset", () => {
    expect(PostGenerateInSchema.parse({ platforms: ["x"] }).platforms).toEqual(["x"]);
  });
  it("rejects an empty platforms array", () => {
    expect(() => PostGenerateInSchema.parse({ platforms: [] })).toThrow();
  });
});

describe("PostMarkPostedInSchema", () => {
  it("accepts an empty body and a posted URL", () => {
    expect(PostMarkPostedInSchema.parse({}).postedUrl).toBeUndefined();
    expect(PostMarkPostedInSchema.parse({ postedUrl: "https://x.com/u/status/1" }).postedUrl).toBe(
      "https://x.com/u/status/1",
    );
  });
  it("rejects a non-URL", () => {
    expect(() => PostMarkPostedInSchema.parse({ postedUrl: "not a url" })).toThrow();
  });
});

describe("IdeationTriggerInSchema", () => {
  it("defaults mode to single", () => {
    expect(IdeationTriggerInSchema.parse({}).mode).toBe("single");
  });
  it("accepts batch with a weekStart", () => {
    const t = IdeationTriggerInSchema.parse({
      mode: "batch",
      weekStart: "2026-06-22",
    });
    expect(t.mode).toBe("batch");
  });
});

describe("PostChatInSchema", () => {
  it("defaults pin to false", () => {
    expect(PostChatInSchema.parse({ message: "make it punchier" }).pin).toBe(false);
  });
});

describe("PostDismissInSchema", () => {
  it("requires a target", () => {
    expect(() => PostDismissInSchema.parse({})).toThrow();
    expect(PostDismissInSchema.parse({ target: "idea" }).target).toBe("idea");
  });
  it("defaults scope to row and accepts set", () => {
    expect(PostDismissInSchema.parse({ target: "draft" }).scope).toBe("row");
    expect(PostDismissInSchema.parse({ target: "draft", scope: "set" }).scope).toBe("set");
