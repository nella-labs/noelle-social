import { describe, it, expect } from "vitest";
import { buildXReplyUrl } from "./x-reply-url";

describe("buildXReplyUrl", () => {
  it("builds a threaded reply prefilled with text", () => {
    expect(buildXReplyUrl("123", "hey there")).toBe(
      "https://x.com/intent/tweet?in_reply_to=123&text=hey%20there",
    );
  });

  it("omits in_reply_to when no postId (plain compose)", () => {
    expect(buildXReplyUrl(null, "hi")).toBe("https://x.com/intent/tweet?text=hi");
  });

  it("omits text when only a postId is given (reply composer)", () => {
    expect(buildXReplyUrl("123")).toBe("https://x.com/intent/tweet?in_reply_to=123");
  });

  it("returns the bare intent URL when nothing is provided", () => {
    expect(buildXReplyUrl()).toBe("https://x.com/intent/tweet");
  });

  it("encodes special characters in both params", () => {
    expect(buildXReplyUrl("a/b", "x & y?")).toBe(
      "https://x.com/intent/tweet?in_reply_to=a%2Fb&text=x%20%26%20y%3F",
    );
  });

  it("matches the SpeedrunRow inline format exactly (both params)", () => {
    const postId = "1790000000000000000";
    const text = "Coordinated three agents last week — happy to share.";
    const expected = `https://x.com/intent/tweet?in_reply_to=${encodeURIComponent(postId)}&text=${encodeURIComponent(text)}`;
    expect(buildXReplyUrl(postId, text)).toBe(expected);
  });
});
