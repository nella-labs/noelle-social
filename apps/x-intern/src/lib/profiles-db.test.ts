import { describe, expect, it, vi } from "vitest";
import { listRepliedPeopleNeedingProfile } from "./profiles-db.js";

function tagged(rows: unknown[] = []) {
  const fragments: string[] = [];
  const values: unknown[][] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      fragments.push(strings.join("?"));
      values.push(vals);
      return rows;
    }),
    { json: (x: unknown) => x, unsafe: (x: string) => x },
  ) as never;
  return { sql, fragments, values };
}

describe("listRepliedPeopleNeedingProfile", () => {
  it("counts SENT replies per author and gates on the minReplies threshold", async () => {
    const t = tagged();
    await listRepliedPeopleNeedingProfile(t.sql, {
      agentInstanceId: "inst-1",
      minReplies: 5,
      windowDays: 90,
      staleDays: 3,
      batch: 3,
    });
    const q = t.fragments[0]!;
    // Only replies that actually went out count — a drafted-then-skipped reply
    // is not a relationship.
    expect(q).toMatch(/join noelle\.drafts/);
    expect(q).toMatch(/join noelle\.leads/);
    expect(q).toMatch(/a\.status = 'sent'/);
    // Scoped on BOTH sides — an approval carries its own agent_instance_id and
    // the two can diverge, so the lead filter alone could count another
    // agent's reply toward this one's tally.
    expect(q).toMatch(/a\.agent_instance_id = /);
    expect(q).toMatch(/having count\(\*\) > /);
    expect(t.values[0]).toContain(5);
    expect(t.values[0]).toContain(3);
  });

  it("matches profiles case-insensitively and reuses the stored handle", async () => {
    const t = tagged();
    await listRepliedPeopleNeedingProfile(t.sql, {
      agentInstanceId: "i",
      minReplies: 5,
      windowDays: 90,
      staleDays: 3,
      batch: 3,
    });
    const q = t.fragments[0]!;
    // x_watchlist_profiles is unique on the RAW (agent_instance_id, handle), so
    // profiling "ElonMusk" when the row says "elonmusk" would insert a twin.
    expect(q).toMatch(/lower\(pr\.handle\) = r\.handle_lc/);
    expect(q).toMatch(/coalesce\(profile_handle, handle_raw\)/);
  });

  it("counts only replies inside the recency window, and disables on window <= 0", async () => {
    // A lifetime tally would be monotonic: nobody could ever leave the queue, so
    // removing a person from the watchlist would stop no spend at all.
    const t = tagged();
    await listRepliedPeopleNeedingProfile(t.sql, {
      agentInstanceId: "i",
      minReplies: 5,
      windowDays: 90,
      staleDays: 3,
      batch: 3,
    });
    expect(t.fragments[0]!).toMatch(
      /coalesce\(d\.sent_at, a\.decided_at, a\.updated_at\) > now\(\) - make_interval/,
    );
    expect(t.values[0]).toContain(90);

    const off = tagged();
    expect(
      await listRepliedPeopleNeedingProfile(off.sql, {
        agentInstanceId: "i",
        minReplies: 5,
        windowDays: 0,
        staleDays: 3,
        batch: 3,
      }),
    ).toEqual([]);
    expect(off.fragments).toHaveLength(0);
  });

  it("only queues people whose profile is missing or stale", async () => {
    const t = tagged();
    await listRepliedPeopleNeedingProfile(t.sql, {
      agentInstanceId: "i",
      minReplies: 5,
      windowDays: 90,
      staleDays: 3,
      batch: 3,
    });
    const q = t.fragments[0]!;
    expect(q).toMatch(/refreshed_at is null/);
    expect(q).toMatch(/refreshed_at < now\(\) - make_interval/);
    expect(q).toMatch(/order by refreshed_at asc nulls first, replies desc/);
  });

  it("maps rows through and short-circuits on a non-positive batch", async () => {
    const t = tagged([{ handle: "paulg", added_at: "2026-07-28T00:00:00Z" }]);
    const out = await listRepliedPeopleNeedingProfile(t.sql, {
      agentInstanceId: "i",
      minReplies: 5,
      windowDays: 90,
      staleDays: 3,
      batch: 3,
    });
    expect(out).toEqual([{ handle: "paulg", addedAt: "2026-07-28T00:00:00Z" }]);

    const off = tagged();
    expect(
      await listRepliedPeopleNeedingProfile(off.sql, {
        agentInstanceId: "i",
        minReplies: 5,
        windowDays: 90,
        staleDays: 3,
        batch: 0,
      }),
    ).toEqual([]);
    expect(off.fragments).toHaveLength(0);
  });
});
