import { describe, expect, it, vi } from "vitest";
import {
  upsertDiscoveredLead,
  claimLeadsForClassification,
  claimLeadsForDrafting,
  claimWatchlistLeadsForDrafting,
  reapStaleClaims,
  claimReplyRequestLeads,
  expireStaleClassifiedLeads,
  markLeadStatus,
  supersedeOlderPriorityLeads,
  claimObservedLeadsForClassification,
  claimObservedLeadsForDrafting,
} from "./leads-db.js";

describe("leads-db", () => {
  it("claims browser observations separately from legacy new leads", async () => {
    let query = "";
    const values: unknown[] = [];
    const sql = vi.fn(async (parts: TemplateStringsArray, ...params: unknown[]) => {
      query = parts.join("?");
      values.push(...params);
      return [{ id: "lead" }];
    }) as never;
    const rows = await claimObservedLeadsForClassification(sql, {
      orgId: "org", agentInstanceId: "instance", batch: 1,
    });
    expect(rows).toHaveLength(1);
    expect(query).toContain("status = 'observed'");
    expect(query).toContain("status = 'observed_classifying'");
    expect(query).toContain("payload->>'source' = 'extension_observed'");
    expect(query).toContain("for update skip locked");
    expect(values).toEqual(expect.arrayContaining(["org", "instance", 1]));
  });

  it("locks browser capacity before bounded qualification and evidence reads", async () => {
    const queries: string[] = [];
    const params: unknown[] = [];
    const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
      const query = parts.join("?");
      queries.push(query);
      params.push(...values);
      if (query.includes("select org_id")) return [{ org_id: "org" }];
      return [];
    }), { begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql), json: (value: unknown) => value }) as never;

    expect(await claimObservedLeadsForDrafting(sql, { agentInstanceId: "instance", cap: 5 })).toEqual([]);

    expect(queries[0]).toContain("lock_timeout");
    expect(queries[1]).toContain("pg_advisory_xact_lock");
    expect(queries.find((q) => q.includes("select l.id, l.payload")) ?? "").toContain("l.status = 'drafting'");
    expect(queries.join("\n")).toContain("->'verifier_meta'->'pass' = 'true'::jsonb");
    expect(queries.join("\n")).toContain("->'verifier_meta'->'judgeOk' = 'true'::jsonb");
    expect(queries.join("\n")).toContain("->'human_review_required' is distinct from 'true'::jsonb");
    expect(queries.find((q) => q.includes("with newest as")) ?? "").toContain("payload->'classifier'->>'judge' = 'jev'");
    expect(queries.find((q) => q.includes("with newest as")) ?? "").toContain("payload->>'reply_requested' is distinct from 'true'");
    expect(queries.find((q) => q.includes("with newest as")) ?? "").toContain("for update of l skip locked");
    expect(queries.find((q) => q.includes("with newest as")) ?? "").toContain("limit 200");
    expect(params).toContain("x-observed:instance");
  });

  it("does not claim browser leads when all twelve active slots are occupied", async () => {
    const queries: string[] = [];
    const sql = Object.assign(vi.fn(async (parts: TemplateStringsArray) => {
      const query = parts.join("?");
      queries.push(query);
      if (query.includes("select org_id")) return [{ org_id: "org" }];
      if (query.includes("select l.id, l.payload")) return Array.from({ length: 12 }, (_, i) => ({ id: String(i) }));
      return [];
    }), { begin: async (run: (tx: unknown) => Promise<unknown>) => run(sql) }) as never;

    expect(await claimObservedLeadsForDrafting(sql, { agentInstanceId: "instance", cap: 12 })).toEqual([]);
    expect(queries.some((q) => q.includes("with newest as"))).toBe(false);
  });

  it("upsertDiscoveredLead calls insert ... on conflict do nothing returning id", async () => {
    const fragments: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        fragments.push(strings.join("?"));
        return [{ id: "lead-1", inserted: true }];
      }),
      { unsafe: vi.fn(), json: (x: unknown) => x },
    ) as never;
    const res = await upsertDiscoveredLead(sql, {
      orgId: "o",
      agentInstanceId: "i",
      platform: "x",
      externalId: "ext1",
      authorHandle: "u",
      authorId: "uid",
      payload: { foo: 1 },
      postedAt: "2026-05-18T00:00:00.000Z",
      priority: false,
    });
    expect(res.inserted).toBe(true);
    expect(fragments[0]).toMatch(/insert into noelle\.leads/);
    // priority is written as a column (not a stray value — regression for the
    // old 8-column / 9-value arity bug).
    expect(fragments[0]).toMatch(/priority/);
    // on re-seen tweet, priority is UPGRADED false→true (not do-nothing).
    expect(fragments[0]).toMatch(/on conflict \(org_id, platform, external_id\) do update/);
    expect(fragments[0]).toMatch(/set priority = true/);
  });

  it("claimLeadsForClassification returns rows", async () => {
    const sql = Object.assign(
      vi.fn(async () => [{ id: "L1", payload: {} }]),
      { unsafe: vi.fn() },
    ) as never;
    const out = await claimLeadsForClassification(sql, {
      orgId: "o",
      agentInstanceId: "i",
      batch: 5,
    });
    expect(out).toHaveLength(1);
  });

  it("claimLeadsForDrafting calls the SQL function noelle.claim_leads_for_drafting", async () => {
    const fragments: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        fragments.push(strings.join("?"));
        return [{ id: "L1" }];
      }),
      { unsafe: vi.fn() },
    ) as never;
    await claimLeadsForDrafting(sql, { agentInstanceId: "i", batch: 3 });
    expect(fragments[0]).toMatch(/claim_leads_for_drafting/);
  });

  it("claimLeadsForDrafting passes the age ceiling as the 3rd RPC arg", async () => {
    const params: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        params.push(vals);
        return [{ id: "L1" }];
      }),
      { unsafe: vi.fn() },
    ) as never;
    await claimLeadsForDrafting(sql, { agentInstanceId: "i", batch: 3, maxAgeHours: 48 });
    expect(params[0]).toContain(48);
  });

  it("claimLeadsForDrafting sends null age when unset (legacy no-filter behavior)", async () => {
    const params: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        params.push(vals);
        return [{ id: "L1" }];
      }),
      { unsafe: vi.fn() },
    ) as never;
    await claimLeadsForDrafting(sql, { agentInstanceId: "i", batch: 3 });
    expect(params[0]).toContain(null);
  });

  it("claimWatchlistLeadsForDrafting passes the age ceiling as the 3rd RPC arg", async () => {
    const params: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        params.push(vals);
        return [{ id: "L1" }];
      }),
      { unsafe: vi.fn() },
    ) as never;
    await claimWatchlistLeadsForDrafting(sql, { agentInstanceId: "i", cap: 100, maxAgeHours: 48 });
    expect(params[0]).toContain(48);
  });
});

describe("expireStaleClassifiedLeads", () => {
  function captureSql() {
    const fragments: string[] = [];
    const params: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        fragments.push(strings.join("?"));
        params.push(vals);
        return [{ id: "L1" }, { id: "L2" }];
      }),
      { unsafe: vi.fn(), json: (x: unknown) => x },
    ) as never;
    return { sql, fragments, params };
  }

  it("skips classified leads whose target tweet aged past the ceiling", async () => {
    const { sql, fragments, params } = captureSql();
    const n = await expireStaleClassifiedLeads(sql, { agentInstanceId: "i", maxAgeHours: 48 });
    expect(n).toBe(2);
    expect(fragments.join("\n")).toMatch(/set status = 'skipped'/);
    expect(fragments.join("\n")).toMatch(/status = 'classified'/);
    // EXPIRE = OLDER-than: binds `< now() - interval` (the opposite of the
    // keep-fresh claim's `>=`); fail-open regex-guards the cast on undateable rows.
    expect(fragments.join("\n")).toMatch(/< \?/);
    expect(fragments.join("\n")).toMatch(/pg_input_is_valid/);
    expect(params.some((p) => p.includes(48))).toBe(true);
  });

  it("leaves explicit reply requests out of the age sweep", async () => {
    const { sql, fragments } = captureSql();

    await expireStaleClassifiedLeads(sql, { agentInstanceId: "i", maxAgeHours: 48 });

    expect(fragments.join("\n")).toMatch(/payload->>'reply_requested' is distinct from 'true'/);
  });

  it("leaves browser-observed leads out of the legacy age sweep", async () => {
    const { sql, fragments } = captureSql();
    await expireStaleClassifiedLeads(sql, { agentInstanceId: "i", maxAgeHours: 48 });
    expect(fragments.join("\n")).toContain("payload->>'source' is distinct from 'extension_observed'");
  });

  it("is a no-op (no query) when the ceiling is 0 / disabled", async () => {
    const { sql, fragments } = captureSql();
    const n = await expireStaleClassifiedLeads(sql, { agentInstanceId: "i", maxAgeHours: 0 });
    expect(n).toBe(0);
    expect(fragments.length).toBe(0);
  });
});

describe("reapStaleClaims", () => {
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

  it("requeues stale explicit reply requests instead of expiring them", async () => {
    const { sql, fragments } = captureSql();

    await reapStaleClaims(sql, {
      agentInstanceId: "i",
      claimedStatus: "drafting",
      requeueStatus: "classified",
    });

    expect(fragments[0]).toMatch(/payload->>'reply_requested' = 'true'/);
    expect(fragments[1]).toMatch(/payload->>'reply_requested' is distinct from 'true'/);
  });

  it("retains orphaned browser observations for Jev outage recovery without an expiry horizon", async () => {
    const { sql, fragments } = captureSql();
    const out = await reapStaleClaims(sql, {
      agentInstanceId: "i", claimedStatus: "observed_classifying", requeueStatus: "observed",
    });
    expect(out).toEqual({ requeued: 1, expired: 0 });
    expect(fragments).toHaveLength(1);
    expect(fragments[0]).not.toContain("updated_at >= now()");
  });
});

describe("expireStaleClassifiedLeads — notification exemption", () => {
  // The cold-reply age ceiling is about not answering a stale STRANGER.
  // A notification lead is someone who replied to US, and answering them three
  // days later is an ordinary conversation. Applying the ceiling there made the
  // whole notifications lane dead on arrival (8/8 leads expired before drafting).
  it("excludes notification-source leads from the age sweep", async () => {
    const captured: string[] = [];
    const fake = (strings: TemplateStringsArray) => {
      captured.push(strings.join("?"));
      return Promise.resolve([]);
    };
    // the impl builds a jsonb marker via sql.json
    (fake as unknown as { json: (v: unknown) => unknown }).json = (v) => v;
    const sql = fake as never;
    await expireStaleClassifiedLeads(sql, { agentInstanceId: "i", maxAgeHours: 24 });
    const q = captured.join("\n");
    expect(q).toContain("'notification'");
    // The exemption must be BOUNDED. An unbounded one would leave a months-old
    // mention eligible forever, and unattended sending would answer it.
    // The notification lane's bound comes from NOTIFICATION_MAX_AGE_HOURS now,
    // interpolated as make_interval rather than a literal, so a change to the
    // shared constant cannot leave this predicate behind.
    expect(q).toContain("make_interval(hours =>");
    // ...and it still filters on age for everything else.
    expect(q).toContain("posted_at");
  });

  it("still no-ops when the ceiling is disabled", async () => {
    const sql = (() => Promise.resolve([])) as never;
    expect(await expireStaleClassifiedLeads(sql, { agentInstanceId: "i", maxAgeHours: 0 })).toBe(0);
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

describe("markLeadStatus — reply request lifecycle", () => {
  function captureSql() {
    const fragments: string[] = [];
    const params: unknown[][] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray, ...vals: unknown[]) => {
        fragments.push(strings.join("?"));
        params.push(vals);
        return [];
      }),
      { unsafe: vi.fn(), json: (x: unknown) => x },
    ) as never;
    return { sql, fragments, params };
  }

  it("clears an explicit reply request only when the lead reaches a terminal status", async () => {
    const terminal = captureSql();

    await markLeadStatus(terminal.sql, {
      leadId: "L1",
      status: "drafted",
      meta: { reply_request_key: "manual-1" },
    });

    expect(terminal.fragments[0]).toMatch(/payload \? 'reply_request'/);
    expect(terminal.fragments[0]).toMatch(/reply_requested/);

    const retry = captureSql();
    await markLeadStatus(retry.sql, {
      leadId: "L1",
      status: "classified",
      meta: { outbound_error: "api-vm 502" },
    });

    expect(retry.fragments[0]).toMatch(/payload \? 'reply_request'/);
    expect(retry.params[0]).toContain(false);
  });
});

describe("supersedeOlderPriorityLeads", () => {
  it("does not supersede an explicit reply request for the same watchlist author", async () => {
    const fragments: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        fragments.push(strings.join("?"));
        return [];
      }),
      { unsafe: vi.fn(), json: (x: unknown) => x },
    ) as never;

