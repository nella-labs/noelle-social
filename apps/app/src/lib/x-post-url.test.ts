import { describe, expect, it } from "vitest";
import { buildXPostUrl } from "./x-post-url.js";

describe("buildXPostUrl", () => {
  it("builds a status URL from a numeric tweet id and handle", () => {
    expect(buildXPostUrl({ handle: "jane", tweetId: "1234567890" })).toBe(
      "https://x.com/jane/status/1234567890",
    );
  });

  it("strips a leading @ from the handle", () => {
    expect(buildXPostUrl({ handle: "@jane", tweetId: "42" })).toBe(
      "https://x.com/jane/status/42",
    );
  });

  it("falls back to /i when the handle is missing (x.com redirects by status id)", () => {
    expect(buildXPostUrl({ handle: null, tweetId: "42" })).toBe(
      "https://x.com/i/status/42",
    );
    expect(buildXPostUrl({ tweetId: "42" })).toBe("https://x.com/i/status/42");
  });

  it("returns null for a missing tweet id", () => {
    expect(buildXPostUrl({ handle: "jane", tweetId: null })).toBeNull();
    expect(buildXPostUrl({ handle: "jane" })).toBeNull();
    expect(buildXPostUrl({ handle: "jane", tweetId: "" })).toBeNull();
  });

  it("returns null for a synthetic / non-numeric id (not a real tweet)", () => {
    expect(buildXPostUrl({ handle: "jane", tweetId: "synthetic-abc" })).toBeNull();
    expect(buildXPostUrl({ handle: "jane", tweetId: "not-a-number" })).toBeNull();
  });
});
