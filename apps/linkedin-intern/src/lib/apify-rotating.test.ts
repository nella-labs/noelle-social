import { describe, it, expect, vi } from "vitest";
import { ApifyError, type ApifyLinkedInClient } from "@noelle/linkedin-apify";
import {
  createRotatingApifyClient,
  AllApifyTokensExhaustedError,
  isTokenFatalError,
  type RotatingTokenCandidate,
} from "./apify-rotating.js";

/** A fake single-token client whose every method runs `behavior`. */
function fakeClient(behavior: () => Promise<unknown>): ApifyLinkedInClient {
  return {
    profilePosts: vi.fn(behavior),
    searchPosts: vi.fn(behavior),
    postComments: vi.fn(behavior),
  } as unknown as ApifyLinkedInClient;
}

const quota = () => new ApifyError("apify actor X -> 403: Monthly usage hard limit exceeded", 403);
const invalid = () => new ApifyError("apify actor X -> 401: user-or-token-not-found", 401);
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
    await expect(client.profilePosts({ publicId: "x" })).resolves.toEqual([{ id: "1" }]);
    expect(client.currentCredentialId()).toBe("a");
  });

  it("rotates to the next token on a 403 and reports the dead one as fatal w/ status 403", async () => {
    const onTokenFatal = vi.fn();
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: (t) =>
        t === "tok-a"
          ? fakeClient(async () => {
              throw quota();
            })
          : fakeClient(async () => [{ id: "from-b" }]),
      onTokenFatal,
    });
    await expect(client.profilePosts({ publicId: "x" })).resolves.toEqual([{ id: "from-b" }]);
    expect(onTokenFatal).toHaveBeenCalledWith("a", 403, "tok-a");
    expect(onTokenFatal).not.toHaveBeenCalledWith("b", expect.anything());
    expect(client.currentCredentialId()).toBe("b");
  });

  it("reports a 401 with status 401 (so the caller marks it invalid, not exhausted)", async () => {
    const onTokenFatal = vi.fn();
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: (t) =>
        t === "tok-a"
          ? fakeClient(async () => {
              throw invalid();
            })
          : fakeClient(async () => [{ id: "from-b" }]),
      onTokenFatal,
    });
    await expect(client.profilePosts({ publicId: "x" })).resolves.toEqual([{ id: "from-b" }]);
    expect(onTokenFatal).toHaveBeenCalledWith("a", 401, "tok-a");
  });

  it("does not retry a token already exhausted earlier in the same tick", async () => {
    const buildA = vi.fn(async () => {
      throw quota();
    });
    const a = fakeClient(buildA);
    const b = fakeClient(async () => [{ id: "b" }]);
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: (t) => (t === "tok-a" ? a : b),
    });
    await client.profilePosts({ publicId: "1" });
    await client.profilePosts({ publicId: "2" });
    // A was tried once (first call), then skipped on the second call.
    expect(a.profilePosts).toHaveBeenCalledTimes(1);
    expect(b.profilePosts).toHaveBeenCalledTimes(2);
  });

  it("throws AllApifyTokensExhaustedError when every token is spent", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: () =>
        fakeClient(async () => {
          throw quota();
        }),
    });
    await expect(client.searchPosts({ queries: ["x"] })).rejects.toBeInstanceOf(AllApifyTokensExhaustedError);
    await expect(client.searchPosts({ queries: ["x"] })).rejects.toMatchObject({ tokenCount: 2 });
  });

  it("bubbles transient (429) errors unchanged — does NOT rotate or mark fatal", async () => {
    const onTokenFatal = vi.fn();
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a"), cand("b", "tok-b")],
      buildClient: () =>
        fakeClient(async () => {
          throw new ApifyError("too many runs", 429);
        }),
      onTokenFatal,
    });
    await expect(client.profilePosts({ publicId: "x" })).rejects.toMatchObject({ status: 429 });
    expect(onTokenFatal).not.toHaveBeenCalled();
  });

  it("clears the exhausted flag when a previously-exhausted token works again", async () => {
    const onRecovered = vi.fn();
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a", true)],
      buildClient: () => fakeClient(async () => [{ id: "ok" }]),
      onRecovered,
    });
    await client.profilePosts({ publicId: "x" });
    expect(onRecovered).toHaveBeenCalledWith("a");
  });

  it("throws all-exhausted immediately when no tokens are available (reports totalCount, builds nothing)", async () => {
    const buildClient = vi.fn();
    const client = createRotatingApifyClient({ candidates: [], totalCount: 3, buildClient });
    await expect(client.profilePosts({ publicId: "x" })).rejects.toBeInstanceOf(AllApifyTokensExhaustedError);
    await expect(client.searchPosts({ queries: ["x"] })).rejects.toMatchObject({ tokenCount: 3 });
    expect(buildClient).not.toHaveBeenCalled(); // no client built → no Apify call wasted
  });
});

describe("createRotatingApifyClient — real-cost drain (drainLastRunUsd)", () => {
  /** A fake client whose profilePosts succeeds and reports `usd` as its run cost. */
  function costClient(usd: number | null): ApifyLinkedInClient {
    let pending = usd;
    return {
      profilePosts: vi.fn(async () => [{ id: "1" }]),
      searchPosts: vi.fn(async () => [{ id: "1" }]),
      postComments: vi.fn(async () => [{ id: "1" }]),
      drainLastRunUsd: () => {
        const v = pending;
        pending = null;
        return v;
      },
    } as unknown as ApifyLinkedInClient;
  }

  it("forwards the serving client's real cost, then resets on read", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a")],
      buildClient: () => costClient(0.42),
    });
    await client.profilePosts({ publicId: "x" });
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
              profilePosts: vi.fn(async () => {
                throw new ApifyError("apify actor X -> 403: cap", 403);
              }),
              drainLastRunUsd: () => 999, // must NOT be read (call threw)
            } as unknown as ApifyLinkedInClient)
          : costClient(0.05),
    });
    await client.profilePosts({ publicId: "x" });
    expect(client.currentCredentialId()).toBe("b");
    expect(client.drainLastRunUsd()).toBe(0.05); // b's cost, not a's 999
  });

  it("is null when the serving client cannot report usage", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("a", "tok-a")],
      buildClient: () => costClient(null),
    });
    await client.profilePosts({ publicId: "x" });
    expect(client.drainLastRunUsd()).toBeNull();
  });
});
