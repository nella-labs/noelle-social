import { describe, expect, it, vi } from "vitest";
import { claimAutoSendDue, expireStaleApprovals } from "./send-db.js";

function captureSql(rows: unknown[] = [{ id: "A1" }]) {
  const fragments: string[] = [];
  const params: unknown[][] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      fragments.push(strings.join("?"));
      params.push(vals);
      const query = strings.join("?");
      if (query.includes("auto_send_max_per_hour as hourly_cap")) return [{ org_id: "org", hourly_cap: 6 }];
      if (query.includes("as half_hour")) return [{ hour: 0, day: 0, half_hour: 0 }];
      return rows;
    }),
    { unsafe: vi.fn(), json: (x: unknown) => x },
  );
  Object.assign(sql, { begin: async (fn: (tx: typeof sql) => Promise<unknown>) => fn(sql) });
  return { sql: sql as never, fragments, params };
}

describe("claimAutoSendDue", () => {
  it("returns [] without querying when budget <= 0", async () => {
    const { sql, fragments } = captureSql();
    const out = await claimAutoSendDue(sql, { agentInstanceId: "i", budget: 0 });
    expect(out).toEqual([]);
    expect(fragments.length).toBe(0);
  });

  it("adds a KEEP-FRESH (>=, younger-than) predicate when maxAgeHours > 0", async () => {
    const { sql, fragments, params } = captureSql();
    await claimAutoSendDue(sql, { agentInstanceId: "i", budget: 2, maxAgeHours: 48 });
    const all = fragments.join("\n");
    // The claim keeps tweets YOUNGER than the ceiling: >= now() - interval.
    // The opposite of the expiry sweeps (< older-than). Swapping these would
    // claim exactly the stale tweets we mean to skip, so pin the direction.
    expect(all).toMatch(/>= \?/);
    expect(all).toContain("now() - (case");
    expect(all).not.toMatch(/< \?/);
    // fail-open on undateable posts is an OR-branch, not a filter-out
    expect(all).toContain("pg_input_is_valid");
    expect(all).toMatch(/\? is null/);
    expect(params.some((p) => p.includes(48))).toBe(true);
  });

  it("omits the freshness predicate when maxAgeHours is unset (legacy behavior)", async () => {
    const { sql, fragments } = captureSql();
    await claimAutoSendDue(sql, { agentInstanceId: "i", budget: 2 });
    // no interval clause bound into the claim when the ceiling is off
    expect(fragments.find((q) => q.includes("with claimed"))).not.toMatch(/make_interval\(hours =>/);
  });
});

describe("expireStaleApprovals", () => {
  it("is a no-op (no query) when the ceiling is 0", async () => {
    const { sql, fragments } = captureSql();
    const out = await expireStaleApprovals(sql, { agentInstanceId: "i", maxAgeHours: 0 });
    expect(out).toEqual({ pending: 0, limbo: 0 });
    expect(fragments.length).toBe(0);
  });

  it("expires both pending and never-posted 'sent' limbo approvals, DMs exempt", async () => {
    // The nested staleTweet() helper records its own fragment, so assert on the
    // combined SQL text rather than fixed indices.
    const { sql, fragments, params } = captureSql([{ id: "A1" }]);
    const out = await expireStaleApprovals(sql, { agentInstanceId: "i", maxAgeHours: 48 });
    expect(out).toEqual({ pending: 1, limbo: 1 });
    const all = fragments.join("\n");
    // both sweeps flip to the terminal 'expired' status
    expect(all).toMatch(/set status = 'expired'/);
    // pending sweep
    expect(all).toMatch(/a\.status = 'pending'/);
    expect(all).toMatch(/<> 'dm'/);
    // limbo sweep: 'sent' with neither external id nor sent_at
    expect(all).toMatch(/a\.status = 'sent'/);
    expect(all).toMatch(/sent_external_id is null/);
    expect(all).toMatch(/sent_at is null/);
    // EXPIRE means OLDER-than: the sweep binds `< now() - interval`, the exact
    // opposite of the keep-fresh claim (>=). Swapping the operator would expire
    // every FRESH reply and keep the stale ones — so pin the direction, and
    // assert the keep-fresh `>=` never leaks into an expiry query.
    // The interval is now a CASE (notifications use their own window), so
    // `make_interval` is no longer adjacent to `now() -`. The DIRECTION is what
    // matters and is still pinned: `< now() -`, and no keep-fresh `>=` anywhere.
    expect(all).toMatch(/< \?/);
    expect(all).toContain("now() - (case");
    expect(all).toMatch(/make_interval\(hours =>/);
    expect(all).not.toMatch(/>= \?/);
    expect(params.filter((p) => p.includes(48)).length).toBeGreaterThanOrEqual(2);
  });

  it("keeps requested human-review drafts visible even when their saved post is old", async () => {
    const { sql, fragments } = captureSql([{ id: "A1" }]);

    await expireStaleApprovals(sql, { agentInstanceId: "i", maxAgeHours: 48 });

    const pendingSweep = fragments.find((q) => q.includes("a.status = 'pending'")) ?? "";
    expect(pendingSweep).toMatch(/human_review_required/);
    expect(pendingSweep).toMatch(/human_send_approved/);
    expect(pendingSweep).toMatch(/is distinct from 'true'/);
  });

  it("does not expire browser-observed approvals through the legacy age sweep", async () => {
    const { sql, fragments } = captureSql();
    await expireStaleApprovals(sql, { agentInstanceId: "i", maxAgeHours: 48 });
    const sweeps = fragments.filter((q) => q.includes("set status = 'expired'"));
    expect(sweeps).toHaveLength(2);
    expect(fragments.join("\n")).toContain("l.payload->>'source' is distinct from 'extension_observed'");
  });
});

describe("expireStaleApprovals — notification lane window", () => {
  // The FOURTH place the cold-reply ceiling leaked into the conversation lane.
  // A notification lead is a reply UNDER someone's post, so the source tweet is
  // already days old when the reply arrives — a 24h ceiling expires the approval
  // the moment it is created, silently undoing the classifier + RPC fixes.
  const capture = () => {
    const seen: string[] = [];
    const fake = (strings: TemplateStringsArray) => {
      seen.push(strings.join("?"));
      return Promise.resolve([]);
    };
    const sql = Object.assign(fake, { unsafe: (query: string) => { seen.push(query); return query; } });
    return { sql: sql as never, seen };
  };

  it("derives the notification window from the shared constant", async () => {
    const { sql, seen } = capture();
    await expireStaleApprovals(sql, { agentInstanceId: "i", maxAgeHours: 24 });
    const q = seen.join("\n");
    expect(q).toContain("'notification'");
    // The notification lane's bound comes from NOTIFICATION_MAX_AGE_HOURS now,
    // interpolated as make_interval rather than a literal, so a change to the
    // shared constant cannot leave this predicate behind.
    expect(q).toContain("make_interval(hours =>");
    // and the ordinary ceiling still applies to everything else
    expect(q).toContain("make_interval");
  });

  it("still no-ops when the ceiling is disabled", async () => {
    const { sql } = capture();
    expect(await expireStaleApprovals(sql, { agentInstanceId: "i", maxAgeHours: 0 })).toEqual({
      pending: 0,
      limbo: 0,
    });
  });
});
