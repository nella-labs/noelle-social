import { describe, it, expect, vi } from "vitest";
import { ApifyError } from "@noelle/video-apify";
import { createRotatingApifyClient, isRetryableActorFailure } from "./apify-rotating.js";

// A single-token client whose hashtagReels is scripted per token value.
function clientFactory(byToken: Record<string, () => Promise<unknown>>) {
  return (token: string) =>
    ({
      hashtagReels: () => byToken[token]!(),
      creatorReels: async () => [],
      accountSnapshot: async () => null,
    }) as any;
}
const cand = (id: string, token: string) => ({ credentialId: id, token, wasExhausted: false });

describe("isRetryableActorFailure", () => {
  it("is true for a 400 actor-run FAILED, false for token/other errors", () => {
    expect(isRetryableActorFailure(new ApifyError("apify actor x -> 400: {run-failed status: FAILED}", 400))).toBe(true);
    expect(isRetryableActorFailure(new ApifyError("bad request: missing field", 400))).toBe(false);
    expect(isRetryableActorFailure(new ApifyError("cap", 403))).toBe(false);
    expect(isRetryableActorFailure(new Error("nope"))).toBe(false);
  });

  it("is true for the async-flow 502 not-SUCCEEDED run (FAILED/ABORTED/TIMED-OUT)", () => {
    // runActorSync now surfaces a failed run as a 502 "run <STATUS> (not SUCCEEDED)".
    expect(isRetryableActorFailure(new ApifyError("apify actor x run FAILED (not SUCCEEDED)", 502))).toBe(true);
    expect(isRetryableActorFailure(new ApifyError("apify actor x run ABORTED (not SUCCEEDED)", 502))).toBe(true);
    expect(isRetryableActorFailure(new ApifyError("apify actor x run TIMED-OUT (not SUCCEEDED)", 502))).toBe(true);
  });

  it("is false for a 504 deadline overrun (retrying a slow run rarely helps)", () => {
    expect(isRetryableActorFailure(new ApifyError("apify actor x run unknown (not SUCCEEDED)", 504))).toBe(false);
  });

  it.each(["READY", "RUNNING", "UNKNOWN", "TIMING-OUT", "ABORTING"])("does not classify nonterminal %s as a completed failure", state => {
    expect(isRetryableActorFailure(new ApifyError(`apify actor x run ${state} (not SUCCEEDED)`, 502))).toBe(false);
  });
});

describe("createRotatingApifyClient — actor-run failure", () => {
  it.each(["READY", "RUNNING", "UNKNOWN", "TIMING-OUT", "ABORTING"])("does not redispatch a nonterminal %s run on another token", async state => {
    let attempts = 0;
    const client = createRotatingApifyClient({
      candidates: [cand("first", "t1"), cand("second", "t2")],
      buildClient: () => ({
        hashtagReels: async () => { attempts++; throw new ApifyError(`apify actor x run ${state} (not SUCCEEDED)`, 502); },
        drainRunReceipts: () => [{ runId: "pending", actor: "instagram-scraper", actualUsd: null,
          status: state, terminal: false, resultCount: 0, resultCountComplete: false, fetchedResultCount: 0 }],
      }) as never,
    });
    await expect(client.hashtagReels({ platform: "instagram", query: "builders" })).rejects.toMatchObject({ status: 502 });
    expect(attempts).toBe(1);
    expect(client.drainRunReceipts?.()).toEqual([expect.objectContaining({ status: state, credentialId: "first" })]);
  });

  it.each([0, 502, 504])("retains a received charge without replaying ambiguous status %s", async status => {
    let attempts = 0;
    const client = createRotatingApifyClient({
      candidates: [cand("first", "t1"), cand("second", "t2")],
      buildClient: () => ({
        hashtagReels: async () => { attempts++; throw new ApifyError("ambiguous upstream dispatch", status); },
        drainRunReceipts: () => [{ runId: "received", actor: "instagram-scraper", actualUsd: 0.2,
          status: "FAILED", terminal: true, resultCount: 0, resultCountComplete: false, fetchedResultCount: 0 }],
      }) as never,
    });
    await expect(client.hashtagReels({ platform: "instagram", query: "builders" })).rejects.toMatchObject({ status });
    expect(attempts).toBe(1);
    expect(client.drainRunReceipts?.()).toEqual([expect.objectContaining({ actualUsd: 0.2, credentialId: "first" })]);
  });

  it("retries a failed actor run on the NEXT token without marking the first dead", async () => {
    const onTokenFatal = vi.fn();
    const buildClient = clientFactory({
      t1: () => Promise.reject(new ApifyError("actor -> 400: run did not succeed, status: FAILED", 400)),
      t2: () => Promise.resolve([{ id: "ok" }]),
    });
    const client = createRotatingApifyClient({
      candidates: [cand("c1", "t1"), cand("c2", "t2")],
      buildClient,
      onTokenFatal,
    });
    const out = await client.hashtagReels({ platform: "instagram", query: "x" } as any);
    expect(out).toEqual([{ id: "ok" }]);
    // The actor failed, not the token — t1 must NOT be flagged exhausted.
    expect(onTokenFatal).not.toHaveBeenCalled();
    expect(client.currentCredentialId()).toBe("c2");
  });

  it("still marks a token dead + rotates on a real token-fatal 403", async () => {
    const onTokenFatal = vi.fn();
    const buildClient = clientFactory({
      t1: () => Promise.reject(new ApifyError("cap reached", 403)),
      t2: () => Promise.resolve([{ id: "ok" }]),
    });
    const client = createRotatingApifyClient({
      candidates: [cand("c1", "t1"), cand("c2", "t2")],
      buildClient,
      onTokenFatal,
    });
    await client.hashtagReels({ platform: "instagram", query: "x" } as any);
    expect(onTokenFatal).toHaveBeenCalledWith("c1", 403, "t1");
  });
});

describe("createRotatingApifyClient — real cost forwarding (drainLastRunUsd)", () => {
  const baseClient = (over: Record<string, unknown>) =>
    ({
      hashtagReels: async () => [{ id: "ok" }],
      creatorReels: async () => [],
      accountSnapshot: async () => null,
      ...over,
    }) as any;

  it("forwards the base client's drained run cost, then resets on read", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("c1", "t1")],
      buildClient: () => baseClient({ drainLastRunUsd: () => 0.42 }),
    });
    await client.hashtagReels({ platform: "instagram", query: "x" } as any);
    expect(client.drainLastRunUsd()).toBe(0.42);
    // Reset after read; a second read with no new call is null → estimate fallback.
    expect(client.drainLastRunUsd()).toBeNull();
  });

  it("is null when the base client can't report usage (drain returns null)", async () => {
    const client = createRotatingApifyClient({
      candidates: [cand("c1", "t1")],
      buildClient: () => baseClient({ drainLastRunUsd: () => null }),
    });
    await client.hashtagReels({ platform: "instagram", query: "x" } as any);
    expect(client.drainLastRunUsd()).toBeNull();
  });

  it("discards a failed call's accumulated cost so it can't leak to the next call", async () => {
    // The base client accumulates run cost across a multi-run operation and only
    // resets on drain, so a call that throws mid-operation would otherwise leave a
    // stale figure behind. The rotator must drain-and-discard it at the boundary.
    let drainCount = 0;
    const flaky = baseClient({
      hashtagReels: vi
        .fn()
        .mockRejectedValueOnce(new ApifyError("boom", 500)) // non-retryable → bubbles, token reusable
        .mockResolvedValueOnce([{ id: "ok" }]),
      drainLastRunUsd: vi.fn(() => (++drainCount === 1 ? 0.99 : 0.05)),
    });
    const client = createRotatingApifyClient({ candidates: [cand("c1", "t1")], buildClient: () => flaky });

    await expect(client.hashtagReels({ platform: "instagram", query: "x" } as any)).rejects.toBeInstanceOf(ApifyError);
    // The failed op's $0.99 was drained + discarded, never surfaced.
    expect(client.drainLastRunUsd()).toBeNull();

    const out = await client.hashtagReels({ platform: "instagram", query: "x" } as any);
    expect(out).toEqual([{ id: "ok" }]);
    expect(client.drainLastRunUsd()).toBe(0.05); // fresh cost only
  });
});
