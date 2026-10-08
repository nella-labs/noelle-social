import { describe, expect, it, vi } from "vitest";
import { createApifyShardResolver } from "./apify-shard-resolver.js";
import { shardRoundRobin } from "@noelle/runtime";

vi.mock("@noelle/x-apify", async importOriginal => {
  const actual = await importOriginal<typeof import("@noelle/x-apify")>();
  return { ...actual, checkApifyToken: vi.fn() };
});
vi.mock("./connections-db.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./connections-db.js")>();
  return { ...actual, markApifyTokenInvalid: vi.fn().mockResolvedValue(true) };
});
vi.mock("./apify-rotating.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./apify-rotating.js")>();
  return { ...actual, createRotatingApifyClient: vi.fn(actual.createRotatingApifyClient) };
});

// A fake `sql` tagged-template returning a fixed token pool.
function poolSql(tokens: Array<{ credentialId: string; token: string; available: boolean }>) {
  return (() =>
    Promise.resolve(
      tokens.map((t) => ({
        credential_id: t.credentialId,
        token: t.token,
        available: t.available,
        was_exhausted: false,
      })),
    )) as never;
}

const deps = (sql: never) => ({
  sql,
  secrets: { get: vi.fn().mockResolvedValue("env-token") },
  apifyTokenSecretId: "sec",
  log: { warn: vi.fn() },
});

const mkTokens = (n: number, available = true) =>
  Array.from({ length: n }, (_, i) => ({
    credentialId: `c${i}`,
    token: `t${i}`,
    available,
  }));

describe("createApifyShardResolver", () => {
  it("returns ONE handle when a single shard is requested (unsharded path)", async () => {
    const resolve = createApifyShardResolver(deps(poolSql(mkTokens(6))));
    expect(await resolve("org", 1)).toHaveLength(1);
  });

  it("splits the pool into the requested number of shards", async () => {
    const resolve = createApifyShardResolver(deps(poolSql(mkTokens(6))));
    expect(await resolve("org", 3)).toHaveLength(3);
  });

  it("never returns more shards than there are AVAILABLE tokens", async () => {
    // 8 shards requested against 3 usable tokens must yield 3, never 8 sharing.
    const resolve = createApifyShardResolver(deps(poolSql(mkTokens(3))));
    expect(await resolve("org", 8)).toHaveLength(3);
  });

  it("ignores tokens that are still cooling down", async () => {
    const resolve = createApifyShardResolver(
      deps(poolSql([...mkTokens(2, true), ...mkTokens(4, false).map((t, i) => ({ ...t, credentialId: `x${i}`, token: `x${i}` }))])),
    );
    expect(await resolve("org", 4)).toHaveLength(2);
  });

  it("falls back to a single handle when nothing is available (so it pages once)", async () => {
    // Splitting an empty pool would raise "all exhausted" N times and page N
    // times; one handle preserves the single-page behaviour.
    const resolve = createApifyShardResolver(deps(poolSql(mkTokens(4, false))));
    const shards = await resolve("org", 4);
    expect(shards).toHaveLength(1);
  });

  it("clamps a nonsense shard count to at least one", async () => {
    const resolve = createApifyShardResolver(deps(poolSql(mkTokens(4))));
    for (const n of [0, -3, Number.NaN]) {
      expect((await resolve("org", n)).length).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("shard disjointness — the property that makes concurrency safe", () => {
  it("puts every available token in EXACTLY ONE shard", () => {
    // This is the whole safety argument: if two concurrent shards could hold the
    // same token, running them in parallel would just rate-limit that token
    // twice as fast. shardRoundRobin partitions, so it cannot happen.
    const tokens = mkTokens(9).map((t) => t.token);
    for (const n of [2, 3, 4, 9]) {
      const groups = shardRoundRobin(tokens, n);
      const flat = groups.flat();
      expect(flat.slice().sort()).toEqual(tokens.slice().sort()); // nothing lost
      expect(new Set(flat).size).toBe(tokens.length); // nothing duplicated
      // And no token appears in two different groups.
      const seen = new Set<string>();
      for (const g of groups) {
        for (const t of g) {
          expect(seen.has(t)).toBe(false);
          seen.add(t);
        }
      }
    }
  });

  it("balances the slices so one shard cannot carry the whole pool", () => {
    const groups = shardRoundRobin(mkTokens(10).map((t) => t.token), 3);
    const sizes = groups.map((g) => g.length).sort();
    // 10 across 3 → 3/3/4; the largest and smallest differ by at most one.
    expect(sizes[sizes.length - 1]! - sizes[0]!).toBeLessThanOrEqual(1);
  });
});


it("binds each sharded callback to its captured organization and stored key", async () => {
  const db = await import("./connections-db.js");
  const { checkApifyToken } = await import("@noelle/x-apify");
  const rotation = await import("./apify-rotating.js");
  vi.mocked(checkApifyToken).mockResolvedValue({ alive: false, httpStatus: 401 });
  vi.mocked(db.markApifyTokenInvalid).mockClear();
  vi.mocked(rotation.createRotatingApifyClient).mockClear();
  const sql = (() => Promise.resolve([0, 1].map(i => ({
    id: `id-${i}`, secret: `key-${i}`, exhausted: false, available: true,
  })))) as never;
  await createApifyShardResolver(deps(sql))("actual-org", 2);
  const callbacks = vi.mocked(rotation.createRotatingApifyClient).mock.calls.map(([options]) => options.onTokenFatal);
  expect(callbacks).toHaveLength(2);
  for (const [i, callback] of callbacks.entries()) callback!(`id-${i}`, 401, `key-${i}`);
  await vi.waitFor(() => expect(db.markApifyTokenInvalid).toHaveBeenCalledTimes(2));
  for (let i = 0; i < 2; i++) {
    expect(db.markApifyTokenInvalid).toHaveBeenCalledWith(expect.anything(), {
      orgId: "actual-org", credentialId: `id-${i}`, token: `key-${i}`,
    });
  }
});
