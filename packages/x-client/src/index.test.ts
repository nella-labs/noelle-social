import { describe, it, expect } from "vitest";
import { createXClient, type BirdLike } from "./index.js";

// A tweet's own creation time is the only thing the recency pipeline can trust
// to honor the "max lead age" rule. Bird exposes it as the typed `createdAt`,
// but for some result shapes (visibility-wrapped tweets) that field is absent
// and the real value only survives on the raw GraphQL `legacy.created_at`. The
// adapter must recover it there and must NEVER fabricate a timestamp — a faked
// "now" makes an ancient tweet look fresh and defeats every age guard.

function stubBird(tweets: unknown[]): BirdLike {
  return {
    getCurrentUser: async () => ({ success: true, user: { id: "1", username: "me" } }),
    getUserIdByUsername: async () => ({ success: true, userId: "42" }),
    getUserTweets: async () => ({ success: true, tweets }),
    search: async () => ({ success: true, tweets }),
    reply: async () => ({ success: true as const, tweetId: "x" }),
    like: async () => ({ success: true }),
  } as unknown as BirdLike;
}

const clientFor = (tweets: unknown[]) =>
  createXClient({ ct0: "c", authToken: "a", client: stubBird(tweets) });

const DAY_MS = 24 * 60 * 60 * 1000;

describe("toXTweet date handling (via searchTimeline / userTweets)", () => {
  it("keeps a tweet's real created_at from the typed field", async () => {
    const iso = "2026-06-01T00:00:00.000Z";
    const res = await clientFor([
      { id: "1", text: "hi", author: { username: "a", name: "A" }, createdAt: iso },
    ]).searchTimeline({ query: "q" });
    expect(res).toHaveLength(1);
    expect(res[0]!.created_at).toBe(iso);
  });

  it("recovers a missing typed createdAt from _raw.legacy.created_at (never fabricates now)", async () => {
    // X's legacy created_at format; ~3.5 months before the test runs.
    const realOld = "Sat Feb 24 14:00:41 +0000 2026";
    const res = await clientFor([
      {
        id: "2",
        text: "old",
        author: { username: "a", name: "A" },
        _raw: { legacy: { created_at: realOld } },
      },
    ]).searchTimeline({ query: "q" });
    expect(res).toHaveLength(1);
    expect(new Date(res[0]!.created_at).toISOString()).toBe(new Date(realOld).toISOString());
    // and crucially: NOT stamped ~now
    expect(Date.now() - new Date(res[0]!.created_at).getTime()).toBeGreaterThan(DAY_MS);
  });

  it("recovers the date from a visibility-wrapped _raw.tweet.legacy.created_at", async () => {
    const realOld = "Sat Feb 24 14:00:41 +0000 2026";
    const res = await clientFor([
      {
        id: "5",
        text: "wrapped",
        author: { username: "a", name: "A" },
        _raw: { tweet: { legacy: { created_at: realOld } } },
      },
    ]).userTweets({ handle: "a" });
    expect(res).toHaveLength(1);
    expect(new Date(res[0]!.created_at).toISOString()).toBe(new Date(realOld).toISOString());
  });

  it.each(["2026-02-30T10:00:00Z", "Mon Feb 30 10:00:00 +0000 2026", "2025-02-29T10:00:00Z"])("rejects an impossible calendar date instead of rolling it forward: %s", async createdAt => {
    expect(await clientFor([{ id: "123", text: "source observation", author: { username: "builder" }, createdAt }]).searchTimeline({ query: "q" })).toHaveLength(0);
  });
  it("uses a valid raw date when the typed date is impossible", async () => {
    const [tweet] = await clientFor([{ id: "123", text: "source observation", author: { username: "builder" }, createdAt: "2026-02-30T10:00:00Z", _raw: { legacy: { created_at: "2024-02-29T10:00:00+02:00" } } }]).searchTimeline({ query: "q" });
    expect(tweet?.created_at).toBe("2024-02-29T08:00:00.000Z");
  });
  it("drops a tweet with no usable date anywhere (never fabricates now)", async () => {
    const res = await clientFor([
      { id: "3", text: "nodate", author: { username: "a", name: "A" } },
    ]).searchTimeline({ query: "q" });
    expect(res).toHaveLength(0);
  });

  it("still drops dateable tweets older than the sinceISO window", async () => {
    const res = await clientFor([
      {
        id: "4",
        text: "old",
        author: { username: "a", name: "A" },
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]).searchTimeline({ query: "q", sinceISO: "2026-06-01T00:00:00.000Z" });
    expect(res).toHaveLength(0);
  });
});

// A repost (pure retweet) carries no commentary of the watched person's own —
// replying to it is replying to someone else's words. The adapter flags it so
// discovery can drop it; a quote-tweet (the person added their own take) is NOT
// a repost and must survive.
describe("toXTweet repost detection (is_repost)", () => {
  it("flags a retweet detected via the raw legacy.retweeted_status_id_str", async () => {
    const res = await clientFor([
      {
        id: "1",
        text: 'RT @orig: "swarm mode was great"',
        author: { username: "yangli_", name: "Yang" },
        createdAt: "2026-06-10T00:00:00.000Z",
        _raw: { legacy: { retweeted_status_id_str: "999" } },
      },
    ]).userTweets({ handle: "yangli_" });
    expect(res[0]?.is_repost).toBe(true);
  });

  it("flags a retweet detected via the raw legacy.retweeted_status_result", async () => {
    const res = await clientFor([
      {
        id: "1",
        text: "expanded retweet body without RT prefix",
        author: { username: "yangli_", name: "Yang" },
        createdAt: "2026-06-10T00:00:00.000Z",
        _raw: { legacy: { retweeted_status_result: { result: { rest_id: "999" } } } },
      },
    ]).userTweets({ handle: "yangli_" });
    expect(res[0]?.is_repost).toBe(true);
  });

  it("flags a retweet by the 'RT @' text prefix when no raw block is present", async () => {
    const res = await clientFor([
      {
        id: "1",
        text: 'RT @orig: "swarm mode was great"',
        author: { username: "yangli_", name: "Yang" },
        createdAt: "2026-06-10T00:00:00.000Z",
      },
    ]).userTweets({ handle: "yangli_" });
    expect(res[0]?.is_repost).toBe(true);
  });

  it("does NOT flag an original authored tweet", async () => {
    const res = await clientFor([
      {
        id: "1",
        text: "my own hot take on swarm mode",
        author: { username: "yangli_", name: "Yang" },
        createdAt: "2026-06-10T00:00:00.000Z",
      },
    ]).userTweets({ handle: "yangli_" });
    expect(res[0]?.is_repost).toBe(false);
  });

  it("does NOT flag a quote-tweet (own commentary + quoted_status, no retweeted_status)", async () => {
    const res = await clientFor([
      {
        id: "1",
        text: "this is exactly right, here's why it matters",
        author: { username: "yangli_", name: "Yang" },
        createdAt: "2026-06-10T00:00:00.000Z",
        _raw: { legacy: { quoted_status_id_str: "999" } },
      },
    ]).userTweets({ handle: "yangli_" });
    expect(res[0]?.is_repost).toBe(false);
  });
});

// A tweet's image(s) ground the (text-only) drafter's reply so it isn't blind to
// the visual. X attaches media on the raw GraphQL legacy block under
// extended_entities.media[] (preferred) or entities.media[], each with a
// media_url_https. The adapter pulls them from `_raw` defensively (mirroring
// followers/created_at) — missing or odd shapes must never throw and just yield
// no images. The key is omitted entirely on a text-only tweet.
describe("toXTweet image extraction (images)", () => {
  it("pulls photo URLs from _raw.legacy.extended_entities.media", async () => {
    const res = await clientFor([
      {
        id: "1",
        text: "look at this chart",
        author: { username: "u", name: "U" },
        createdAt: "2026-06-10T00:00:00.000Z",
        _raw: {
          legacy: {
            extended_entities: {
              media: [
                { type: "photo", media_url_https: "https://pbs.twimg.com/media/a.jpg" },
                { type: "photo", media_url_https: "https://pbs.twimg.com/media/b.jpg" },
              ],
            },
          },
        },
      },
    ]).searchTimeline({ query: "q" });
    expect(res[0]?.images).toEqual([
      "https://pbs.twimg.com/media/a.jpg",
      "https://pbs.twimg.com/media/b.jpg",
    ]);
  });

  it("takes the thumbnail (media_url_https) for a video and dedupes", async () => {
    const res = await clientFor([
      {
        id: "1",
        text: "watch this",
