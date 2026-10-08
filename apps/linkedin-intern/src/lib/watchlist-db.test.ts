import { describe, expect, it, vi } from "vitest";
import {
  claimIntroDmPeople,
  listRepliedPeopleNeedingProfile,
  getWatchlistProfiles,
} from "./watchlist-db.js";

describe("claimIntroDmPeople", () => {
  it("claims + stamps profiled, unstamped people and maps the joined profile fields", async () => {
    const fragments: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        fragments.push(strings.join("?"));
        return [
          {
            id: "row-1",
            fsd_profile_id: "ABC123",
            public_id: "maya-builds",
            name: "Maya Lopez",
            headline: "Founder @ Loop",
            objective: "befriend, learn what she's building",
            summary: "Ships dev tools fast, posts about agent reliability.",
            topics: ["agents", "dx", "evals"],
            tone: "earnest",
            engagement_notes: "be concrete, ask real questions",
          },
        ];
      }),
      { json: (x: unknown) => x },
    ) as never;

    const out = await claimIntroDmPeople(sql, { agentInstanceId: "i", cap: 5 });

    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      id: "row-1",
      fsdProfileId: "ABC123",
      publicId: "maya-builds",
      name: "Maya Lopez",
      headline: "Founder @ Loop",
      objective: "befriend, learn what she's building",
      summary: "Ships dev tools fast, posts about agent reliability.",
      topics: ["agents", "dx", "evals"],
      tone: "earnest",
      engagementNotes: "be concrete, ask real questions",
    });

    const q = fragments[0]!;
    // Atomic claim + stamp: an UPDATE that sets intro_dm_drafted_at = now()...
    expect(q).toMatch(/update noelle\.linkedin_watchlist_people/);
    expect(q).toMatch(/set intro_dm_drafted_at = now\(\)/);
    // ...only over rows selected FOR UPDATE SKIP LOCKED (no double-claim)...
    expect(q).toMatch(/for update\s+skip locked/i);
    // ...that are still unstamped...
    expect(q).toMatch(/intro_dm_drafted_at is null/);
    // ...and have a GENERATED profile (summary not null = personalized only).
    expect(q).toMatch(/join noelle\.linkedin_watchlist_profiles/);
    expect(q).toMatch(/summary is not null/);
  });

  it("returns [] immediately (no query) when cap <= 0 — the lane is disabled", async () => {
    const sql = Object.assign(vi.fn(async () => []), { json: (x: unknown) => x }) as never;
    expect(await claimIntroDmPeople(sql, { agentInstanceId: "i", cap: 0 })).toEqual([]);
    expect((sql as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  it("passes the cap as the LIMIT and tolerates a non-array topics value", async () => {
    let limitVal: unknown;
    const sql = Object.assign(
      vi.fn(async (_s: TemplateStringsArray, ...vals: unknown[]) => {
        // vals are the interpolated bound values, in order: agentInstanceId, cap.
        limitVal = vals[vals.length - 1];
        return [
          {
            id: "row-2",
            fsd_profile_id: "XYZ",
            public_id: null,
            name: null,
            headline: null,
            objective: null,
            summary: "thin but present",
            topics: null, // defensive: non-array → []
            tone: null,
            engagement_notes: null,
          },
        ];
      }),
      { json: (x: unknown) => x },
    ) as never;

    const out = await claimIntroDmPeople(sql, { agentInstanceId: "i", cap: 3 });
    expect(limitVal).toBe(3);
    expect(out[0]!.topics).toEqual([]);
    expect(out[0]!.publicId).toBeNull();
  });
});

describe("listRepliedPeopleNeedingProfile", () => {
  function tagged(rows: unknown[] = []) {
    const fragments: string[] = [];
    const values: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        fragments.push(strings.join("?"));
        values.push(vals);
        return rows;
      }),
      { json: (x: unknown) => x },
    ) as never;
    return { sql, fragments, values };
  }

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
    // A drafted-then-skipped reply is not a relationship; only sends count.
    expect(q).toMatch(/join noelle\.drafts/);
    expect(q).toMatch(/a\.status = 'sent'/);
    // Scoped on BOTH sides — an approval carries its own agent_instance_id and
    // the two can diverge, so the lead filter alone could count another
    // agent's reply toward this one's tally.
    expect(q).toMatch(/a\.agent_instance_id = /);
    expect(q).toMatch(/l\.platform = 'linkedin'/);
    expect(q).toMatch(/having count\(\*\) > /);
    expect(t.values[0]).toContain(5);
  });

  it("matches an existing profile under EITHER key and carries its fsd id forward", async () => {
    const t = tagged();
    await listRepliedPeopleNeedingProfile(t.sql, {
      agentInstanceId: "i",
      minReplies: 5,
      windowDays: 90,
      staleDays: 3,
      batch: 3,
    });
    const q = t.fragments[0]!;
    // Profiles are keyed by fsd_profile_id; a lead's author_handle is sometimes
    // the vanity slug instead. Matching one way only would insert a twin row.
    expect(q).toMatch(/lower\(p2\.fsd_profile_id\) = lower\(r\.handle\)/);
    expect(q).toMatch(/lower\(coalesce\(p2\.public_id, ''\)\) = lower\(r\.handle\)/);
    expect(q).toMatch(/coalesce\(s\.profile_key, s\.handle\)/);
  });

  it("counts only replies inside the recency window, and disables on window <= 0", async () => {
    const t = tagged();
    await listRepliedPeopleNeedingProfile(t.sql, {
      agentInstanceId: "i",
      minReplies: 5,
      windowDays: 90,
      staleDays: 3,
      batch: 3,
    });
    expect(t.fragments[0]!).toMatch(
      /coalesce\(a\.decided_at, a\.updated_at\) > now\(\) - make_interval/,
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

  it("hands back the newest /posts/ permalink so the vanity slug can be mined", async () => {
    const t = tagged();
    await listRepliedPeopleNeedingProfile(t.sql, {
      agentInstanceId: "i",
      minReplies: 5,
      windowDays: 90,
      staleDays: 3,
      batch: 3,
    });
    const q = t.fragments[0]!;
    expect(q).toMatch(/linkedin\.com\/posts\//);
    expect(q).toMatch(/distinct on \(l\.author_handle\)/);
    expect(q).toMatch(/refreshed_at is null/);
  });

  it("maps rows through and short-circuits on a non-positive batch", async () => {
    const t = tagged([
      {
        fsd_profile_id: "ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
        author_public_id: "ACwAABlDYv4BnnBKfPQRpeO8bEiD6KWZWZw7Z2s",
        name: "Phil P.",
        headline: "Founder",
