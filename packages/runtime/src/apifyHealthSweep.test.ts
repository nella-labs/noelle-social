import { describe, it, expect, vi } from "vitest";
import {
  sweepApifyTokenHealth,
  createThrottledApifyHealthSweep,
  type SweepToken,
} from "./apifyHealthSweep.js";

vi.mock("./apifyPoolDb.js", () => ({
  withApifyCredentialDb: async (sql: unknown, operation: (sql: unknown) => Promise<unknown>) => operation(sql),
}));

const log = { info: () => {}, warn: () => {} };
const sql = {} as never; // never touched: all DB ops are injected

function deps(over: Partial<Parameters<typeof sweepApifyTokenHealth>[0]> = {}) {
  return {
    sql,
    orgId: "org-1",
    concurrency: 4,
    log,
    listTokens: async () => [] as SweepToken[],
    checkToken: async () => ({ alive: true, httpStatus: 200 }),
    markInvalid: vi.fn(async () => true),
    ...over,
  };
}

describe("sweepApifyTokenHealth", () => {
  it("saves provider usage before a later 401, retaining the last known balance", async () => {
    const balances = new Map<string, number>();
    const healthy = { alive: true, httpStatus: 200, monthlyUsageUsd: 2.37, cycleEndAt: "2026-10-01T00:00:00Z" };
    let health = healthy;
    const shared = deps({
      listTokens: async () => [{ credentialId: "a", token: "ta" }],
      checkToken: async () => health,
      persistUsage: async (_sql, orgId, credentialId, usage) => {
        balances.set(`${orgId}/${credentialId}`, usage.monthlyUsageUsd!);
      },
    });

    await sweepApifyTokenHealth(shared);
    expect(balances.get("org-1/a")).toBe(2.37);
    health = { ...healthy, alive: false, httpStatus: 401, monthlyUsageUsd: 0 };
    const retired = await sweepApifyTokenHealth(shared);
    expect(retired.invalidated).toBe(1);
    expect(balances.get("org-1/a")).toBe(2.37);
  });

  it("records a real zero balance but ignores missing, invalid and failed usage probes", async () => {
    const saved: number[] = [];
    const healths = [
      { alive: true, httpStatus: 200, monthlyUsageUsd: 0 },
      { alive: true, httpStatus: 200 },
      { alive: true, httpStatus: 200, monthlyUsageUsd: -1 },
      { alive: true, httpStatus: 200, monthlyUsageUsd: Number.NaN },
      { alive: true, httpStatus: 200, monthlyUsageUsd: Number.POSITIVE_INFINITY },
      { alive: false, httpStatus: 503, monthlyUsageUsd: 0 },
    ];
    await sweepApifyTokenHealth(deps({
      listTokens: async () => healths.map((_, i) => ({ credentialId: String(i), token: String(i) })),
      checkToken: async (token) => healths[Number(token)]!,
      persistUsage: async (_sql, _orgId, _credentialId, health) => { saved.push(health.monthlyUsageUsd!); },
    }));
    expect(saved).toEqual([0]);
  });

  it("keeps probing when usage persistence fails and logs the failed credential", async () => {
    const warn = vi.fn();
    const result = await sweepApifyTokenHealth(deps({
      listTokens: async () => [{ credentialId: "a", token: "ta" }, { credentialId: "b", token: "tb" }],
      checkToken: async (token) => token === "ta"
        ? { alive: true, httpStatus: 200, monthlyUsageUsd: 2.37 }
        : { alive: false, httpStatus: 401 },
      persistUsage: async () => { throw new Error("storage unavailable"); },
      log: { info: () => {}, warn },
    }));
    expect(result).toEqual({ pruned: 0, checked: 2, invalidated: 1, alive: 1, inconclusive: 0 });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ credentialId: "a", err: "storage unavailable" }),
      expect.stringContaining("usage"),
    );
  });

  it("invalidates ONLY tokens whose health-check returns a definitive 401", async () => {
    const tokens: SweepToken[] = [
      { credentialId: "a", token: "ta" }, // 401 dead
      { credentialId: "b", token: "tb" }, // 200 alive (capped or fresh)
      { credentialId: "c", token: "tc" }, // 0 network — inconclusive
      { credentialId: "d", token: "td" }, // 401 dead
    ];
    const health: Record<string, { alive: boolean; httpStatus: number }> = {
      ta: { alive: false, httpStatus: 401 },
      tb: { alive: true, httpStatus: 200 },
      tc: { alive: false, httpStatus: 0 },
      td: { alive: false, httpStatus: 401 },
    };
    const markInvalid = vi.fn(async (_sql: unknown, _claim: { credentialId: string }) => true);
    const res = await sweepApifyTokenHealth(
      deps({
        listTokens: async () => tokens,
        checkToken: async (t: string) => health[t]!,
        markInvalid,
      }),
    );

    expect(res).toEqual({ pruned: 0, checked: 4, invalidated: 2, alive: 1, inconclusive: 1 });
    expect(markInvalid).toHaveBeenCalledTimes(2);
    const invalidatedIds = markInvalid.mock.calls.map((c) => c[1].credentialId).sort();
    expect(invalidatedIds).toEqual(["a", "d"]);
  });

  it("caps management-API concurrency even when a caller supplies an excessive value", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const checkToken = vi.fn(async () => { await gate; return { alive: true, httpStatus: 200 }; });
    const probing = sweepApifyTokenHealth(deps({
      concurrency: 1000,
      listTokens: async () => Array.from({ length: 20 }, (_, i) => ({ credentialId: String(i), token: String(i) })),
      checkToken,
    }));
    try {
      await vi.waitFor(() => expect(checkToken.mock.calls.length).toBeGreaterThan(0));
      expect(checkToken).toHaveBeenCalledTimes(16);
    } finally { release(); await probing; }
    expect(checkToken).toHaveBeenCalledTimes(20);
  });

  it.each([[0, 1], [-3, 1], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 1], [2.9, 2]])(
    "admits bounded integer concurrency for configuration %s",
    async (concurrency, expected) => {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const checkToken = vi.fn(async () => { await gate; return { alive: true, httpStatus: 200 }; });
      const probing = sweepApifyTokenHealth(deps({
        concurrency,
        listTokens: async () => Array.from({ length: 4 }, (_, i) => ({ credentialId: String(i), token: String(i) })),
        checkToken,
      }));
      try {
        await vi.waitFor(() => expect(checkToken.mock.calls.length).toBeGreaterThan(0));
        expect(checkToken).toHaveBeenCalledTimes(expected!);
      } finally { release(); await probing; }
      expect(checkToken).toHaveBeenCalledTimes(4);
    },
  );

  it("counts a stale credential receipt as inconclusive instead of invalidated", async () => {
    const markInvalid = vi.fn(async () => false);
    const info = vi.fn();
    const result = await sweepApifyTokenHealth(deps({
      listTokens: async () => [{ credentialId: "stale", token: "original" }],
      checkToken: async () => ({ alive: false, httpStatus: 401 }),
      markInvalid, log: { info, warn: vi.fn() },
    }));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ inconclusive: 1 }),
      "apify health sweep completed with inconclusive readings");
    expect(markInvalid).toHaveBeenCalledWith(sql, {
      orgId: "org-1", credentialId: "stale", token: "original",
    });
    expect(result).toEqual({ pruned: 0, checked: 1, invalidated: 0, alive: 0, inconclusive: 1 });
  });

  it("NEVER invalidates on a non-401 failure (403 cap, 429 throttle, 5xx, network)", async () => {
    const tokens: SweepToken[] = [
      { credentialId: "cap", token: "t403" },
      { credentialId: "throttle", token: "t429" },
      { credentialId: "server", token: "t500" },
      { credentialId: "net", token: "t0" },
    ];
    const health: Record<string, { alive: boolean; httpStatus: number }> = {
      t403: { alive: false, httpStatus: 403 },
      t429: { alive: false, httpStatus: 429 },
      t500: { alive: false, httpStatus: 503 },
      t0: { alive: false, httpStatus: 0 },
    };
    const markInvalid = vi.fn(async () => true);
    const res = await sweepApifyTokenHealth(
      deps({
        listTokens: async () => tokens,
        checkToken: async (t: string) => health[t]!,
        markInvalid,
      }),
    );

    expect(markInvalid).not.toHaveBeenCalled();
    expect(res).toEqual({ pruned: 0, checked: 4, invalidated: 0, alive: 0, inconclusive: 4 });
  });

  it("is fail-open: a probe that throws counts as inconclusive, not invalid", async () => {
    const markInvalid = vi.fn(async () => true);
    const res = await sweepApifyTokenHealth(
      deps({
        listTokens: async () => [{ credentialId: "x", token: "boom" }],
        checkToken: async () => {
          throw new Error("network down");
        },
        markInvalid,
      }),
    );
    expect(markInvalid).not.toHaveBeenCalled();
    expect(res).toEqual({ pruned: 0, checked: 1, invalidated: 0, alive: 0, inconclusive: 1 });
  });

  it("no-ops cleanly with an empty pool", async () => {
    const res = await sweepApifyTokenHealth(deps({ listTokens: async () => [] }));
    expect(res).toEqual({ pruned: 0, checked: 0, invalidated: 0, alive: 0, inconclusive: 0 });
  });
});

describe("createThrottledApifyHealthSweep", () => {
  it("runs once, then skips (returns null) until the interval elapses, per org", async () => {
    let now = 1_000_000;
    const run = vi.fn(async () => ({ pruned: 0, checked: 1, invalidated: 0, alive: 1, inconclusive: 0 }));
    const throttled = createThrottledApifyHealthSweep({
      intervalMs: 60_000,
      now: () => now,
      run,
    });

    expect(await throttled("org-1")).not.toBeNull(); // first run
    expect(await throttled("org-1")).toBeNull(); // within interval → skipped
    expect(await throttled("org-2")).not.toBeNull(); // different org → independent
    now += 60_001;
    expect(await throttled("org-1")).not.toBeNull(); // interval elapsed → runs again
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("does not wedge the throttle if a run throws (next tick retries)", async () => {
    const now = 0;
    let calls = 0;
    const run = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { pruned: 0, checked: 0, invalidated: 0, alive: 0, inconclusive: 0 };
    });
    const throttled = createThrottledApifyHealthSweep({ intervalMs: 1000, now: () => now, run });

    await expect(throttled("org-1")).rejects.toThrow("transient");
    // A throwing run must NOT stamp lastRun, so the very next tick retries.
    await expect(throttled("org-1")).resolves.not.toBeNull();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("retiring already-dead tokens", () => {
  const base = {
    sql: {} as never,
    orgId: "org-1",
    checkToken: async () => ({ alive: true, httpStatus: 200 }),
    markInvalid: async () => true,
    concurrency: 2,
    log: { info: () => {}, warn: () => {} },
  };

  it("retires BEFORE probing, so a dead token leaves the active pool on the next sweep", async () => {
    const order: string[] = [];
    const r = await sweepApifyTokenHealth({
      ...base,
      pruneInvalid: async () => {
        order.push("prune");
        return 7;
      },
      listTokens: async () => {
        order.push("list");
        return [{ credentialId: "a", token: "t" }];
      },
    });
    expect(order).toEqual(["prune", "list"]);
    expect(r.pruned).toBe(7);
  });

  it("still reports the prune count when there is nothing left to probe", async () => {
    const r = await sweepApifyTokenHealth({
      ...base,
      pruneInvalid: async () => 3,
      listTokens: async () => [],
    });
    expect(r).toEqual({ pruned: 3, checked: 0, invalidated: 0, alive: 0, inconclusive: 0 });
  });

  it("is FAIL-SOFT: a prune error never stops the probing", async () => {
    const r = await sweepApifyTokenHealth({
      ...base,
      pruneInvalid: async () => {
        throw new Error("db down");
      },
      listTokens: async () => [{ credentialId: "a", token: "t" }],
    });
    expect(r.pruned).toBe(0);
    expect(r.checked).toBe(1); // probing happened anyway
  });

  it("omitting pruneInvalid keeps the old flag-only behaviour", async () => {
    const r = await sweepApifyTokenHealth({
      ...base,
      listTokens: async () => [{ credentialId: "a", token: "t" }],
    });
    expect(r.pruned).toBe(0);
    expect(r.checked).toBe(1);
  });
});
