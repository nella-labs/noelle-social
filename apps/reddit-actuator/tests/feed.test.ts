import { describe, it, expect } from "vitest";
import { isFeedUrl, isFeedPath, chooseActuatorTab } from "../src/lib/feed.js";

describe("isFeedUrl", () => {
  it("matches the home feed in its common forms", () => {
    expect(isFeedUrl("https://www.reddit.com/")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com")).toBe(true);
    expect(isFeedUrl("https://reddit.com/")).toBe(true);
    expect(isFeedUrl("https://old.reddit.com/")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com/?feed=home")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com/#top")).toBe(true);
  });

  it("matches the home sorts and the ambient nav targets (r/all, r/popular)", () => {
    expect(isFeedUrl("https://www.reddit.com/best/")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com/hot")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com/new/")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com/top/?t=day")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com/rising/")).toBe(true);
    // MUST stay aligned with ambient.ts NAV_TARGETS, or the guard would churn
    // (re-navigating away from the page the navigate decoy itself just opened).
    expect(isFeedUrl("https://www.reddit.com/r/all/")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com/r/popular/")).toBe(true);
    expect(isFeedUrl("https://www.reddit.com/r/popular/top/")).toBe(true);
    expect(isFeedUrl("https://old.reddit.com/r/all/")).toBe(true);
  });

  it("does NOT match permalinks, subreddits, profiles, or other pages", () => {
    expect(isFeedUrl("https://www.reddit.com/r/SaaS/comments/abc123/how-we-hit-10k-mrr/")).toBe(false);
    expect(isFeedUrl("https://www.reddit.com/r/SaaS/")).toBe(false); // a subreddit listing is not THE feed
    expect(isFeedUrl("https://www.reddit.com/r/allthings/")).toBe(false); // /r/all prefix, different sub
    expect(isFeedUrl("https://www.reddit.com/user/someone/")).toBe(false);
    expect(isFeedUrl("https://www.reddit.com/message/inbox/")).toBe(false);
    expect(isFeedUrl("https://www.reddit.com/settings/")).toBe(false);
    expect(isFeedUrl("https://www.reddit.com/hottest/")).toBe(false); // /hot prefix, different page
    expect(isFeedUrl("https://accounts.reddit.com/")).toBe(false); // non-actuated host
    expect(isFeedUrl("https://www.notreddit.com/")).toBe(false);
  });

  it("is falsey- and garbage-safe", () => {
    expect(isFeedUrl(undefined)).toBe(false);
    expect(isFeedUrl(null)).toBe(false);
    expect(isFeedUrl("")).toBe(false);
    expect(isFeedUrl("not a url")).toBe(false);
  });
});

describe("isFeedPath", () => {
  it("matches feed pathnames only", () => {
    expect(isFeedPath("/")).toBe(true);
    expect(isFeedPath("/best/")).toBe(true);
    expect(isFeedPath("/hot")).toBe(true);
    expect(isFeedPath("/r/all/")).toBe(true);
    expect(isFeedPath("/r/popular")).toBe(true);
  });
  it("rejects non-feed pathnames", () => {
    expect(isFeedPath("/r/SaaS/comments/abc123/x/")).toBe(false);
    expect(isFeedPath("/user/someone/")).toBe(false);
    expect(isFeedPath("/r/allthings/")).toBe(false);
    expect(isFeedPath(undefined)).toBe(false);
  });
});

describe("chooseActuatorTab", () => {
  it("keeps the pinned tab while it is still open (never hops mid-run)", () => {
    const tabs = [
      { id: 1, url: "https://www.reddit.com/r/SaaS/comments/abc/x/" }, // sorts first, is a permalink
      { id: 2, url: "https://www.reddit.com/" },
    ];
    expect(chooseActuatorTab(tabs, 2)).toBe(2); // pinned feed tab kept
  });

  it("keeps a pinned tab even after it wandered off the feed (guard pulls it back)", () => {
    const tabs = [
      { id: 2, url: "https://www.reddit.com/user/who/" }, // the pinned tab, now on a profile
      { id: 3, url: "https://www.reddit.com/" },
    ];
    // Must NOT hop to the other feed tab — the run stays on its pinned tab.
    expect(chooseActuatorTab(tabs, 2)).toBe(2);
  });

  it("re-picks when the pinned tab has closed, preferring the feed tab", () => {
    const tabs = [
      { id: 5, url: "https://www.reddit.com/r/SaaS/comments/abc/x/" },
      { id: 6, url: "https://www.reddit.com/" },
    ];
    expect(chooseActuatorTab(tabs, 99)).toBe(6); // pinned 99 gone → prefer the feed tab, not tabs[0]
  });

  it("with no pin, prefers the feed tab over a leftmost permalink tab", () => {
    const tabs = [
      { id: 5, url: "https://www.reddit.com/r/SaaS/comments/abc/x/" }, // leftmost, was the old tabs[0] bug
      { id: 6, url: "https://old.reddit.com/" },
    ];
    expect(chooseActuatorTab(tabs)).toBe(6);
  });

  it("falls back to the first tab when none is on a feed", () => {
    const tabs = [
      { id: 5, url: "https://www.reddit.com/user/a/" },
      { id: 6, url: "https://www.reddit.com/user/b/" },
    ];
    expect(chooseActuatorTab(tabs)).toBe(5);
  });

  it("returns null when there are no reddit tabs", () => {
    expect(chooseActuatorTab([])).toBe(null);
    expect(chooseActuatorTab([{ url: "https://www.reddit.com/" }])).toBe(null); // no id
  });
});
