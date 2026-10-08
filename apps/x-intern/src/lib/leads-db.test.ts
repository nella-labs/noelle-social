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
