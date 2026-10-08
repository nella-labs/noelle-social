import { describe, expect, it } from "vitest";
import { containsExternalLink, stripExternalLinksForPost } from "./linkPolicy";

describe("containsExternalLink", () => {
  it("is false for plain prose with no links", () => {
    expect(containsExternalLink("distribution is the work, not the reward")).toBe(false);
  });

  it("flags an explicit https URL", () => {
    expect(containsExternalLink("read this https://example.com/post now")).toBe(true);
  });

  it("flags a www-prefixed domain", () => {
    expect(containsExternalLink("see www.example.com")).toBe(true);
  });

  it("flags a bare domain (no scheme)", () => {
    expect(containsExternalLink("grab it at example.com")).toBe(true);
  });

  it("flags a bare domain with a path + query", () => {
    expect(containsExternalLink("here: launchlist.io/signup?ref=x")).toBe(true);
  });

  it("does NOT flag self/on-platform links (x.com, twitter.com, t.co)", () => {
    expect(containsExternalLink("more on x.com soon")).toBe(false);
    expect(containsExternalLink("thread on twitter.com later")).toBe(false);
    expect(containsExternalLink("t.co/abc123")).toBe(false);
    expect(containsExternalLink("https://x.com/rcmisk/status/1789")).toBe(false);
    expect(containsExternalLink("https://mobile.twitter.com/x")).toBe(false);
  });

  it("flags obfuscated domains (bracket/paren dot)", () => {
    expect(containsExternalLink("dm me at example[.]com")).toBe(true);
    expect(containsExternalLink("site: example(dot)com")).toBe(true);
  });

  it("does NOT false-positive on dotted non-domains", () => {
    expect(containsExternalLink("I ship with Next.js daily")).toBe(false);
    expect(containsExternalLink("node.js is fine")).toBe(false);
    expect(containsExternalLink("pi is 3.14 roughly")).toBe(false);
    expect(containsExternalLink("the U.S. market")).toBe(false);
    expect(containsExternalLink("wait... really")).toBe(false);
  });
});

describe("stripExternalLinksForPost", () => {
  it("removes an external URL and tidies the whitespace", () => {
    expect(stripExternalLinksForPost("check example.com now")).toBe("check now");
  });

  it("removes an https URL mid-sentence", () => {
    expect(stripExternalLinksForPost("read https://example.com/x for more")).toBe("read for more");
  });

  it("leaves plain text and self-links untouched", () => {
    expect(stripExternalLinksForPost("the work is the reward")).toBe("the work is the reward");
    expect(stripExternalLinksForPost("more on x.com soon")).toBe("more on x.com soon");
  });

  it("is idempotent", () => {
    const once = stripExternalLinksForPost("grab it at example.com/signup today");
    expect(stripExternalLinksForPost(once)).toBe(once);
  });
});
