import { describe, it, expect } from "vitest";
import { isActuatorDomain, hostOf, buildTabInfo, urlMatches, type TabLike } from "./ops.js";

// The pure guard + mapping logic — the load-bearing safety check (isActuatorDomain
// gates debugger.attach) and the wire mapping — tested without a real chrome.

describe("isActuatorDomain", () => {
  it("matches the actuator apex domains", () => {
    for (const url of [
      "https://x.com/home",
      "https://twitter.com/i/timeline",
      "https://linkedin.com/feed/",
      "https://www.linkedin.com/feed/",
      "https://reddit.com/r/all",
      "https://www.reddit.com/r/all",
    ]) {
      expect(isActuatorDomain(url), url).toBe(true);
    }
  });

  it("matches subdomains of actuator domains", () => {
    expect(isActuatorDomain("https://mobile.twitter.com/x")).toBe(true);
    expect(isActuatorDomain("https://pro.x.com/")).toBe(true);
    expect(isActuatorDomain("https://old.reddit.com/r/x")).toBe(true);
  });

  it("does NOT match look-alike or unrelated domains", () => {
    expect(isActuatorDomain("https://notx.com/")).toBe(false); // suffix without the dot boundary
    expect(isActuatorDomain("https://example.com/")).toBe(false);
    expect(isActuatorDomain("http://localhost:3001/")).toBe(false);
    expect(isActuatorDomain("http://127.0.0.1:18792/")).toBe(false);
    expect(isActuatorDomain("https://linkedin.com.evil.com/")).toBe(false); // not a real subdomain
  });

  it("is safe on empty / malformed / chrome urls", () => {
    expect(isActuatorDomain(undefined)).toBe(false);
    expect(isActuatorDomain(null)).toBe(false);
    expect(isActuatorDomain("")).toBe(false);
    expect(isActuatorDomain("not a url")).toBe(false);
    expect(isActuatorDomain("chrome://extensions")).toBe(false);
  });

  it("does NOT let a trailing-dot FQDN slip past the guard", () => {
    // https://x.com./home is a valid absolute URL Chrome loads as x.com.
    expect(isActuatorDomain("https://x.com./home")).toBe(true);
    expect(isActuatorDomain("https://www.linkedin.com./feed")).toBe(true);
    expect(isActuatorDomain("https://X.COM./")).toBe(true);
    expect(hostOf("https://x.com./home")).toBe("x.com");
  });
});

describe("hostOf", () => {
  it("lowercases the host", () => {
    expect(hostOf("https://X.COM/Home")).toBe("x.com");
  });
  it("returns null for junk", () => {
    expect(hostOf("")).toBeNull();
    expect(hostOf("::::")).toBeNull();
    expect(hostOf(undefined)).toBeNull();
  });
});

describe("buildTabInfo", () => {
  const tab: TabLike = {
    id: 42,
    windowId: 7,
    index: 3,
    url: "https://x.com/home",
    title: "Home / X",
    active: true,
    status: "complete",
    discarded: false,
    audible: true,
  };

  it("maps a full tab onto the wire shape", () => {
    const info = buildTabInfo(tab);
    expect(info).toMatchObject({
      id: 42,
      windowId: 7,
      index: 3,
      url: "https://x.com/home",
      title: "Home / X",
      active: true,
      status: "complete",
      discarded: false,
      audible: true,
    });
    expect(info.debuggerAttached).toBeUndefined(); // no attached set provided
  });

  it("sets debuggerAttached from the attached-tab set", () => {
    expect(buildTabInfo(tab, new Set([42])).debuggerAttached).toBe(true);
    expect(buildTabInfo(tab, new Set([1, 2, 3])).debuggerAttached).toBe(false);
    expect(buildTabInfo({ ...tab, id: undefined }, new Set([42])).debuggerAttached).toBe(false);
  });

  it("falls back to pendingUrl and safe defaults when fields are missing", () => {
    const info = buildTabInfo({ pendingUrl: "https://loading.example/" });
    expect(info.url).toBe("https://loading.example/");
    expect(info.id).toBe(-1);
    expect(info.windowId).toBe(-1);
    expect(info.title).toBe("");
    expect(info.active).toBe(false);
    expect(info.index).toBeUndefined();
    expect(info.status).toBeUndefined();
  });
});

describe("urlMatches", () => {
  it("does a substring match when there is no wildcard", () => {
    expect(urlMatches("https://x.com/home", "x.com")).toBe(true);
    expect(urlMatches("https://x.com/home", "linkedin")).toBe(false);
  });
  it("does an anchored glob match when there is a wildcard", () => {
    expect(urlMatches("https://x.com/home", "https://x.com/*")).toBe(true);
    expect(urlMatches("https://x.com/home", "*://x.com/*")).toBe(true);
    expect(urlMatches("https://linkedin.com/feed", "https://x.com/*")).toBe(false);
  });
  it("treats regex metacharacters in the literal parts as literal", () => {
    expect(urlMatches("https://x.com/a.b", "https://x.com/a.b")).toBe(true); // substring, exact
    expect(urlMatches("https://x.com/axb", "https://x.com/a.b")).toBe(false); // substring is literal: 'a.b' ∉ 'axb'
    expect(urlMatches("https://x.com/a.b", "https://x.com/a.b*")).toBe(true); // glob: '.' escaped to a literal dot
    expect(urlMatches("https://x.com/axb", "https://x.com/a.b*")).toBe(false); // glob: '.' does NOT match 'x'
  });
});
