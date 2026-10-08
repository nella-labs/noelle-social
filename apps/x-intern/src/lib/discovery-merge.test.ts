import { describe, expect, it } from "vitest";
import type { XTweet } from "@noelle/x-apify";
import { mergeDiscoveryTweets } from "./discovery-merge.js";

const tweet = (id: string, likes: number | null = null): XTweet => ({
  id,
  text: `Post ${id}`,
  created_at: "2026-10-05T10:00:00Z",
  author: { id: "123", handle: "builder", followers: null },
  url: `https://x.com/builder/status/${id}`,
  likes,
  reposts: null,
  replies: null,
  is_repost: false,
});

describe("discovery source merge", () => {
  it("interleaves uneven sources in stable order without changing their arrays", () => {
    const batches = [
      [tweet("1"), tweet("2"), tweet("3")],
      [],
      [tweet("4")],
      [tweet("5"), tweet("6")],
    ];
    expect(mergeDiscoveryTweets(batches).map((item) => item.id)).toEqual([
      "1",
      "4",
      "5",
      "2",
      "6",
      "3",
    ]);
    expect(batches[0]?.map((item) => item.id)).toEqual(["1", "2", "3"]);
    expect(mergeDiscoveryTweets([])).toEqual([]);
  });

  it("deduplicates globally and preserves the first observation's unknown metrics", () => {
    const first = tweet("1");
    expect(
      mergeDiscoveryTweets([[first, tweet("2")], [tweet("1", 100), tweet("3")], [tweet("2")]]),
    ).toEqual([first, tweet("2"), tweet("3")]);
    expect(first.likes).toBeNull();
  });
});
