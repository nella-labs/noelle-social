import { describe, it, expect } from "vitest";
import { tweetIdFrom, tweetDedupKey } from "../src/lib/urn.js";

describe("tweetIdFrom", () => {
  it("extracts the id from a canonical x.com permalink", () => {
    expect(tweetIdFrom("https://x.com/jackfriks/status/1801000000000000001")).toBe("1801000000000000001");
  });

  it("extracts the id from the handle-less i/status shape", () => {
    expect(tweetIdFrom("https://x.com/i/status/1801000000000000002")).toBe("1801000000000000002");
  });

  it("extracts the id from legacy twitter.com / mobile hosts", () => {
    expect(tweetIdFrom("https://twitter.com/alice/status/1801000000000000003")).toBe("1801000000000000003");
    expect(tweetIdFrom("https://mobile.twitter.com/alice/status/1801000000000000004")).toBe("1801000000000000004");
  });

  it("survives query params and trailing segments", () => {
    expect(tweetIdFrom("https://x.com/alice/status/1801000000000000005?s=20")).toBe("1801000000000000005");
    expect(tweetIdFrom("https://x.com/alice/status/1801000000000000006/photo/1")).toBe("1801000000000000006");
  });

  it("returns null when there is no status id", () => {
    expect(tweetIdFrom("https://x.com/alice")).toBeNull();
    expect(tweetIdFrom("https://x.com/home")).toBeNull();
    expect(tweetIdFrom(null)).toBeNull();
    expect(tweetIdFrom(undefined)).toBeNull();
    expect(tweetIdFrom("")).toBeNull();
  });
});

describe("tweetDedupKey", () => {
  it("collapses cosmetically different URLs for one tweet to the same key", () => {
    const a = tweetDedupKey("https://x.com/alice/status/1801000000000000007");
    const b = tweetDedupKey("https://twitter.com/alice/status/1801000000000000007?s=20");
    expect(a).toBe("1801000000000000007");
    expect(a).toBe(b);
  });

  it("falls back to the raw URL when no id is derivable", () => {
    expect(tweetDedupKey("https://x.com/alice")).toBe("https://x.com/alice");
  });

  it("is null for a null/empty url", () => {
    expect(tweetDedupKey(null)).toBeNull();
    expect(tweetDedupKey("")).toBeNull();
  });
});
