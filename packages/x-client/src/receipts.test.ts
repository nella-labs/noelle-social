import { describe, expect, it, vi } from "vitest";
import { createXClient, XAuthError, XChallengeError, XLockError, XRateLimitError, XWriteUncertainError, type BirdLike } from "./index.js";

function clientFor(getCurrentUser: BirdLike["getCurrentUser"]) {
  const reply = vi.fn(async () => ({ success: true as const, tweetId: "123" }));
  const client = createXClient({ ct0: "fixture", authToken: "fixture", client: {
    getCurrentUser, reply,
    getUserIdByUsername: async () => ({ success: true, userId: "1" }),
    getUserTweets: async () => ({ success: true, tweets: [] }),
    search: async () => ({ success: true, tweets: [] }),
    like: async () => ({ success: true }),
  } });
  return { client, reply };
}

describe("confirmed post receipts", () => {
  it("keeps a confirmed reply when the optional identity lookup throws", async () => {
    const { client, reply } = clientFor(async () => { throw new Error("network timeout"); });
    await expect(client.createTweet({ inReplyToId: "100", text: "Useful detail." })).resolves.toEqual({
      id: "123", url: "https://x.com/i/status/123",
    });
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "", "not-a-post-id", "0", "9".repeat(26)])("holds a successful response without a usable receipt: %s", async (tweetId) => {
    const { client, reply } = clientFor(async () => ({ success: true, user: { id: "1", username: "example" } }));
    reply.mockResolvedValue({ success: true, tweetId: tweetId as string });
    await expect(client.createTweet({ inReplyToId: "100", text: "Useful detail." })).rejects.toBeInstanceOf(XWriteUncertainError);
    expect(reply).toHaveBeenCalledTimes(1);
  });

  it("uses the canonical status URL when identity is unavailable", async () => {
    const { client } = clientFor(async () => ({ success: false, error: "503 unavailable" }));
    await expect(client.createTweet({ inReplyToId: "100", text: "Useful detail." })).resolves.toEqual({
      id: "123", url: "https://x.com/i/status/123",
    });
  });
});

describe("credential probe stop signals", () => {
  it.each([
    ["401 unauthorized", XAuthError],
    ["could not authenticate you (226) looks like it might be automated", XLockError],
    ["326 Your account is temporarily locked", XLockError],
    ["Arkose captcha challenge required", XChallengeError],
    ["429 rate limit", XRateLimitError],
  ])("preserves %s", async (error, ErrorType) => {
    const { client } = clientFor(async () => ({ success: false, error }));
    await expect(client.verifyCredentials()).rejects.toBeInstanceOf(ErrorType);
  });

  it("preserves a typed challenge thrown by the adapter", async () => {
    const challenge = new XChallengeError();
    const { client } = clientFor(async () => { throw challenge; });
    await expect(client.verifyCredentials()).rejects.toBe(challenge);
  });

  it("retains best-effort behavior for an ordinary lookup outage", async () => {
    const { client } = clientFor(async () => { throw new Error("503 unavailable"); });
    await expect(client.verifyCredentials()).resolves.toEqual({ screen_name: "unknown", id_str: "0" });
  });
});
