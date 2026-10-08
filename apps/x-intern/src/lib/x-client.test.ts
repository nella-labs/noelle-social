import { describe, expect, it, vi } from "vitest";
import {
  createXClient,
  XAuthError,
  XLockError,
  XChallengeError,
  type BirdLike,
} from "./x-client.js";

function stubBird(overrides: Partial<BirdLike> = {}): BirdLike {
  return {
    getCurrentUser: vi.fn(async () => ({ success: true, user: { id: "1", username: "example_operator", name: "Ari" } })),
    getUserIdByUsername: vi.fn(async () => ({ success: true, userId: "33521530" })),
    getUserTweets: vi.fn(async () => ({ success: true as const, tweets: [] })),
    search: vi.fn(async () => ({ success: true as const, tweets: [] })),
    reply: vi.fn(async () => ({ success: true as const, tweetId: "tw-1" })),
    like: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

describe("XClient over @steipete/bird", () => {
  it("verifyCredentials returns the current user identity", async () => {
    const client = createXClient({
      ct0: "x",
      authToken: "y",
      client: stubBird(),
    });
    const me = await client.verifyCredentials();
    expect(me.screen_name).toBe("example_operator");
    expect(me.id_str).toBe("1");
  });

  it("userTweets resolves handle → id → tweets and maps to XTweet shape", async () => {
    const client = createXClient({
      ct0: "x",
      authToken: "y",
      client: stubBird({
        getUserTweets: vi.fn(async () => ({
          success: true as const,
          tweets: [
            {
              id: "100",
              text: "hello world",
              author: { username: "swyx", name: "swyx" },
              authorId: "33521530",
              createdAt: "2026-05-26T00:00:00Z",
            },
          ],
        })),
      }),
    });
    const out = await client.userTweets({ handle: "swyx", limit: 10 });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "100",
      text: "hello world",
      author: { handle: "swyx", id: "33521530" },
      url: "https://x.com/swyx/status/100",
    });
  });

  it("extracts follower count from the raw GraphQL user_results legacy block", async () => {
    const getUserTweets = vi.fn(async () => ({
      success: true as const,
      tweets: [
        {
          id: "100",
          text: "hello",
          author: { username: "swyx", name: "swyx" },
          authorId: "1",
          createdAt: "2026-06-01T00:00:00Z",
          // X's real payload nests followers_count here; Bird just doesn't type it.
          _raw: { core: { user_results: { result: { legacy: { followers_count: 4321 } } } } },
        } as never,
      ],
    }));
    const client = createXClient({ ct0: "x", authToken: "y", client: stubBird({ getUserTweets }) });
    const out = await client.userTweets({ handle: "swyx" });
    expect(out[0]?.author.followers).toBe(4321);
    // Must request includeRaw, else Bird never attaches _raw and followers is always null.
    expect(getUserTweets).toHaveBeenCalledWith("33521530", 40, { includeRaw: true });
  });

  it("requests includeRaw on searchTimeline too", async () => {
    const search = vi.fn(async () => ({ success: true as const, tweets: [] }));
    const client = createXClient({ ct0: "x", authToken: "y", client: stubBird({ search }) });
    await client.searchTimeline({ query: "ai agents" });
    expect(search).toHaveBeenCalledWith("ai agents", 40, { includeRaw: true });
  });

  it("returns null followers (not 0) when the raw payload omits the count", async () => {
    const client = createXClient({
      ct0: "x",
      authToken: "y",
      client: stubBird({
        getUserTweets: vi.fn(async () => ({
          success: true as const,
          tweets: [
            { id: "100", text: "hello", author: { username: "swyx", name: "swyx" }, authorId: "1", createdAt: "2026-06-01T00:00:00Z" },
          ],
        })),
      }),
    });
    const out = await client.userTweets({ handle: "swyx" });
    expect(out[0]?.author.followers).toBeNull();
  });

  it("propagates 401 from Bird as XAuthError", async () => {
    const client = createXClient({
      ct0: "x",
      authToken: "y",
      client: stubBird({
        getUserIdByUsername: vi.fn(async () => ({ success: false, error: "401 unauthorized" })),
      }),
    });
    await expect(client.userTweets({ handle: "swyx" })).rejects.toBeInstanceOf(XAuthError);
  });

  it("createTweet replies and returns canonical x.com URL", async () => {
    const client = createXClient({
      ct0: "x",
      authToken: "y",
      client: stubBird({
        reply: vi.fn(async () => ({ success: true as const, tweetId: "999" })),
      }),
    });
    const res = await client.createTweet({ inReplyToId: "500", text: "thx for the writeup" });
    expect(res.id).toBe("999");
    expect(res.url).toBe("https://x.com/example_operator/status/999");
  });

  it("classifies account-lock / automation-flag errors as XLockError (not auth)", async () => {
    for (const e of [
      "could not authenticate you (226) this request looks like it might be automated",
      "326 Your account is temporarily locked",
      "Forbidden: account has been temporarily limited",
      "redirected to /account/access",
      "403 requires a matching csrf cookie and header",
    ]) {
      const client = createXClient({
        ct0: "x", authToken: "y",
        client: stubBird({ reply: vi.fn(async () => ({ success: false as const, error: e })) }),
      });
      await expect(
        client.createTweet({ inReplyToId: "1", text: "hi" }),
      ).rejects.toBeInstanceOf(XLockError);
    }
  });

  it("classifies CAPTCHA/Arkose challenges as XChallengeError", async () => {
    const client = createXClient({
      ct0: "x", authToken: "y",
      client: stubBird({ reply: vi.fn(async () => ({ success: false as const, error: "arkose challenge / captcha required" })) }),
    });
    await expect(
      client.createTweet({ inReplyToId: "1", text: "hi" }),
    ).rejects.toBeInstanceOf(XChallengeError);
  });

  it("a plain code-32 csrf/auth error stays XAuthError (not a lock)", async () => {
    const client = createXClient({
      ct0: "x", authToken: "y",
      client: stubBird({ reply: vi.fn(async () => ({ success: false as const, error: "Could not authenticate you (32)" })) }),
    });
    await expect(
      client.createTweet({ inReplyToId: "1", text: "hi" }),
    ).rejects.toBeInstanceOf(XAuthError);
  });
});
