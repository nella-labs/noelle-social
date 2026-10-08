import { describe, expect, it, vi } from "vitest";
import { runProfilerTick } from "./profiler-tick.js";

const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const instance = { id: "i", org_id: "o" } as never;
const post = (text: string) => ({
  id: "t",
  urn: "urn:li:activity:t",
  text,
  url: "u",
  postedAt: "2026-06-08T00:00:00.000Z",
  reactions: 0,
  comments: 0,
  author: { name: "Jane", publicId: "jane-builder", url: "u", headline: "Founder" },
});
const person = { fsdProfileId: "ABC123", publicId: "jane-builder", name: "Jane", headline: "Founder" };

describe("runProfilerTick (linkedin / apify)", () => {
  it("deep-fetches ~40 posts, calls the LLM, and upserts a parsed profile", async () => {
    const profilePosts = vi.fn().mockResolvedValue([post("shipping a thing"), post("dx matters")]);
    const draft = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        summary: "Young founder who ships.",
        topics: ["dx", "founders", "a", "b", "c", "d", "e"],
        tone: "earnest",
        engagement_notes: "be concrete",
      }),
      engine: "bedrock",
      model: "claude-sonnet-4-6",
    });
    const upsertProfile = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);

    const n = await runProfilerTick({
      log,
      instance,
      people: [person],
      postsSource: { profilePosts },
      runner: { draft } as never,
      upsertProfile,
      markAttempted,
    });

    expect(n).toBe(1);
    // Deep history read — default 40 posts per person, by public_id.
    expect(profilePosts).toHaveBeenCalledWith({ publicId: "jane-builder", maxPosts: 40 });
    expect(draft).toHaveBeenCalledTimes(1);
    expect(draft.mock.calls[0]![0].agentRole).toBe("linkedin_intern");
    expect(upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        fsdProfileId: "ABC123",
        publicId: "jane-builder",
        summary: "Young founder who ships.",
        tone: "earnest",
        engagementNotes: "be concrete",
        postsAnalyzed: 2,
        model: "claude-sonnet-4-6",
      }),
    );
    expect(upsertProfile.mock.calls[0]?.[0]?.topics).toHaveLength(6); // capped at 6
    expect(markAttempted).not.toHaveBeenCalled();
  });

  it("honors an explicit postLimit override", async () => {
    const profilePosts = vi.fn().mockResolvedValue([post("hi")]);
    const draft = vi.fn().mockResolvedValue({
      text: JSON.stringify({ summary: "s", topics: [], tone: "", engagement_notes: "" }),
      engine: "bedrock",
      model: "m",
    });
    await runProfilerTick({
      log,
      instance,
      people: [person],
      postsSource: { profilePosts },
      runner: { draft } as never,
      upsertProfile: vi.fn().mockResolvedValue(undefined),
      markAttempted: vi.fn().mockResolvedValue(undefined),
      postLimit: 25,
    });
    expect(profilePosts).toHaveBeenCalledWith({ publicId: "jane-builder", maxPosts: 25 });
  });

  it("backs off (no upsert) when the LLM output fails to parse", async () => {
    const draft = vi.fn().mockResolvedValue({ text: "not json at all", engine: "e", model: "m" });
    const upsertProfile = vi.fn();
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const n = await runProfilerTick({
      log,
      instance,
      people: [person],
      postsSource: { profilePosts: vi.fn().mockResolvedValue([post("hi")]) },
      runner: { draft } as never,
      upsertProfile,
      markAttempted,
    });
    expect(n).toBe(0);
    expect(upsertProfile).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith(
      expect.objectContaining({ fsdProfileId: "ABC123", agentInstanceId: "i", orgId: "o" }),
    );
  });

  it("backs off (no LLM call) when the person has no posts", async () => {
    const draft = vi.fn();
    const upsertProfile = vi.fn();
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    await runProfilerTick({
      log,
      instance,
      people: [person],
      postsSource: { profilePosts: vi.fn().mockResolvedValue([]) },
      runner: { draft } as never,
      upsertProfile,
      markAttempted,
    });
    expect(draft).not.toHaveBeenCalled();
    expect(upsertProfile).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith(expect.objectContaining({ fsdProfileId: "ABC123" }));
  });

  it("backs off when the person has no public_id (cannot query Apify)", async () => {
    const profilePosts = vi.fn();
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    await runProfilerTick({
      log,
      instance,
      people: [{ ...person, publicId: null }],
      postsSource: { profilePosts },
      runner: { draft: vi.fn() } as never,
      upsertProfile: vi.fn(),
      markAttempted,
    });
    expect(profilePosts).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith(expect.objectContaining({ fsdProfileId: "ABC123" }));
  });
});
