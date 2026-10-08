import { describe, expect, it, vi } from "vitest";
import {
  upsertDiscoveredLead,
  claimLeadsForClassification,
  claimLeadsForDrafting,
  reapStaleClaims,
} from "./leads-db.js";

function captureSql() {
  const fragments: string[] = [];
  const params: unknown[][] = [];
  const sql = Object.assign(
    vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
      fragments.push(strings.join("?"));
      params.push(vals);
      return [{ id: "L1" }];
    }),
    { unsafe: vi.fn(), json: (x: unknown) => x },
  ) as never;
  return { sql, fragments, params };
}

describe("tenant-scoped lead deduplication", () => {
  it("uses the org, platform, and external ID as its conflict target", async () => {
    const { sql, fragments } = captureSql();
    await upsertDiscoveredLead(sql, {
      orgId: "org", agentInstanceId: "instance", platform: "reddit", externalId: "abc",
      authorHandle: "author", authorId: null, payload: {}, postedAt: "2026-09-19T00:00:00Z",
    });
    expect(fragments[0]).toMatch(/on conflict \(org_id, platform, external_id\) do nothing/);
  });
});

// The whole point of the reply-management fix: Orion must work the FRESHEST
// posts first (a reply's Reddit visibility rides the thread's early upvote
// curve), not drain an oldest-discovered FIFO. Both claim points order by the
// post's own time (payload.posted_at), newest first, with created_at as the
// tie-break and NULLS LAST so a legacy lead without a stamp sorts last. The
// compare is on the raw TEXT (not ::timestamptz) so a malformed/empty stamp
// can't throw and stall the claim — UTC ISO stamps sort lexically anyway.
const FRESH_FIRST = /order by \(payload->>'posted_at'\) desc nulls last, created_at desc/;
const NO_TIMESTAMPTZ_CAST = /::timestamptz/;

describe("claimLeadsForClassification", () => {
  it("claims the freshest new leads first (newest post, not oldest discovered)", async () => {
    const { sql, fragments, params } = captureSql();
    await claimLeadsForClassification(sql, { orgId: "o", agentInstanceId: "i", batch: 10 });
    expect(fragments[0]).toMatch(/update noelle\.leads/);
    expect(fragments[0]).toMatch(/status = 'new'/);
    expect(fragments[0]).toMatch(FRESH_FIRST);
    expect(fragments[0]).not.toMatch(/order by created_at asc/);
    // Poison-pill guard: never cast posted_at in the claim ORDER BY.
    expect(fragments[0]).not.toMatch(NO_TIMESTAMPTZ_CAST);
    expect(params[0]).toContain("i");
  });
});

describe("claimLeadsForDrafting", () => {
  it("claims the freshest classified priority=false leads first, inline (no shared RPC)", async () => {
    const { sql, fragments, params } = captureSql();
    await claimLeadsForDrafting(sql, { agentInstanceId: "i", batch: 5 });
    // Inlined so Orion can order fresh-first WITHOUT changing the created_at-asc
    // ordering the X/LinkedIn interns share through claim_leads_for_drafting.
    expect(fragments[0]).not.toMatch(/claim_leads_for_drafting/);
    expect(fragments[0]).toMatch(/set status = 'drafting'/);
    expect(fragments[0]).toMatch(/status = 'classified'/);
    expect(fragments[0]).toMatch(/priority = false/);
    expect(fragments[0]).toMatch(FRESH_FIRST);
    // Poison-pill guard: never cast posted_at in the claim ORDER BY.
    expect(fragments[0]).not.toMatch(NO_TIMESTAMPTZ_CAST);
    expect(params[0]).toContain("i");
    expect(params[0]).toContain(5);
  });
});

describe("reapStaleClaims", () => {

  it("requeues fresh strands to the pre-claim status, bounded by the expiry horizon", async () => {
    const { sql, fragments, params } = captureSql();
    const out = await reapStaleClaims(sql, {
      agentInstanceId: "i",
      claimedStatus: "drafting",
      requeueStatus: "classified",
    });
    expect(out).toEqual({ requeued: 1, expired: 1 });
    expect(fragments[0]).toMatch(/update noelle\.leads/);
    // stale = older than the claim TTL...
    expect(fragments[0]).toMatch(/updated_at < now\(\) - make_interval\(mins =>/);
    // ...but still young enough to be worth a retry
    expect(fragments[0]).toMatch(/updated_at >= now\(\) - make_interval\(hours =>/);
    expect(params[0]).toContain("classified");
    expect(params[0]).toContain("drafting");
    expect(params[0]).toContain("i");
  });

  it("expires ancient strands to 'skipped' with an audit marker, never a retry", async () => {
    const { sql, fragments } = captureSql();
    await reapStaleClaims(sql, {
      agentInstanceId: "i",
      claimedStatus: "classifying",
      requeueStatus: "new",
    });
    expect(fragments[1]).toMatch(/set status = 'skipped'/);
    expect(fragments[1]).toMatch(/stale_claim/);
    expect(fragments[1]).toMatch(/updated_at < now\(\) - make_interval\(hours =>/);
  });
});
