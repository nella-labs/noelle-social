import { describe, it, expect } from "vitest";
import type { Bus } from "@noelle/runtime";
import { runOwnAccountTick } from "./own-account-tick.js";
import { OWN_ACCOUNT_BUCKET, OWN_ACCOUNT_KEY_X, parseOwnAccountSnapshot } from "../lib/own-account.js";

const NOW = new Date("2026-07-26T18:00:00.000Z");

/** A bus that records puts and serves a seeded value from get(). */
function fakeBus(seed?: unknown): {
  bus: Bus;
  puts: Array<{ bucket: string; key: string; value: unknown }>;
} {
  const puts: Array<{ bucket: string; key: string; value: unknown }> = [];
  let current = seed;
  const bus = {
    agentRole: "x_intern",
    agentInstanceId: "inst-1",
    async emit() {},
    async put(bucket: string, key: string, value: unknown) {
      puts.push({ bucket, key, value });
      current = value;
    },
    // Mirrors the real Bus: get() returns the stored VALUE, not a row wrapper.
    async get() {
      return current === undefined ? null : current;
    },
    async list() {
      return [];
    },
    async tail() {
      return [];
    },
  } as unknown as Bus;
  return { bus, puts };
}

const OK_ACCOUNT = {
  id: "2007194879781474305",
  handle: "example_operator",
  displayName: "Ari",
  followers: 103,
  following: 210,
  posts: 412,
};

describe("runOwnAccountTick", () => {
  it("writes the X API snapshot to the bus under the own_account bucket", async () => {
    const { bus, puts } = fakeBus();
    const res = await runOwnAccountTick({
      bus,
      api: { async getMyAccount() { return OK_ACCOUNT; } },
      apify: null,
      fallbackHandle: null,
      now: NOW,
    });

    expect(res.outcome).toBe("x_api");
    expect(res.snapshot?.followers).toBe(103);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.bucket).toBe(OWN_ACCOUNT_BUCKET);
    expect(puts[0]?.key).toBe(OWN_ACCOUNT_KEY_X);
    const written = parseOwnAccountSnapshot(puts[0]?.value);
    expect(written?.handle).toBe("example_operator");
    expect(written?.capturedAt).toBe(NOW.toISOString());
    expect(written?.source).toBe("x_api");
  });

  it("does NOT need a recently published post — the bug that froze the old sweep", async () => {
    // The old x-self-track path could only read a follower count off a post
    // published in the last 30 days. This path takes no posts at all.
    const { bus, puts } = fakeBus();
    const res = await runOwnAccountTick({
      bus,
      api: { async getMyAccount() { return OK_ACCOUNT; } },
      apify: () => {
        throw new Error("apify must not be resolved when the API works");
      },
      fallbackHandle: null,
      now: NOW,
    });
    expect(res.outcome).toBe("x_api");
    expect(puts).toHaveLength(1);
  });

  it("falls back to Apify when the X API read fails", async () => {
    const { bus, puts } = fakeBus();
    const res = await runOwnAccountTick({
      bus,
      api: {
        async getMyAccount(): Promise<never> {
          throw new Error("401 unauthorized");
        },
      },
      apify: async () => ({
        async userTweets({ handle }) {
          expect(handle).toBe("example_operator");
          return { tweets: [{ id: "1", author: { followers: 99 } }] as never };
        },
      }),
      fallbackHandle: "@example_operator",
      now: NOW,
    });
    expect(res.outcome).toBe("apify");
    expect(res.snapshot?.followers).toBe(99);
    expect(res.snapshot?.source).toBe("apify");
    expect(puts).toHaveLength(1);
  });

  it("recovers the handle from the last snapshot when no connected account remains", async () => {
    const seeded = {
      handle: "example_operator",
      followers: 68,
      following: null,
      posts: null,
      capturedAt: "2026-07-11T16:02:53.773Z",
      source: "apify",
    };
    const { bus } = fakeBus(seeded);
    let asked = "";
    const res = await runOwnAccountTick({
      bus,
      api: null,
      apify: async () => ({
        async userTweets({ handle }) {
          asked = handle;
          return { tweets: [{ id: "1", author: { followers: 103 } }] as never };
        },
      }),
      fallbackHandle: null,
      now: NOW,
    });
    expect(asked).toBe("example_operator");
    expect(res.snapshot?.followers).toBe(103);
  });

  it("leaves the old snapshot alone when BOTH paths fail — never writes a zero", async () => {
    // This is the live failure: X API absent and every Apify token exhausted.
    // A written 0 would become "0 followers" in a reply, which is worse than stale.
    const { bus, puts } = fakeBus();
    const res = await runOwnAccountTick({
      bus,
      api: null,
      apify: async () => ({
        async userTweets(): Promise<never> {
          throw new Error("no usable Apify token — all 52 are exhausted or invalid");
        },
      }),
      fallbackHandle: "example_operator",
      now: NOW,
    });
    expect(res.outcome).toBe("failed");
    expect(res.snapshot).toBeNull();
    expect(puts).toHaveLength(0);
  });

  it("treats an empty Apify pull as unknown, not as zero followers", async () => {
    const { bus, puts } = fakeBus();
    const res = await runOwnAccountTick({
      bus,
      api: null,
      apify: async () => ({ async userTweets() { return { tweets: [] }; } }),
      fallbackHandle: "example_operator",
      now: NOW,
    });
    expect(res.outcome).toBe("failed");
    expect(puts).toHaveLength(0);
  });

  it("never even resolves an Apify token when the X API path works", async () => {
    // The pool is routinely exhausted; resolving a token on the happy path is
    // pure waste. The thunk must stay un-awaited.
    let resolved = 0;
    const { bus } = fakeBus();
    const res = await runOwnAccountTick({
      bus,
      api: { async getMyAccount() { return OK_ACCOUNT; } },
      apify: async () => {
        resolved++;
        return { async userTweets() { return { tweets: [] }; } };
      },
      fallbackHandle: null,
      now: NOW,
    });
    expect(res.outcome).toBe("x_api");
    expect(resolved).toBe(0);
  });

  it("reports no_reader when the Apify resolver yields no usable client", async () => {
    const { bus, puts } = fakeBus();
    const res = await runOwnAccountTick({
      bus,
      api: null,
      apify: async () => null,
      fallbackHandle: "example_operator",
      now: NOW,
    });
    expect(res.outcome).toBe("no_reader");
    expect(puts).toHaveLength(0);
  });

