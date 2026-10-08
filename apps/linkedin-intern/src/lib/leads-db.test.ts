import { describe, expect, it, vi } from "vitest";
import { upsertDiscoveredLead, claimReplyRequestLeads, claimObservedLeadsForClassification, claimObservedLeadsForDrafting, claimWatchlistLeadsForDrafting, createStartupDraftingRecovery, hasCanonicalObservedIdentity, reapStaleClaims } from "./leads-db.js";

describe("browser lead identity gate", () => {
  const id = "7507055234809114626";
  const url = `https://www.linkedin.com/feed/update/urn:li:activity:${id}/`;

  it("accepts a matching canonical activity URL after identity resolution", () => {
    expect(hasCanonicalObservedIdentity({ external_id: id }, { urn: `urn:li:activity:${id}`, url })).toBe(true);
    expect(hasCanonicalObservedIdentity({ external_id: id }, { urn: `urn:li:activity:${id}`, url: url.slice(0, -1) })).toBe(true);
  });

  it("rejects a card fingerprint, missing URL, mismatched URL, and foreign host", () => {
    expect(hasCanonicalObservedIdentity({ external_id: "browser:abc" }, { url })).toBe(false);
    expect(hasCanonicalObservedIdentity({ external_id: id }, {})).toBe(false);
    expect(hasCanonicalObservedIdentity({ external_id: id }, { url: url.replace(id, "1111111111111111111") })).toBe(false);
    expect(hasCanonicalObservedIdentity({ external_id: id }, { url: `https://example.com/feed/update/urn:li:activity:${id}/` })).toBe(false);
  });
});

it("deduplicates legacy LinkedIn leads within a tenant and platform", async () => {
  let query = "";
  const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
    query = parts.join("?");
    return [{ id: "lead", inserted: true }];
  }), { json: (value: unknown) => value }) as never;
  await upsertDiscoveredLead(sql, {
    orgId: "org", agentInstanceId: "instance", platform: "linkedin", externalId: "123",
    authorHandle: "author", authorId: null, payload: {}, postedAt: "2026-09-19T00:00:00Z",
  });
  expect(query).toMatch(/on conflict \(org_id, platform, external_id\) do nothing/);
});
describe("reapStaleClaims", () => {
  function captureSql() {
    const fragments: string[] = [];
    const params: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        const fragment = strings.join("?");
        fragments.push(fragment);
        params.push(vals);
        return fragment.includes("insert into noelle.approvals") || fragment.includes("set status = 'drafted'")
          ? [] : [{ id: "L1" }];
      }),
      { unsafe: vi.fn(), json: (x: unknown) => x },
    ) as never;
    return { sql, fragments, params };
  }

  it("requeues fresh strands to the pre-claim status, bounded by the expiry horizon", async () => {
    const { sql, fragments, params } = captureSql();
    const out = await reapStaleClaims(sql, {
      agentInstanceId: "i",
      claimedStatus: "drafting",
      requeueStatus: "classified",
    });
    expect(out).toEqual({ requeued: 1, expired: 1, reconciled: 0, approvalsRepaired: 0 });
    expect(fragments[2]).toMatch(/update noelle\.leads/);
    // stale = older than the claim TTL...
    expect(fragments[2]).toMatch(/updated_at < now\(\) - make_interval\(mins =>/);
    // ...but still young enough to be worth a retry
    expect(fragments[2]).toMatch(/updated_at >= now\(\) - make_interval\(hours =>/);
    expect(params[2]).toContain("classified");
    expect(params[2]).toContain("drafting");
    expect(params[2]).toContain("i");
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

  it("keeps a persisted draft out of both 45-minute requeue and expiry", async () => {
    const { sql, fragments, params } = captureSql();
    await reapStaleClaims(sql, {
      agentInstanceId: "i",
      claimedStatus: "drafting",
      requeueStatus: "classified",
    });

    expect(fragments[0]).toContain("insert into noelle.approvals");
    expect(fragments[1]).toContain("set status = 'drafted'");
    for (let index = 2; index < 4; index++) {
      expect(fragments[index]).toMatch(/not exists\s*\(\s*select 1 from noelle\.drafts d\s*where d\.lead_id = l\.id and d\.org_id = l\.org_id\s*and coalesce\(d\.payload->>'kind', 'reply'\) = 'reply'\s*\)/);
      expect(fragments[index]).toContain("? <> 'drafting' or not exists");
      expect(params[index]).toContain("drafting");
    }
  });
});

describe("startup drafting recovery", () => {
  const startedAt = new Date("2026-09-20T20:00:00.000Z");

  it("requeues only this instance's pre-start drafting claims younger than 48 hours without a saved draft", async () => {
    const fragments: string[] = [];
    const params: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const fragment = strings.join("?");
      fragments.push(fragment);
      params.push(values);
      return fragment.includes("set status = 'classified'") ? [{ id: "L1" }] : [];
    }) as never;

    const recover = createStartupDraftingRecovery(sql, startedAt);
    expect(await recover("instance-a")).toEqual({ requeued: 1, reconciled: 0, approvalsRepaired: 0 });

    expect(fragments[0]).toContain("insert into noelle.approvals");
    expect(fragments[0]).toContain("on conflict (draft_id) do nothing");
    expect(fragments[1]).toContain("set status = 'drafted'");
    expect(fragments[2]).toContain("update noelle.leads l");
    expect(fragments[2]).toContain("set status = 'classified'");
    expect(fragments[2]).toContain("l.agent_instance_id = ?");
    expect(fragments[2]).toContain("l.status = 'drafting'");
    expect(fragments[2]).toContain("l.updated_at < ?::timestamptz");
    expect(fragments[2]).toContain("l.updated_at >= now() - make_interval(hours => ?)");
    expect(fragments[2]).toContain("coalesce(d.payload->>'kind', 'reply') = 'reply'");
    expect(params[2]).toContain("instance-a");
    expect(params[2]).toContain(startedAt.toISOString());
    expect(params[2]).toContain(48);
  });

  it("runs once per instance and retries a failed sweep", async () => {
    let fail = true;
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      if (fail) throw new Error("database unavailable");
      return strings.join("?").includes("set status = 'classified'") ? [{ id: "L1" }] : [];
    }) as never;
    const recover = createStartupDraftingRecovery(sql, startedAt);

    await expect(recover("instance-a")).rejects.toThrow("database unavailable");
    fail = false;
    expect(await recover("instance-a")).toEqual({ requeued: 1, reconciled: 0, approvalsRepaired: 0 });
    expect(await recover("instance-a")).toEqual({ requeued: 0, reconciled: 0, approvalsRepaired: 0 });
    expect(await recover("instance-b")).toEqual({ requeued: 1, reconciled: 0, approvalsRepaired: 0 });
    expect(sql).toHaveBeenCalledTimes(7);
  });
});

describe("claimReplyRequestLeads", () => {
  it("atomically claims one-off reply requests without duplicating completed keys", async () => {
    const fragments: string[] = [];
    const params: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        fragments.push(strings.join("?"));
        params.push(vals);
        return [{ id: "L1", payload: { reply_request: { request_key: "manual-1" } } }];
      }),
      { unsafe: vi.fn(), json: (x: unknown) => x },
    ) as never;

    const out = await claimReplyRequestLeads(sql, { agentInstanceId: "i", cap: 5 });

    expect(out).toHaveLength(1);
    expect(fragments[0]).toMatch(/update noelle\.leads/);
    expect(fragments[0]).toMatch(/status = 'drafting'/);
    expect(fragments[0]).not.toMatch(/payload = payload - 'reply_requested'/);
    expect(fragments[0]).toMatch(/payload->>'reply_requested' = 'true'/);
    expect(fragments[0]).toMatch(/payload->'reply_request'->>'request_key'/);
    expect(fragments[0]).toMatch(/for update skip locked/);
    expect(params[0]).toContain("i");
    expect(params[0]).toContain(5);
  });
});

describe("extension-observed lead claims", () => {
  function capture() {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        queries.push(strings.join("?"));
        params.push(values);
        return [{ id: "L1" }];
      }),
      { json: (x: unknown) => x },
    ) as never;
    return { sql, queries, params };
  }

  it("claims only observed posts, independently of legacy new leads", async () => {
    const { sql, queries, params } = capture();
    const rows = await claimObservedLeadsForClassification(sql, { agentInstanceId: "i", batch: 20 });
    expect(rows).toHaveLength(1);
    expect(queries[0]).toContain("status = 'observed_classifying'");
    expect(queries[0]).toContain("status = 'observed'");
    expect(queries[0]).toContain("for update skip locked");
    expect(params[0]).toContain("i");
    expect(params[0]).toContain(20);
  });

  it("claims Jev-qualified browser leads first while enforcing one pending reply per author", async () => {
    const { sql, queries, params } = capture();
    const rows = await claimObservedLeadsForDrafting(sql, { agentInstanceId: "i", cap: 5 });
    expect(rows).toHaveLength(1);
    expect(queries[0]).toContain("status = 'drafting'");
    expect(queries[0]).toContain("payload->>'source' = 'extension_observed'");
    expect(queries[0]).toContain("payload->'classifier'->>'provider' = 'jev'");
    expect(queries[0]).toContain("cand.external_id ~ '^[0-9]+$'");
    expect(queries[0]).toContain("cand.payload->>'url' like 'https://www.linkedin.com/%'");
    expect(queries[0]).toContain("distinct on (cand.author_handle)");
    expect(queries[0]).toContain("a.status = 'pending'");
    expect(params[0]).toContain("i");
    expect(params[0]).toContain(5);
  });

  it("keeps browser reply drafting within five in-progress or pending leads", async () => {
    const { sql, queries, params } = capture();
    await claimObservedLeadsForDrafting(sql, { agentInstanceId: "i", cap: 5 });

    expect(queries[0]).toContain("count(distinct occupied.id)");
    expect(queries[0]).toContain("occupied.status = 'drafting'");
    expect(queries[0]).toContain("approval.status = 'pending'");
    expect(queries[0]).toContain("coalesce(draft.payload->>'kind', 'reply') = 'reply'");
    expect(queries[0]).toContain("draft.payload->'verifier_meta'->>'pass' = 'true'");
    expect(queries[0]).toContain("draft.payload->'verifier_meta'->>'judgeOk' = 'true'");
    expect(queries[0]).toContain("draft.payload->>'human_review_required' is distinct from 'true'");
    expect(queries[0]).toContain("draft.payload->'verifier_meta'->'scores'->>'voice'");
    expect(queries[0]).toContain("occupied.payload->>'source' = 'extension_observed'");
    expect(queries[0]).toMatch(/limit greatest\(0, least\(/);
    expect(params[0]).toContain("i");
    expect(params[0]).toContain(5);
  });

  it("keeps browser-observed posts out of the generic priority claim", async () => {
    const { sql, queries, params } = capture();
    await claimWatchlistLeadsForDrafting(sql, { agentInstanceId: "i", cap: 5 });
    expect(queries[0]).toContain("payload->>'source' is distinct from 'extension_observed'");
    expect(queries[0]).toContain("distinct on (cand.author_handle)");
    expect(queries[0]).toContain("a.status = 'pending'");
    expect(queries[0]).toContain("reply_requested");
    expect(params[0]).toContain("i");
    expect(params[0]).toContain(5);
  });
});
