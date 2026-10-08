import { describe, expect, it, vi } from "vitest";
import { runProfilerTick } from "./profiler-tick.js";
import { AllApifyTokensExhaustedError } from "../lib/apify-rotating.js";

const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
const instance = { id: "i", org_id: "o" } as never;
const tweet = (text: string) => ({
  id: "t",
  text,
  created_at: "2026-05-29T00:00:00.000Z",
  author: { handle: "patio11", id: "p", followers: 1 },
  url: "u",
});
const person = { handle: "patio11", addedAt: "2026-05-29T00:00:00.000Z" };
// The Apify X client returns { tweets, resultCount }; wrap arrays for the mocks.
const res = (tweets: unknown[]) => ({ tweets, resultCount: tweets.length });

describe("runProfilerTick", () => {
  it("surfaces pool exhaustion without marking the failed or remaining people attempted", async () => {
    const exhausted = new AllApifyTokensExhaustedError(2, "monthly cap");
    const userTweets = vi
      .fn()
      .mockResolvedValueOnce(res([tweet("shipping")]))
      .mockRejectedValueOnce(exhausted);
    const upsertProfile = vi.fn();
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    await expect(
      runProfilerTick({
        log,
        instance,
        people: [person, { ...person, handle: "second" }, { ...person, handle: "third" }],
        xClient: { userTweets } as never,
        runner: {
          draft: vi.fn().mockResolvedValue({ text: '{"summary":"Builder"}', model: "m" }),
        } as never,
        upsertProfile,
        markAttempted,
        rateBucket: { tryTake: () => true },
      }),
    ).rejects.toBe(exhausted);
    expect(userTweets).toHaveBeenCalledTimes(2);
    expect(upsertProfile).toHaveBeenCalledTimes(1);
    expect(markAttempted).not.toHaveBeenCalled();
  });

  it("keeps ordinary person failures local and proceeds to the next person", async () => {
    const userTweets = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary fetch failure"))
      .mockResolvedValueOnce(res([tweet("shipping")]));
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const upsertProfile = vi.fn();
    const count = await runProfilerTick({
      log,
      instance,
      people: [person, { ...person, handle: "second" }],
      xClient: { userTweets } as never,
      runner: {
        draft: vi.fn().mockResolvedValue({ text: '{"summary":"Builder"}', model: "m" }),
      } as never,
      upsertProfile,
      markAttempted,
      rateBucket: { tryTake: () => true },
    });
    expect(count).toBe(1);
    expect(markAttempted).toHaveBeenCalledOnce();
    expect(markAttempted).toHaveBeenCalledWith(expect.objectContaining({ handle: person.handle }));
    expect(upsertProfile).toHaveBeenCalledWith(expect.objectContaining({ handle: "second" }));
  });
  it("fetches tweets, calls the LLM, and upserts a parsed profile", async () => {
    const userTweets = vi
      .fn()
      .mockResolvedValue(res([tweet("shipping a thing"), tweet("dx matters")]));
    const draft = vi.fn().mockResolvedValue({
      text: JSON.stringify({
        summary: "Indie founder who ships.",
        topics: ["dx", "founders", "a", "b", "c", "d", "e"],
        tone: "dry",
        engagement_notes: "be concrete",
      }),
      engine: "codex",
      model: "gpt-5",
    });
    const upsertProfile = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);

    const n = await runProfilerTick({
      log,
      instance,
      people: [person],
      xClient: { userTweets } as never,
      runner: { draft } as never,
      upsertProfile,
      markAttempted,
      rateBucket: { tryTake: () => true },
    });

    expect(n).toBe(1);
    expect(userTweets).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "patio11", limit: 150 }),
    );
    expect(draft).toHaveBeenCalledTimes(1);
    expect(upsertProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        handle: "patio11",
        summary: "Indie founder who ships.",
        tone: "dry",
        engagementNotes: "be concrete",
        postsAnalyzed: 2,
        model: "gpt-5",
      }),
    );
    expect(upsertProfile.mock.calls[0]?.[0]?.topics).toHaveLength(6); // capped at 6
    expect(markAttempted).not.toHaveBeenCalled(); // success → no back-off
  });

  it("backs off (no upsert) when the LLM output fails to parse", async () => {
    const draft = vi.fn().mockResolvedValue({ text: "not json at all", engine: "e", model: "m" });
    const upsertProfile = vi.fn().mockResolvedValue(undefined);
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    const n = await runProfilerTick({
      log,
      instance,
      people: [person],
      xClient: { userTweets: vi.fn().mockResolvedValue(res([tweet("hi")])) } as never,
      runner: { draft } as never,
      upsertProfile,
      markAttempted,
      rateBucket: { tryTake: () => true },
    });
    expect(n).toBe(0);
    expect(upsertProfile).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "patio11", agentInstanceId: "i", orgId: "o" }),
    );
  });

  it("backs off (no LLM call) when the account has no tweets", async () => {
    const draft = vi.fn();
    const upsertProfile = vi.fn();
    const markAttempted = vi.fn().mockResolvedValue(undefined);
    await runProfilerTick({
      log,
      instance,
      people: [person],
      xClient: { userTweets: vi.fn().mockResolvedValue(res([])) } as never,
      runner: { draft } as never,
      upsertProfile,
      markAttempted,
      rateBucket: { tryTake: () => true },
    });
    expect(draft).not.toHaveBeenCalled();
    expect(upsertProfile).not.toHaveBeenCalled();
    expect(markAttempted).toHaveBeenCalledWith(expect.objectContaining({ handle: "patio11" }));
  });

  it("defers a person when the rate bucket is empty (no fetch, no back-off)", async () => {
    const userTweets = vi.fn();
    const markAttempted = vi.fn();
    await runProfilerTick({
      log,
      instance,
      people: [person],
      xClient: { userTweets } as never,
      runner: { draft: vi.fn() } as never,
      upsertProfile: vi.fn(),
      markAttempted,
      rateBucket: { tryTake: () => false },
    });
    expect(userTweets).not.toHaveBeenCalled();
    expect(markAttempted).not.toHaveBeenCalled();
  });
});
