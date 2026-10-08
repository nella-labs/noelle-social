import { describe, it, expect } from "vitest";
import { postIdFrom, postDedupKey } from "../src/lib/urn.js";

describe("postIdFrom", () => {
  it.each([
    "https://example.test/comments/abc123/title/",
    "https://www.reddit.com/redirect/comments/abc123/title/",
    "https://example.test/?target=t3_abc123",
  ])("does not derive a thread from an unrelated target %s", url => {
    expect(postIdFrom(url)).toBeNull();
  });
  it("extracts the t3 id from a post comments-page permalink", () => {
    expect(postIdFrom("https://www.reddit.com/r/SaaS/comments/abc123/some_title/")).toBe("abc123");
  });

  it("a COMMENT permalink resolves to the PARENT POST's id (per-thread key)", () => {
    // The comment id (def456) is a path segment AFTER the post id — the first
    // /comments/<id> capture is the thread, which is exactly the dedup grain.
    expect(postIdFrom("https://www.reddit.com/r/SaaS/comments/abc123/some_title/def456/")).toBe("abc123");
  });

  it("old.reddit.com permalinks parse identically", () => {
    expect(postIdFrom("https://old.reddit.com/r/webdev/comments/1kx9z2/title/")).toBe("1kx9z2");
  });

  it("extracts from the redd.it short-link form", () => {
    expect(postIdFrom("https://redd.it/abc123")).toBe("abc123");
  });

  it("extracts from a raw t3_ fullname embedded in a string", () => {
    expect(postIdFrom("t3_abc123")).toBe("abc123");
  });

  it("all URL shapes for the same thread normalize to the SAME id", () => {
    const a = postIdFrom("https://www.reddit.com/r/SaaS/comments/1kx9z2/launch/");
    const b = postIdFrom("https://www.reddit.com/r/SaaS/comments/1kx9z2/launch/mtop1/");
    const c = postIdFrom("https://redd.it/1kx9z2");
    expect(a).toBe("1kx9z2");
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("lowercases the id so cosmetic case differences collapse", () => {
    expect(postIdFrom("https://www.reddit.com/r/SaaS/comments/ABC123/x/")).toBe("abc123");
  });

  it("returns null for a URL with no post id", () => {
    expect(postIdFrom("https://www.reddit.com/r/SaaS/")).toBeNull();
  });

  it("returns null for null / undefined / empty", () => {
    expect(postIdFrom(null)).toBeNull();
    expect(postIdFrom(undefined)).toBeNull();
    expect(postIdFrom("")).toBeNull();
  });
});

describe("postDedupKey", () => {
  it("prefers the namespaced fullname when the id is derivable", () => {
    expect(postDedupKey("https://www.reddit.com/r/SaaS/comments/abc123/x/")).toBe("t3_abc123");
  });

  it("a post-target and a comment-target permalink for ONE thread share a key", () => {
    const post = postDedupKey("https://www.reddit.com/r/SaaS/comments/abc123/x/");
    const comment = postDedupKey("https://www.reddit.com/r/SaaS/comments/abc123/x/def456/");
    expect(post).toBe("t3_abc123");
    expect(post).toBe(comment);
  });

  it("falls back to the raw URL when no id is derivable", () => {
    expect(postDedupKey("https://www.reddit.com/r/SaaS/")).toBe("https://www.reddit.com/r/SaaS/");
  });

  it("returns null for null / undefined / empty", () => {
    expect(postDedupKey(null)).toBeNull();
    expect(postDedupKey(undefined)).toBeNull();
    expect(postDedupKey("")).toBeNull();
  });
});
