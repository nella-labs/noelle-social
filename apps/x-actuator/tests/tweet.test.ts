import { describe, it, expect } from "vitest";
import { tweetIdFromUrl } from "../src/lib/tweet.js";

describe("tweetIdFromUrl", () => {
  it("parses the status id from a tweet permalink", () => {
    expect(tweetIdFromUrl("https://x.com/jackfriks/status/1811234567890123456")).toBe("1811234567890123456");
    expect(tweetIdFromUrl("https://twitter.com/someone/status/42?s=20")).toBe("42");
  });

  it("is null for a non-status url", () => {
    expect(tweetIdFromUrl("https://x.com/home")).toBeNull();
    expect(tweetIdFromUrl("https://x.com/jackfriks")).toBeNull();
    expect(tweetIdFromUrl("")).toBeNull();
  });
});
