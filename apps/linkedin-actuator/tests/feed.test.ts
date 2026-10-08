import { describe, it, expect } from "vitest";
import { isFeedUrl, isHomeFeedUrl, isFeedPath, chooseActuatorTab } from "../src/lib/feed.js";

describe("isFeedUrl", () => {
  it("matches the feed home in its common forms", () => {
    expect(isFeedUrl("https://www.linkedin.com/feed/")).toBe(true);
    expect(isFeedUrl("https://www.linkedin.com/feed")).toBe(true);
    expect(isFeedUrl("https://www.linkedin.com/feed/?trk=x")).toBe(true);
    expect(isFeedUrl("https://www.linkedin.com/feed/update/urn:li:activity:123/")).toBe(true);
    expect(isFeedUrl("https://www.linkedin.com/feed/#main")).toBe(true);
  });

  it("does NOT match profiles, messaging, notifications, or other pages", () => {
    expect(isFeedUrl("https://www.linkedin.com/in/seth-yakatan/")).toBe(false);
    expect(isFeedUrl("https://www.linkedin.com/in/feed-guy/")).toBe(false); // /in/, not /feed
    expect(isFeedUrl("https://www.linkedin.com/messaging/thread/2-abc/")).toBe(false);
    expect(isFeedUrl("https://www.linkedin.com/notifications/")).toBe(false);
    expect(isFeedUrl("https://www.linkedin.com/mynetwork/")).toBe(false);
    expect(isFeedUrl("https://www.linkedin.com/feedback/")).toBe(false); // /feedback, not /feed
  });

  it("is falsey-safe", () => {
    expect(isFeedUrl(undefined)).toBe(false);
    expect(isFeedUrl(null)).toBe(false);
    expect(isFeedUrl("")).toBe(false);
  });
});

describe("isHomeFeedUrl", () => {
  it("matches the home feed in its common forms", () => {
    expect(isHomeFeedUrl("https://www.linkedin.com/feed/")).toBe(true);
    expect(isHomeFeedUrl("https://www.linkedin.com/feed")).toBe(true);
    expect(isHomeFeedUrl("https://www.linkedin.com/feed/?trk=x")).toBe(true);
    expect(isHomeFeedUrl("https://www.linkedin.com/feed/#main")).toBe(true);
  });

  it("does NOT match post permalinks (the group-post whiff source)", () => {
    // These ARE isFeedUrl(true) on purpose (tab selection), but must be strict-false
    // so ensureOnFeed pulls the tab back to the real feed before a like.
    expect(isHomeFeedUrl("https://www.linkedin.com/feed/update/urn:li:activity:123/")).toBe(false);
    expect(isHomeFeedUrl("https://www.linkedin.com/feed/update/urn:li:groupPost:2623372-748/")).toBe(false);
    expect(isFeedUrl("https://www.linkedin.com/feed/update/urn:li:groupPost:2623372-748/")).toBe(true);
  });

  it("does NOT match profiles, feedback, or other pages", () => {
    expect(isHomeFeedUrl("https://www.linkedin.com/in/seth-yakatan/")).toBe(false);
    expect(isHomeFeedUrl("https://www.linkedin.com/feedback/")).toBe(false);
    expect(isHomeFeedUrl("https://www.linkedin.com/notifications/")).toBe(false);
  });

  it("is falsey-safe", () => {
    expect(isHomeFeedUrl(undefined)).toBe(false);
    expect(isHomeFeedUrl(null)).toBe(false);
    expect(isHomeFeedUrl("")).toBe(false);
  });
});

describe("isFeedPath", () => {
  it("matches feed pathnames only", () => {
    expect(isFeedPath("/feed/")).toBe(true);
    expect(isFeedPath("/feed")).toBe(true);
    expect(isFeedPath("/feed/update/urn:li:activity:9/")).toBe(true);
  });
  it("rejects non-feed pathnames", () => {
    expect(isFeedPath("/in/seth-yakatan/")).toBe(false);
    expect(isFeedPath("/feedback/")).toBe(false);
    expect(isFeedPath("/")).toBe(false);
    expect(isFeedPath(undefined)).toBe(false);
  });
});

describe("chooseActuatorTab", () => {
  it("keeps the pinned tab while it is still open (never hops mid-run)", () => {
    const tabs = [
      { id: 1, url: "https://www.linkedin.com/in/someone/" }, // sorts first, is a profile
      { id: 2, url: "https://www.linkedin.com/feed/" },
    ];
    expect(chooseActuatorTab(tabs, 2)).toBe(2); // pinned feed tab kept
  });

  it("keeps a pinned tab even after it wandered off the feed (guard pulls it back)", () => {
    const tabs = [
      { id: 2, url: "https://www.linkedin.com/in/who/" }, // the pinned tab, now on a profile
      { id: 3, url: "https://www.linkedin.com/feed/" },
    ];
    // Must NOT hop to the other feed tab — the run stays on its pinned tab.
    expect(chooseActuatorTab(tabs, 2)).toBe(2);
  });

  it("re-picks when the pinned tab has closed, preferring the feed tab", () => {
    const tabs = [
      { id: 5, url: "https://www.linkedin.com/in/a-profile/" },
      { id: 6, url: "https://www.linkedin.com/feed/" },
    ];
    expect(chooseActuatorTab(tabs, 99)).toBe(6); // pinned 99 gone → prefer the feed tab, not tabs[0]
  });

  it("with no pin, prefers the feed tab over a leftmost profile tab", () => {
    const tabs = [
      { id: 5, url: "https://www.linkedin.com/in/a-profile/" }, // leftmost, was the old tabs[0] bug
      { id: 6, url: "https://www.linkedin.com/feed/" },
    ];
    expect(chooseActuatorTab(tabs)).toBe(6);
  });

  it("falls back to the first tab when none is on the feed", () => {
    const tabs = [
      { id: 5, url: "https://www.linkedin.com/in/a/" },
      { id: 6, url: "https://www.linkedin.com/in/b/" },
    ];
    expect(chooseActuatorTab(tabs)).toBe(5);
  });

  it("returns null when there are no linkedin tabs", () => {
    expect(chooseActuatorTab([])).toBe(null);
    expect(chooseActuatorTab([{ url: "https://www.linkedin.com/feed/" }])).toBe(null); // no id
  });
});
