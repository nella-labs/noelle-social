import { describe, it, expect, vi, afterEach } from "vitest";
import type { NoelleAgentInstance } from "@/lib/db-types";
const query = vi.hoisted(() => vi.fn());
vi.mock("@/lib/db", async () => {
  const fragments = (await import("postgres")).default();
  return { sql: new Proxy(fragments, { apply(target, receiver, args) {
    const [strings] = args as [TemplateStringsArray];
    return strings.join("").trim().startsWith("select") ? Reflect.apply(query, receiver, args) : Reflect.apply(target, receiver, args);
  } }) };
});
import { toChatLeadSummary, loadChatContextForInstance } from "./context";

afterEach(() => { query.mockReset(); vi.restoreAllMocks(); });
const instance = { id: "instance", org_id: "organization", role: "x_intern" } as NoelleAgentInstance;
it("keeps failed X snapshot reads unavailable instead of manufacturing empty queue, targets and leads", async () => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  query.mockRejectedValue(new Error("offline query failure"));
  const context = await loadChatContextForInstance(instance);
  expect(context.pendingApprovals).toBeUndefined();
  expect(context.targeting).toBeUndefined();
  expect(context.bestLeads).toBeUndefined();
  expect(context.totalPendingCount).toBeUndefined();
});
it("preserves measured empty X snapshot collections", async () => {
  query.mockResolvedValue([]);
  const context = await loadChatContextForInstance(instance);
  expect(context.pendingApprovals).toEqual([]);
  expect(context.targeting).toEqual({ handles: [], keywords: [] });
  expect(context.bestLeads).toEqual([]);
});
it("does not turn a pending DM body into a public X reply composer", async () => {
  query.mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes("a_id") ? [{ a_id: "dm", d_payload: { kind: "dm", body: "Private DM draft" }, l_external_id: "123", l_author_handle: "source", l_payload: { post_text: "Source post" } }] : []);
  expect((await loadChatContextForInstance(instance)).pendingApprovals?.[0]?.replyUrl).toBeNull();
});

it("loads the Reddit watchlist through its scoped role owner", async () => {
  query.mockImplementation(async (strings: TemplateStringsArray) => strings.join("").includes("reddit_watchlist") ? [{ subreddit: "saas" }] : []);
  const context = await loadChatContextForInstance({ ...instance, role: "reddit_intern", objective: "Meet founders" });
  expect(context.targeting).toEqual({ handles: ["r/saas"], keywords: [] });
  expect(context.objective).toBe("Meet founders");
  const call = query.mock.calls.find(([strings]) => strings.join("").includes("reddit_watchlist"));
  expect(call?.slice(1)).toEqual([instance.id, instance.org_id]);
  expect(query.mock.calls.some(([strings]) => strings.join("").includes("x_watchlist"))).toBe(false);
});
it.each(["reddit_intern", "linkedin_intern"])("%s distinguishes unavailable targets from measured empty targets", async (role) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  query.mockRejectedValue(new Error("offline"));
  expect((await loadChatContextForInstance({ ...instance, role })).targeting).toBeUndefined();
  query.mockResolvedValue([]);
  expect((await loadChatContextForInstance({ ...instance, role })).targeting).toEqual({ handles: [], keywords: [] });
});

it.each([[null, "100", null, null], ["0", "100", 0, 0], ["500", "0", 500, null], ["bad", "100", null, null], ["2.9", "100", null, null]])("keeps Video views %j / followers %j as observed count %j and ratio %j", async (views, followers, expectedViews, expectedRatio) => {
  query.mockImplementation(async (strings: TemplateStringsArray) => {
    const text = strings.join("");
    if (text.includes("i.hook as idea_hook")) return [{ idea_hook: "Fixture hook", status: "draft", structure: [], inspiration_clip_ids: ["fixture-clip"] }];
    if (text.includes("from noelle.video_clips")) return [{ author_handle: "fixture_creator", views, author_follower_count: followers }];
    return [];
  });
  const context = await loadChatContextForInstance({ ...instance, role: "video_intern" }, { draftId: "fixture-draft" });
  expect(context.videoIntel?.topClips[0]?.views).toBe(expectedViews);
  expect(context.currentDraft?.inspirations?.[0]).toMatchObject({ views: expectedViews, reachMultiple: expectedRatio });
});

describe("toChatLeadSummary", () => {
  it("maps a classified lead with handle + post id into links", () => {
    const s = toChatLeadSummary({
      authorHandle: "@simonw",
      tier: "T1",
      classifierScore: "91",
      postId: "1790",
      postText: "agents keep hallucinating imports",
      hasDraft: false,
    });
    expect(s).toEqual({
      handle: "simonw", // leading @ normalised away
      tier: "T1",
      score: 91,
      postText: "agents keep hallucinating imports",
      postId: "1790",
      originalPostUrl: "https://x.com/simonw/status/1790",
      replyUrl: "https://x.com/intent/tweet?in_reply_to=1790",
      hasDraft: false,
    });
  });

  it("nulls the links when post id is missing", () => {
    const s = toChatLeadSummary({
      authorHandle: "fred",
      tier: null,
      classifierScore: null,
      postId: null,
      postText: null,
      hasDraft: true,
    });
    expect(s.originalPostUrl).toBeNull();
    expect(s.replyUrl).toBeNull();
    expect(s.postText).toBe("");
    expect(s.tier).toBeNull();
    expect(s.score).toBeNull();
    expect(s.hasDraft).toBe(true);
  });
});
