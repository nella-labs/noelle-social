import { describe, it, expect, vi } from "vitest";
import { ApifyError, type ApifyRedditClient } from "@noelle/reddit-apify";
import {
  createRotatingApifyClient,
  AllApifyTokensExhaustedError,
  isTokenFatalError,
  type RotatingTokenCandidate,
} from "./apify-rotating.js";

/** A fake single-token client whose subredditPosts runs `behavior`. */
function fakeClient(behavior: () => Promise<unknown>): ApifyRedditClient {
  return {
    subredditPosts: vi.fn(behavior),
  } as unknown as ApifyRedditClient;
}

const quota = async (): Promise<never> => { throw new ApifyError("apify actor X -> 403: Monthly usage hard limit exceeded", 403); };
const invalid = async (): Promise<never> => { throw new ApifyError("apify actor X -> 401: user-or-token-not-found", 401); };
const cand = (credentialId: string | null, token: string, wasExhausted = false): RotatingTokenCandidate => ({
  credentialId,
  token,
  wasExhausted,
});

describe("isTokenFatalError", () => {
  it("is true for 401/402/403 ApifyError (token is the problem)", () => {
    for (const s of [401, 402, 403]) expect(isTokenFatalError(new ApifyError("x", s))).toBe(true);
  });
  it("is false for transient 429 / network / 5xx and non-ApifyError", () => {
    for (const s of [0, 429, 500, 503]) expect(isTokenFatalError(new ApifyError("x", s))).toBe(false);
    expect(isTokenFatalError(new Error("boom"))).toBe(false);
  });
});

describe("createRotatingApifyClient", () => {
  it("uses the single token when it works", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a")],
      buildClient: () => fakeClient(async () => [{ id: "1" }]),
    });
    await expect(client.subredditPosts({ subreddit: "x" })).resolves.toEqual([{ id: "1" }]);
  });

  it("rotates to the next token on a 403 usage cap", async () => {
    const a = fakeClient(quota);
    const b = fakeClient(async () => [{ id: "from-b" }]);
    const byToken: Record<string, ApifyRedditClient> = { "tok-a": a, "tok-b": b };
    const onTokenFatal = vi.fn();
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: (t) => byToken[t]!,
      onTokenFatal,
    });
    await expect(client.subredditPosts({ subreddit: "x" })).resolves.toEqual([{ id: "from-b" }]);
    expect(onTokenFatal).toHaveBeenCalledWith("a", 403, "tok-a");
  });

  it("rotates on a 401 invalid token too", async () => {
    const a = fakeClient(invalid);
    const b = fakeClient(async () => [{ id: "from-b" }]);
    const byToken: Record<string, ApifyRedditClient> = { "tok-a": a, "tok-b": b };
    const onTokenFatal = vi.fn();
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: (t) => byToken[t]!,
      onTokenFatal,
    });
    await expect(client.subredditPosts({ subreddit: "x" })).resolves.toEqual([{ id: "from-b" }]);
    expect(onTokenFatal).toHaveBeenCalledWith("a", 401, "tok-a");
  });

  it("keeps a dead token dead for the rest of the tick", async () => {
    const a = fakeClient(quota);
    const b = fakeClient(async () => [{ id: "from-b" }]);
    const byToken: Record<string, ApifyRedditClient> = { "tok-a": a, "tok-b": b };
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: (t) => byToken[t]!,
    });
    await client.subredditPosts({ subreddit: "1" });
    await client.subredditPosts({ subreddit: "2" });
    // a 403'd once and is skipped thereafter; b serves both.
    expect((a as { subredditPosts: ReturnType<typeof vi.fn> }).subredditPosts).toHaveBeenCalledTimes(1);
    expect((b as { subredditPosts: ReturnType<typeof vi.fn> }).subredditPosts).toHaveBeenCalledTimes(2);
  });

  it("throws AllApifyTokensExhaustedError when every token is spent", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: () => fakeClient(quota),
      totalCount: 2,
    });
    await expect(client.subredditPosts({ subreddit: "x" })).rejects.toBeInstanceOf(AllApifyTokensExhaustedError);
    await expect(client.subredditPosts({ subreddit: "x" })).rejects.toMatchObject({ tokenCount: 2 });
  });

  it("bubbles a transient 429 unchanged (does not rotate)", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a")],
      buildClient: () => fakeClient(async () => { throw new ApifyError("rate", 429); }),
    });
    await expect(client.subredditPosts({ subreddit: "x" })).rejects.toMatchObject({ status: 429 });
  });

  it("reports the FULL pool size in the error even when some tokens were cooling", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: () => fakeClient(quota),
      totalCount: 3,
    });
    await client.subredditPosts({ subreddit: "x" }).catch(() => {});
    await expect(client.subredditPosts({ subreddit: "x" })).rejects.toMatchObject({ tokenCount: 3 });
  });

  it("self-heals: clears a previously-exhausted token's flag on success", async () => {
    const onRecovered = vi.fn();
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a", true)],
      buildClient: () => fakeClient(async () => [{ id: "1" }]),
      onRecovered,
    });
    await client.subredditPosts({ subreddit: "x" });
    expect(onRecovered).toHaveBeenCalledWith("a");
  });
});

describe("createRotatingApifyClient — real-cost drain (drainLastRunUsd)", () => {
  /** A fake client whose subredditPosts succeeds and reports `usd` as its run cost. */
  function costClient(usd: number | null): ApifyRedditClient {
    let pending = usd;
    return {
      subredditPosts: vi.fn(async () => [{ id: "1" }]),
      drainLastRunUsd: () => {
        const v = pending;
        pending = null;
        return v;
      },
    } as unknown as ApifyRedditClient;
  }

  it("forwards the serving client's real cost, then resets on read", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a")],
      buildClient: () => costClient(0.42),
    });
    await client.subredditPosts({ subreddit: "x" });
    expect(client.drainLastRunUsd()).toBe(0.42);
    expect(client.drainLastRunUsd()).toBeNull(); // drained
  });

  it("reports the cost of the token that actually paid after a rotation", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: (t) =>
        t === "tok-a"
          ? // token a is exhausted → throws 403 → rotate
            ({
              subredditPosts: vi.fn(async () => {
                throw new ApifyError("apify actor X -> 403: cap", 403);
              }),
              drainLastRunUsd: () => 999, // must NOT be read (call threw)
            } as unknown as ApifyRedditClient)
          : costClient(0.05),
    });
    await client.subredditPosts({ subreddit: "x" });
    expect(client.currentCredentialId()).toBe("b");
    expect(client.drainLastRunUsd()).toBe(0.05); // b's cost, not a's 999
  });

  it("is null when the serving client cannot report usage", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a")],
      buildClient: () => costClient(null),
    });
    await client.subredditPosts({ subreddit: "x" });
    expect(client.drainLastRunUsd()).toBeNull();
  });
});
