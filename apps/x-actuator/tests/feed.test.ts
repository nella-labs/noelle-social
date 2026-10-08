import { describe, it, expect } from "vitest";
import { isFeedUrl, isFeedPath, chooseActuatorTab, isHomeUrl } from "../src/lib/feed.js";

describe("isFeedUrl", () => {
  it("matches the home timeline in its common forms", () => {
    expect(isFeedUrl("https://x.com/home")).toBe(true);
    expect(isFeedUrl("https://x.com/home/")).toBe(true);
    expect(isFeedUrl("https://x.com/home?f=live")).toBe(true);
    expect(isFeedUrl("https://x.com/home#top")).toBe(true);
    expect(isFeedUrl("https://twitter.com/home")).toBe(true); // legacy domain
    expect(isFeedUrl("https://www.x.com/home")).toBe(true);
  });

  it("does NOT match profiles, permalinks, notifications, or other pages", () => {
    expect(isFeedUrl("https://x.com/demoaccount")).toBe(false); // a profile
    expect(isFeedUrl("https://x.com/homedepot")).toBe(false); // profile STARTING with 'home'
    expect(isFeedUrl("https://x.com/jane/status/1234567890")).toBe(false);
    expect(isFeedUrl("https://x.com/notifications")).toBe(false);
    expect(isFeedUrl("https://x.com/explore")).toBe(false);
    expect(isFeedUrl("https://x.com/")).toBe(false);
  });

  it("is falsey-safe", () => {
    expect(isFeedUrl(undefined)).toBe(false);
    expect(isFeedUrl(null)).toBe(false);
    expect(isFeedUrl("")).toBe(false);
  });
});

describe("isFeedPath", () => {
  it("matches home pathnames only", () => {
    expect(isFeedPath("/home")).toBe(true);
    expect(isFeedPath("/home/")).toBe(true);
  });
  it("rejects non-home pathnames", () => {
    expect(isFeedPath("/homedepot")).toBe(false);
    expect(isFeedPath("/jane/status/123")).toBe(false);
    expect(isFeedPath("/")).toBe(false);
    expect(isFeedPath(undefined)).toBe(false);
  });
});

describe("chooseActuatorTab", () => {
  it("keeps the pinned tab while it is still open (never hops mid-run)", () => {
    const tabs = [
      { id: 1, url: "https://x.com/demoaccount" }, // sorts first, is a profile
      { id: 2, url: "https://x.com/home" },
    ];
    expect(chooseActuatorTab(tabs, 2)).toBe(2); // pinned home tab kept
  });

  it("keeps a pinned tab even after it wandered off the feed (guard pulls it back)", () => {
    const tabs = [
      { id: 2, url: "https://x.com/jane/status/123" }, // the pinned tab, now on a permalink
      { id: 3, url: "https://x.com/home" },
    ];
    // Must NOT hop to the other home tab — the run stays on its pinned tab.
    expect(chooseActuatorTab(tabs, 2)).toBe(2);
  });

  it("re-picks when the pinned tab has closed, preferring the home tab", () => {
    const tabs = [
      { id: 5, url: "https://x.com/a-profile" },
      { id: 6, url: "https://x.com/home" },
    ];
    expect(chooseActuatorTab(tabs, 99)).toBe(6); // pinned 99 gone → prefer home, not tabs[0]
  });

  it("with no pin, prefers the home tab over a leftmost profile tab", () => {
    const tabs = [
      { id: 5, url: "https://x.com/a-profile" }, // leftmost, was the old tabs[0] bug
      { id: 6, url: "https://x.com/home" },
    ];
    expect(chooseActuatorTab(tabs)).toBe(6);
  });

  it("falls back to the first tab when none is on the feed", () => {
    const tabs = [
      { id: 5, url: "https://x.com/a" },
      { id: 6, url: "https://x.com/b" },
    ];
    expect(chooseActuatorTab(tabs)).toBe(5);
  });

  it("returns null when there are no X tabs", () => {
    expect(chooseActuatorTab([])).toBe(null);
    expect(chooseActuatorTab([{ url: "https://x.com/home" }])).toBe(null); // no id
  });
});

describe("isHomeUrl", () => {
  it("matches the home timeline in its common forms", () => {
    expect(isHomeUrl("https://x.com/home")).toBe(true);
    expect(isHomeUrl("https://x.com/")).toBe(true);
    expect(isHomeUrl("https://x.com/home?f=live")).toBe(true);
    expect(isHomeUrl("https://twitter.com/home")).toBe(true);
    expect(isHomeUrl("https://x.com/i/timeline")).toBe(true);
  });

  it("does NOT match status permalinks, profiles, or other pages", () => {
    expect(isHomeUrl("https://x.com/jackfriks/status/1801000000000000001")).toBe(false);
    expect(isHomeUrl("https://x.com/jackfriks")).toBe(false);
    expect(isHomeUrl("https://x.com/notifications")).toBe(false);
    expect(isHomeUrl("https://x.com/search?q=noelle")).toBe(false);
    expect(isHomeUrl("https://x.com/homestead")).toBe(false); // /home prefix, different page
    expect(isHomeUrl("https://example.com/home")).toBe(false); // wrong host entirely
  });

  it("is falsey-safe and garbage-safe", () => {
    expect(isHomeUrl(undefined)).toBe(false);
    expect(isHomeUrl(null)).toBe(false);
    expect(isHomeUrl("")).toBe(false);
    expect(isHomeUrl("not a url")).toBe(false);
  });
});
