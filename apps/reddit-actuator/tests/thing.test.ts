import { describe, it, expect } from "vitest";
import { postIdFromUrl } from "../src/lib/thing.js";

describe("postIdFromUrl", () => {
  it("does not stamp a foreign or unrelated path as a Reddit thread", () => {
    expect(postIdFromUrl("https://example.test/comments/abc123/title/")).toBeUndefined();
    expect(postIdFromUrl("https://www.reddit.com/redirect/comments/abc123/title/")).toBeUndefined();
  });
  it("extracts the post's t3 id from a post permalink", () => {
    expect(postIdFromUrl("https://www.reddit.com/r/SaaS/comments/1abc23x/some_title/")).toBe("1abc23x");
  });

  it("extracts the POST id (not the comment id) from a comment permalink", () => {
    expect(postIdFromUrl("https://www.reddit.com/r/SaaS/comments/1abc23x/some_title/d4ef56g/")).toBe("1abc23x");
  });

  it("works on old.reddit.com and without a trailing slash", () => {
    expect(postIdFromUrl("https://old.reddit.com/r/startups/comments/zz9top")).toBe("zz9top");
  });

  it("lowercases the id (Reddit ids are base36 lowercase)", () => {
    expect(postIdFromUrl("https://www.reddit.com/r/SaaS/comments/1ABC23X/title/")).toBe("1abc23x");
  });

  it("is undefined for a url with no /comments/ segment (never throws)", () => {
    expect(postIdFromUrl("https://www.reddit.com/r/SaaS/")).toBeUndefined();
    expect(postIdFromUrl("not a url")).toBeUndefined();
  });
});
