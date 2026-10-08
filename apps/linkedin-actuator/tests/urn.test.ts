import { describe, it, expect } from "vitest";
import { activityUrnFrom, postDedupKey } from "../src/lib/urn.js";

describe("activityUrnFrom", () => {
  it("extracts + normalizes from the urn form (feed permalink)", () => {
    expect(
      activityUrnFrom("https://www.linkedin.com/feed/update/urn:li:activity:7300000000000000000/"),
    ).toBe("urn:li:activity:7300000000000000000");
  });

  it("extracts + normalizes from the common slug share URL (the real LinkedIn shape)", () => {
    // Real LinkedIn leads store this shape, NOT urn:li:activity: — the old regex
    // returned null here, so target.activity_urn was null for every real post.
    expect(
      activityUrnFrom("https://www.linkedin.com/posts/jeshuasoh_shelterforhope-myanmar-activity-7481524546924343296-ek0Y"),
    ).toBe("urn:li:activity:7481524546924343296");
  });

  it("extracts from the /posts/activity-<id>-<code> form", () => {
    expect(
      activityUrnFrom("https://www.linkedin.com/posts/activity-7481315681691607040-IO0Y"),
    ).toBe("urn:li:activity:7481315681691607040");
  });

  it("all three URL shapes for the same post normalize to the SAME urn", () => {
    const id = "7481524546924343296";
    const a = activityUrnFrom(`https://www.linkedin.com/feed/update/urn:li:activity:${id}/`);
    const b = activityUrnFrom(`https://www.linkedin.com/posts/jane-doe_slug-activity-${id}-abcd`);
    const c = activityUrnFrom(`https://www.linkedin.com/posts/activity-${id}-IO0Y`);
    expect(a).toBe(`urn:li:activity:${id}`);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("returns null for a URL with no activity id", () => {
    expect(activityUrnFrom("https://www.linkedin.com/in/jane-doe/")).toBeNull();
  });

  it("returns null for null / undefined / empty", () => {
    expect(activityUrnFrom(null)).toBeNull();
    expect(activityUrnFrom(undefined)).toBeNull();
    expect(activityUrnFrom("")).toBeNull();
  });
});

describe("postDedupKey", () => {
  it("prefers the URN when derivable", () => {
    expect(
      postDedupKey("https://www.linkedin.com/feed/update/urn:li:activity:42/?x=1"),
    ).toBe("urn:li:activity:42");
  });

  it("two URLs for the same post (query/trailing-slash differences) collapse to one key", () => {
    const a = "https://www.linkedin.com/feed/update/urn:li:activity:42/";
    const b = "https://www.linkedin.com/feed/update/urn:li:activity:42?utm=x";
    expect(postDedupKey(a)).toBe(postDedupKey(b));
  });

  it("falls back to the raw URL when there is no URN", () => {
    expect(postDedupKey("https://www.linkedin.com/in/jane-doe/")).toBe(
      "https://www.linkedin.com/in/jane-doe/",
    );
  });

  it("returns null for empty input", () => {
    expect(postDedupKey(null)).toBeNull();
  });
});
