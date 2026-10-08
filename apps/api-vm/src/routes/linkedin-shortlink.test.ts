import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLinkedInShortUrl } from "./linkedin-shortlink.js";

const shortUrl = "https://lnkd.in/p/testToken_123";
const redirectedPost = "https://www.linkedin.com/posts/ada_topic-ugcPost-7506038810200215553-abc";
const activityId = "7506038962675675138";

function htmlResponse(html: string) {
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

describe("LinkedIn copied short-link resolution", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses the activity URL in metadata, never the differing ugcPost redirect ID", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: redirectedPost } }))
      .mockResolvedValueOnce(htmlResponse(`<meta content="https://www.linkedin.com/feed/update/urn:li:activity:${activityId}" property="lnkd:url">`));
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolveLinkedInShortUrl(shortUrl)).toEqual({
      externalId: activityId,
      urn: `urn:li:activity:${activityId}`,
      url: `https://www.linkedin.com/feed/update/urn:li:activity:${activityId}/`,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(1, shortUrl, expect.objectContaining({ method: "HEAD", redirect: "manual", signal: expect.any(AbortSignal) }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, redirectedPost, expect.objectContaining({ method: "GET", redirect: "error", signal: expect.any(AbortSignal) }));
  });

  it("accepts a LinkedIn post redirect with a trailing slash and drops its query", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: {
        location: `${redirectedPost}/?utm_source=share&utm_medium=member_desktop`,
      } }))
      .mockResolvedValueOnce(htmlResponse(`<meta property="lnkd:url" content="https://www.linkedin.com/feed/update/urn:li:activity:${activityId}">`));
    vi.stubGlobal("fetch", fetchMock);

    expect((await resolveLinkedInShortUrl(shortUrl))?.urn).toBe(`urn:li:activity:${activityId}`);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${redirectedPost}/`, expect.objectContaining({
      method: "GET", redirect: "error",
    }));
  });

  it.each([
    "https://lnkd.in.evil.test/p/token",
    "http://lnkd.in/p/token",
    "https://lnkd.in:444/p/token",
    "https://lnkd.in/p/token?next=https://evil.test",
    "https://lnkd.in/other/token",
    "https://lnkd.in/p/%2f%2fevil.test",
  ])("rejects unsafe copied URL %s before network access", async (input) => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect(await resolveLinkedInShortUrl(input)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.test/posts/ada-activity-7506038962675675138",
    "http://www.linkedin.com/posts/ada-activity-7506038962675675138",
    "https://www.linkedin.com.evil.test/posts/ada-activity-7506038962675675138",
    "https://www.linkedin.com/checkpoint/challenge",
  ])("rejects an unsafe redirect destination %s without fetching it", async (location) => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveLinkedInShortUrl(shortUrl)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the LinkedIn HTML lacks a valid activity metadata URL", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: redirectedPost } }))
      .mockResolvedValueOnce(htmlResponse('<meta property="lnkd:url" content="https://evil.test/activity-7506038962675675138">'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveLinkedInShortUrl(shortUrl)).rejects.toThrow();
  });

  it("rejects oversized HTML without deriving an activity from its redirect path", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: redirectedPost } }))
      .mockResolvedValueOnce(htmlResponse("x".repeat(256_001)));
    vi.stubGlobal("fetch", fetchMock);
    await expect(resolveLinkedInShortUrl(shortUrl)).rejects.toThrow();
  });
});
