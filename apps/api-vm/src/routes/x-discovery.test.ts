import { describe, expect, it } from "vitest";
import { chooseXDiscoveryTarget, normalizeXObservation } from "./x-discovery.js";

const now = Date.parse("2026-09-19T12:00:00Z");

describe("browser X observations", () => {
  const post = {
    tweetId: "1837123456789012345",
    url: "https://x.com/ada/status/1837123456789012345?utm_source=feed",
    text: "  Useful deployment lessons  ",
    authorHandle: "@Ada",
  };

  it("normalizes a numeric status identity and retains unknown or older times", () => {
    expect(normalizeXObservation(post)).toEqual(expect.objectContaining({
      tweetId: post.tweetId, url: "https://x.com/ada/status/1837123456789012345",
      text: "Useful deployment lessons", authorHandle: "ada", postedAt: null,
    }));
    expect(normalizeXObservation({ ...post, postedAt: "2026-09-19T10:00:00Z" })?.postedAt)
      .toBe("2026-09-19T10:00:00.000Z");
    expect(normalizeXObservation({ ...post, postedAt: "unknown" })?.postedAt).toBeNull();
  });

  it("keeps impossible observed dates unknown and rejects zero status identities", () => {
    expect(normalizeXObservation({ ...post, postedAt: "2026-02-30T10:00:00Z" })?.postedAt).toBeNull();
    expect(normalizeXObservation({ ...post, tweetId: "0", url: "https://x.com/ada/status/0" })).toBeNull();
  });
  it("retains a premium post up to 25,000 characters", () => {
    expect(normalizeXObservation({ ...post, text: "a".repeat(20_000) })?.text).toHaveLength(20_000);
    expect(normalizeXObservation({ ...post, text: "a".repeat(25_001) })).toBeNull();
  });

  it("rejects conflicting or unsafe links, IDs, handles, and empty content", () => {
    expect(normalizeXObservation({ ...post, url: "https://evil.example/ada/status/1837123456789012345" })).toBeNull();
    expect(normalizeXObservation({ ...post, url: "https://x.com/ada/status/1837123456789012346" })).toBeNull();
    expect(normalizeXObservation({ ...post, url: "https://x.com/other/status/1837123456789012345" })).toBeNull();
    expect(normalizeXObservation({ ...post, tweetId: "abc" })).toBeNull();
    expect(normalizeXObservation({ ...post, authorHandle: "bad/handle" })).toBeNull();
    expect(normalizeXObservation({ ...post, text: "  " })).toBeNull();
  });
});

describe("browser X target selection", () => {
  const profiles = [
    { handle: "old", lastCheckedAt: null, latestObservedPostAt: "2026-09-18T12:00:00Z" },
    { handle: "recent", lastCheckedAt: "2026-09-19T07:00:00Z", latestObservedPostAt: "2026-09-19T11:40:00Z" },
    { handle: "cooling", lastCheckedAt: "2026-09-19T10:00:00Z", latestObservedPostAt: "2026-09-19T11:50:00Z" },
  ];
  const keywords = [
    { value: "ai agents", lastCheckedAt: "2026-09-19T10:00:00Z" },
    { value: "founder lessons", lastCheckedAt: null },
  ];

  it("uses a four-hour profile cooldown and favors recent posters", () => {
    expect(chooseXDiscoveryTarget(profiles, [], 4, now)).toEqual({ kind: "profile", handle: "recent" });
    expect(chooseXDiscoveryTarget(profiles, [], 5, now)).toEqual({ kind: "profile", handle: "old" });
    expect(chooseXDiscoveryTarget([profiles[2]!], [], 4, now)).toBeNull();
  });

  it("allocates three of five targeted reads to topical keyword searches", () => {
    const kinds = Array.from({ length: 10 }, (_, i) => chooseXDiscoveryTarget(profiles, keywords, i + 1, now)?.kind);
    expect(kinds).toEqual(["keyword", "keyword", "keyword", "profile", "profile", "keyword", "keyword", "keyword", "profile", "profile"]);
    expect(chooseXDiscoveryTarget(profiles, keywords, 3, now)).toEqual({ kind: "keyword", value: "founder lessons" });
    expect(chooseXDiscoveryTarget([profiles[2]!], keywords, 1, now)).toEqual({ kind: "keyword", value: "founder lessons" });
  });
});
