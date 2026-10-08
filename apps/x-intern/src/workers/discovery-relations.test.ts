import { describe, expect, it, vi } from "vitest";
import { runDiscoveryTick } from "./discovery-tick.js";

describe("discovery source relations", () => {
  it("retains source thread identifiers in the saved lead used by opportunity ranking", async () => {
    const tweet = { id: "123", text: "post", created_at: "2026-10-05T10:00:00Z",
      author: { handle: "builder", id: "42", followers: 100 }, url: "https://x.com/builder/status/123",
      is_repost: false, is_reply: true, conversation_id: "100", in_reply_to_id: "101" };
    const upsertLead = vi.fn().mockResolvedValue({ id: "lead", inserted: true });
    await runDiscoveryTick({ log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      instance: { id: "instance", org_id: "org", discovery_config: { excludeReplies: false } }, watchlist: { handles: ["builder"], keywords: [] }, watchlistPeople: [],
      xClient: { userTweets: vi.fn().mockResolvedValue({ tweets: [tweet], resultCount: 1 }) } as never,
      upsertLead, rateBucket: { tryTake: () => true } });
    expect(upsertLead).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ conversation_id: "100", in_reply_to_id: "101", is_reply: true }) }));
  });
});
