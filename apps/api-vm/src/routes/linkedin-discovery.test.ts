import { describe, expect, it } from "vitest";
import { chooseDiscoveryTarget, normalizeBrowserObservation, normalizeObservation } from "./linkedin-discovery.js";

const now = Date.parse("2026-09-19T12:00:00Z");

describe("browser LinkedIn discovery", () => {
  it("normalizes activity IDs and keeps missing or older published times", () => {
    expect(normalizeObservation({
      url: "https://www.linkedin.com/posts/ada_activity-7481524546924343296-xyz",
      text: "A useful post about deployment tradeoffs",
      authorName: "Ada",
    })?.externalId).toBe("7481524546924343296");
    expect(normalizeObservation({
      urn: "urn:li:activity:7481524546924343297",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7481524546924343297/",
      text: "An older but useful post",
      postedAt: "2026-09-19T10:00:00Z",
    })?.postedAt).toBe("2026-09-19T10:00:00.000Z");
    expect(normalizeObservation({
      urn: "urn:li:activity:7481524546924343298", text: "No timestamp",
    })?.postedAt).toBeNull();
    expect(normalizeObservation({ url: "https://evil.example/post", text: "x" })).toBeNull();
    expect(normalizeObservation({ urn: "urn:li:activity:7481524546924343296", url: "https://www.linkedin.com/in/ada/", text: "x" })).toBeNull();
    expect(normalizeObservation({
      urn: "urn:li:activity:7481524546924343296",
      url: "https://www.linkedin.com/posts/ada_activity-7481524546924343297-xyz",
      text: "Mismatched permalink",
    })).toBeNull();
  });

  it("stages a stable browser fingerprint without inventing a post permalink", () => {
    const candidate = normalizeBrowserObservation({
      fingerprint: "update-card-focus-opaque-feed",
      text: "  A detailed post with useful advice  ",
      authorHandle: "ada",
      reactionCount: 42,
      commentCount: 7,
    }, "22222222-2222-4222-8222-222222222222");
    expect(candidate).toEqual(expect.objectContaining({
      externalId: expect.stringMatching(/^browser:[a-f0-9]{64}$/),
      fingerprint: "update-card-focus-opaque-feed",
      text: "A detailed post with useful advice",
      reactionCount: 42,
      commentCount: 7,
      postedAt: null,
    }));
    expect(candidate).not.toHaveProperty("urn");
    expect(candidate).not.toHaveProperty("url");
    expect(normalizeBrowserObservation({ fingerprint: "update-card-focus-opaque-feed", text: "A detailed post with useful advice" }, "22222222-2222-4222-8222-222222222222")?.externalId).toBe(candidate?.externalId);
    expect(normalizeBrowserObservation({ fingerprint: "update-card-focus-opaque-feed", text: "A detailed post with useful advice" }, "33333333-3333-4333-8333-333333333333")?.externalId).not.toBe(candidate?.externalId);
  });

  it("rejects unsafe anonymous observations instead of laundering a fake URL", () => {
    const instance = "22222222-2222-4222-8222-222222222222";
    expect(normalizeBrowserObservation({ text: "post without identity" }, instance)).toBeNull();
    expect(normalizeBrowserObservation({ fingerprint: "x", text: "post", url: "https://evil.example/post" }, instance)).toBeNull();
    expect(normalizeBrowserObservation({ fingerprint: "x", text: "post", urn: "urn:li:activity:not-a-number" }, instance)).toBeNull();
    expect(normalizeBrowserObservation({ fingerprint: "x", text: "post", reactionCount: -1 }, instance)).toBeNull();
  });

  it("keeps the four-hour profile cooldown and favors recent posters", () => {
    const people = [
      { id: "old", publicId: "old", lastCheckedAt: null, latestObservedPostAt: "2026-09-18T12:00:00Z" },
      { id: "recent", publicId: "recent", lastCheckedAt: "2026-09-19T07:00:00Z", latestObservedPostAt: "2026-09-19T11:40:00Z" },
      { id: "cooling", publicId: "cooling", lastCheckedAt: "2026-09-19T10:00:00Z", latestObservedPostAt: "2026-09-19T11:50:00Z" },
    ];
    expect(chooseDiscoveryTarget(people, [], 1, now)).toEqual({ kind: "profile", id: "recent", url: "https://www.linkedin.com/in/recent/recent-activity/all/" });
    expect(chooseDiscoveryTarget(people, [], 5, now)).toEqual({ kind: "profile", id: "old", url: "https://www.linkedin.com/in/old/recent-activity/all/" });
  });

  it("rotates keyword searches on other eligible slots", () => {
    const people = [{ id: "p", publicId: "p", lastCheckedAt: null, latestObservedPostAt: null }];
    const keywords = [
      { id: "a", value: "ai agents", lastCheckedAt: "2026-09-19T10:00:00Z" },
      { id: "b", value: "founder lessons", lastCheckedAt: null },
    ];
    expect(chooseDiscoveryTarget(people, keywords, 3, now)).toEqual({ kind: "keyword", id: "b", url: "https://www.linkedin.com/search/results/content/?keywords=founder%20lessons&sortBy=%22date_posted%22" });
  });

  it("revisits a qualified pending author in an existing profile slot without taking watched or keyword turns", () => {
    const watched = [
      { id: "recent", publicId: "recent", lastCheckedAt: "2026-09-19T07:00:00Z", latestObservedPostAt: "2026-09-19T11:40:00Z" },
      { id: "oldest", publicId: "oldest", lastCheckedAt: null, latestObservedPostAt: null },
    ];
    const keywords = [{ id: "keyword", value: "ai agents", lastCheckedAt: null }];
    const pending = [{ publicId: "ada-builder", lastCheckedAt: null, latestPendingAt: "2026-09-19T11:50:00Z" }];
    expect(chooseDiscoveryTarget(watched, keywords, 1, now, pending)).toEqual({
      kind: "profile", id: "recent", url: "https://www.linkedin.com/in/recent/recent-activity/all/",
    });
    expect(chooseDiscoveryTarget(watched, keywords, 2, now, pending)).toEqual({
      kind: "profile", id: "ada-builder", url: "https://www.linkedin.com/in/ada-builder/recent-activity/all/", source: "pending",
    });
    expect(chooseDiscoveryTarget(watched, keywords, 3, now, pending)?.kind).toBe("keyword");
    expect(chooseDiscoveryTarget(watched, keywords, 5, now, pending)).toEqual({
      kind: "profile", id: "oldest", url: "https://www.linkedin.com/in/oldest/recent-activity/all/",
    });
  });

  it("revisits qualified pending authors after five minutes and skips unsafe profile IDs", () => {
    const candidates = [
      { publicId: "recent", lastCheckedAt: "2026-09-19T11:55:00.001Z", latestPendingAt: "2026-09-19T11:50:00Z" },
      { publicId: "../feed", lastCheckedAt: null, latestPendingAt: "2026-09-19T11:51:00Z" },
      { publicId: "bad-stamp", lastCheckedAt: "invalid", latestPendingAt: "2026-09-19T11:52:00Z" },
      { publicId: "ok-author", lastCheckedAt: "2026-09-19T11:55:00.000Z", latestPendingAt: "2026-09-19T11:49:00Z" },
    ];
    expect(chooseDiscoveryTarget([], [], 2, now, candidates)).toEqual({
      kind: "profile", id: "ok-author", url: "https://www.linkedin.com/in/ok-author/recent-activity/all/", source: "pending",
    });
    expect(chooseDiscoveryTarget([], [], 2, now, candidates.slice(0, 3))).toBeNull();
  });
});
