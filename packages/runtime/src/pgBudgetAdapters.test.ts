// Union of the three per-app test files this module replaces:
//   apps/x-intern/src/lib/budget-adapters.test.ts        (6 cases — the richest)
//   apps/linkedin-intern/src/lib/budget-adapters.test.ts (3 cases, all subsumed)
//   apps/reddit-intern/src/lib/budget-adapters.test.ts   (byte-identical to linkedin's)
// plus new cases pinning the per-app exemption list, which is now a parameter.
import { describe, it, expect, vi } from "vitest";
import type { Sql } from "postgres";
import {
  createPgBudgetAdapters,
  resolveBudgetPeriod,
  CAP_EXEMPT_ENGINES_APIFY,
  CAP_EXEMPT_ENGINES_APIFY_XAPI,
} from "./pgBudgetAdapters.js";

function sqlReturning<T>(rows: T[]) {
  return vi.fn().mockResolvedValue(rows) as unknown as Sql;
}

/**
 * Capture the SQL template text AND the bound values of each tagged-template
 * call, so a test can assert which tables a query reads from and which engines
 * it exempts (the exemption list is a bound array parameter, not inline text).
 */
function sqlCapturing<T>(rows: T[]) {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const fn = vi.fn((strings: TemplateStringsArray, ...vals: unknown[]) => {
    queries.push(strings.join(" ? "));
    values.push(vals);
    return Promise.resolve(rows);
  });
  return { sql: fn as unknown as Sql, queries, values };
}

const APIFY_ONLY = { exemptEngines: CAP_EXEMPT_ENGINES_APIFY };
const APIFY_XAPI = { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI };

describe("cap exemption constants", () => {
  it("keeps each intern's list byte-for-byte what its own copy filtered", () => {
    // Lyra / Orion / Nova filtered `engine <> 'apify'`.
    // codex-cli joined both lists: it draws on a separate ChatGPT
    // subscription, so counting it against the Claude cap would make the
    // budget failover refuse the very call meant to route around the cap.
    expect([...CAP_EXEMPT_ENGINES_APIFY]).toEqual(["apify", "codex-cli"]);
    // Vega filtered `engine not in ('apify','xapi')` — one EXTRA exemption its
    // siblings never had. Flattening either way changes what trips a cap.
    expect([...CAP_EXEMPT_ENGINES_APIFY_XAPI]).toEqual(["apify", "xapi", "codex-cli"]);
  });
});

describe("createPgBudgetAdapters.fetchSpend", () => {
  it("returns 0 for every layer when no rows exist this month", async () => {
    const sql = sqlReturning([]);
    const adapters = createPgBudgetAdapters(sql, APIFY_ONLY);
    const snap = await adapters.fetchSpend({
      bucket: "drafter-codex",
      orgId: "org_1",
      instanceId: "inst_1",
    });
    expect(snap).toEqual({ bucket: 0, org: 0, instance: 0 });
  });

  it("returns per-role instance spend alongside the org and bucket sums", async () => {
    // The implementation issues one CTE query that returns
    // { bucket_cents, org_cents, instance_cents }. instance_cents is
    // summed from noelle.llm_calls filtered by the agent's instance, so a
    // per-agent cap (e.g. Vega's $25) is not compared against the whole org.
    const sql = sqlReturning([
      { bucket_cents: 540, org_cents: 1800, instance_cents: 420 },
    ]);
    const adapters = createPgBudgetAdapters(sql, APIFY_XAPI);
    const snap = await adapters.fetchSpend({
      bucket: "drafter-codex",
      orgId: "org_1",
      instanceId: "inst_1",
    });
    expect(snap.bucket).toBe(540);
    expect(snap.org).toBe(1800);
    expect(snap.instance).toBe(420);
  });

  it("reads all three layers from live llm_calls, not the lagged org_spend_month rollup", async () => {
    // Gap A: the org + bucket layers used to read noelle.org_spend_month,
    // which the sync-spend cron only rebuilds every 5 min — so a worker
    // could blow past the cap inside that window. Enforcement must read the
    // live per-call log instead. org_spend_month stays the dashboard source.
    const { sql, queries } = sqlCapturing([
      { bucket_cents: 1, org_cents: 2, instance_cents: 3 },
    ]);
    const adapters = createPgBudgetAdapters(sql, APIFY_ONLY);
    await adapters.fetchSpend({ bucket: "drafter-codex", orgId: "org_1", instanceId: "inst_1" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("noelle.llm_calls");
    expect(queries[0]).not.toContain("org_spend_month");
  });

  it("EXCLUDES engine='apify' from every cap layer so Apify never trips a limit", async () => {
    // Apify (the per-result data fetch) is recorded in noelle.llm_calls for
    // visibility but must NOT count toward any budget cap, or the data fetch
    // could starve the LLM budget and pause the pipeline. Both the org/bucket
    // rollup CTE and the per-instance sum must filter it, so $11 LLM + $5 Apify
    // reads as $11 at the cap.
    const { sql, queries, values } = sqlCapturing([
      { bucket_cents: 1, org_cents: 2, instance_cents: 3 },
    ]);
    const adapters = createPgBudgetAdapters(sql, APIFY_ONLY);
    await adapters.fetchSpend({ bucket: "drafter-codex", orgId: "org_1", instanceId: "inst_1" });
    expect(queries).toHaveLength(1);
    // The template is one string; count the filter to prove BOTH CTEs have it.
    const occurrences = queries[0]!.split("engine <> all(").length - 1;
    expect(occurrences).toBe(2);
    // ...and that both bind the apify-only list.
    const bound = values[0]!.filter((v) => Array.isArray(v));
    expect(bound).toEqual([["apify", "codex-cli"], ["apify", "codex-cli"]]);
  });

  it("ALSO excludes engine='xapi' for the X intern, and only for it", async () => {
    // Vega's copy filtered `engine not in ('apify','xapi')`; its siblings never
    // exempted xapi. Both lists must survive verbatim — a cap that starts
    // counting an engine it used to exempt pauses an agent.
    const x = sqlCapturing([{ bucket_cents: 1, org_cents: 2, instance_cents: 3 }]);
    await createPgBudgetAdapters(x.sql, APIFY_XAPI).fetchSpend({
      bucket: "drafter-codex",
      orgId: "org_1",
      instanceId: "inst_1",
    });
    expect(x.values[0]!.filter((v) => Array.isArray(v))).toEqual([
      ["apify", "xapi", "codex-cli"],
      ["apify", "xapi", "codex-cli"],
    ]);

    const other = sqlCapturing([{ bucket_cents: 1, org_cents: 2, instance_cents: 3 }]);
    await createPgBudgetAdapters(other.sql, APIFY_ONLY).fetchSpend({
      bucket: "drafter-codex",
      orgId: "org_1",
      instanceId: "inst_1",
    });
    for (const bound of other.values[0]!.filter((v): v is string[] => Array.isArray(v))) {
      expect(bound).not.toContain("xapi");
    }
  });

  it("counts every engine when the exemption list is empty", async () => {
    // `engine <> all('{}')` is true for every row, so an empty list exempts
    // nothing. No app passes one; this pins the semantics of the parameter.
    const { sql, values } = sqlCapturing([{ bucket_cents: 1, org_cents: 2, instance_cents: 3 }]);
    await createPgBudgetAdapters(sql, { exemptEngines: [] }).fetchSpend({
      bucket: "drafter-codex",
      orgId: "org_1",
      instanceId: "inst_1",
    });
    expect(values[0]!.filter((v) => Array.isArray(v))).toEqual([[], []]);
  });
});

describe("createPgBudgetAdapters.fetchCaps", () => {
  it("returns Number.MAX_SAFE_INTEGER for every layer when caps are null", async () => {
    const sql = sqlReturning([{ instance_cap: null, org_cap_sum: null }]);
    const adapters = createPgBudgetAdapters(sql, APIFY_ONLY);
    const caps = await adapters.fetchCaps({
      bucket: "drafter-codex",
      orgId: "org_1",
      instanceId: "inst_1",
    });
    expect(caps).toEqual({
      bucket: Number.MAX_SAFE_INTEGER,
      org: Number.MAX_SAFE_INTEGER,
      instance: Number.MAX_SAFE_INTEGER,
    });
  });

  it("treats org_cap_sum = 0 as 'no cap configured', not '0 cents allowed'", async () => {
    const sql = sqlReturning([{ instance_cap: null, org_cap_sum: 0 }]);
    const caps = await createPgBudgetAdapters(sql, APIFY_ONLY).fetchCaps({
      bucket: "drafter-codex",
      orgId: "org_1",
      instanceId: "inst_1",
    });
    expect(caps.org).toBe(Number.MAX_SAFE_INTEGER);
    expect(caps.bucket).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("uses agent_instances.budget_cap_cents for instance + sum for org", async () => {
    const sql = sqlReturning([{ instance_cap: 10000, org_cap_sum: 30000 }]);
    const adapters = createPgBudgetAdapters(sql, APIFY_ONLY);
    const caps = await adapters.fetchCaps({
      bucket: "drafter-codex",
      orgId: "org_1",
      instanceId: "inst_1",
    });
    expect(caps.instance).toBe(10000);
    expect(caps.org).toBe(30000);
    // Bucket caps are not modelled in 0.0.1 — same value as org.
    expect(caps.bucket).toBe(30000);
  });
});

describe("budget period window", () => {
  const withEnv = async (val: string | undefined, fn: () => Promise<void> | void) => {
    const prev = process.env.NOELLE_BUDGET_PERIOD;
    if (val === undefined) delete process.env.NOELLE_BUDGET_PERIOD;
    else process.env.NOELLE_BUDGET_PERIOD = val;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.NOELLE_BUDGET_PERIOD;
      else process.env.NOELLE_BUDGET_PERIOD = prev;
    }
  };

  it("defaults to month, so an unset env changes nothing", async () => {
    await withEnv(undefined, () => {
      expect(resolveBudgetPeriod()).toBe("month");
    });
  });

  it("NOELLE_BUDGET_PERIOD=week selects the weekly window", async () => {
    await withEnv("week", () => {
      expect(resolveBudgetPeriod()).toBe("week");
    });
  });

  it("falls back to month on an unrecognised env value", async () => {
    // A typo in ops config must not take the workers down, and the wider
    // window is the fail-safe direction: it never blocks work month already allowed.
    await withEnv("fortnight", () => {
      expect(resolveBudgetPeriod()).toBe("month");
    });
  });

  it("an explicit option beats the env", async () => {
    await withEnv("week", () => {
      expect(resolveBudgetPeriod("month")).toBe("month");
    });
  });

  it("binds the period into BOTH spend windows, as a parameter not inline text", async () => {
    // Both layers must measure the same window; a mismatch would compare an
    // instance's weekly spend against the org's monthly total.
    const { sql, queries, values } = sqlCapturing([
      { bucket_cents: 0, org_cents: 0, instance_cents: 0 },
    ]);
    const adapters = createPgBudgetAdapters(sql, { ...APIFY_ONLY, period: "week" });
    await adapters.fetchSpend({ bucket: "drafter", orgId: "o", instanceId: "i" });
    const q = queries[0]!;
    expect(q).toContain("date_trunc(");
    expect(q).not.toContain("'month'");
    expect(q).not.toContain("'week'");
    expect(values[0]!.filter((v) => v === "week")).toHaveLength(2);
  });

  it("still binds month when nothing asks for week", async () => {
    const { sql, values } = sqlCapturing([
      { bucket_cents: 0, org_cents: 0, instance_cents: 0 },
    ]);
    const adapters = createPgBudgetAdapters(sql, { ...APIFY_ONLY, period: "month" });
    await adapters.fetchSpend({ bucket: "drafter", orgId: "o", instanceId: "i" });
    expect(values[0]!.filter((v) => v === "month")).toHaveLength(2);
  });
});

describe("temporary cap pause", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const caps = (paused: unknown) =>
    sqlReturning([{ instance_cap: 25_000, org_cap_sum: 50_000, paused_until: paused }]);

  it("lifts every layer while the pause is in the future", async () => {
    const future = new Date(Date.now() + 60 * 60_000);
    const a = createPgBudgetAdapters(caps(future), APIFY_ONLY);
    const got = await a.fetchCaps({ bucket: "drafter", orgId: "o", instanceId: "i" });
    expect(got).toEqual({ bucket: MAX, org: MAX, instance: MAX });
  });

  it("enforces again once the pause has passed — it expires itself", async () => {
    const past = new Date(Date.now() - 1_000);
    const a = createPgBudgetAdapters(caps(past), APIFY_ONLY);
    const got = await a.fetchCaps({ bucket: "drafter", orgId: "o", instanceId: "i" });
    expect(got).toEqual({ bucket: 50_000, org: 50_000, instance: 25_000 });
  });

  it("enforces when no pause is set", async () => {
    const a = createPgBudgetAdapters(caps(null), APIFY_ONLY);
    const got = await a.fetchCaps({ bucket: "drafter", orgId: "o", instanceId: "i" });
    expect(got.org).toBe(50_000);
  });

  it("enforces when the timestamp is unparseable, rather than failing open", async () => {
    const a = createPgBudgetAdapters(caps("not a date"), APIFY_ONLY);
    const got = await a.fetchCaps({ bucket: "drafter", orgId: "o", instanceId: "i" });
    expect(got.org).toBe(50_000);
  });

  it("reads an absent pause through schema-safe JSON without retrying errors", async () => {
    const { sql, queries } = sqlCapturing([{ instance_cap: 25_000, org_cap_sum: 50_000 }]);
    const a = createPgBudgetAdapters(sql, APIFY_ONLY);
    const got = await a.fetchCaps({ bucket: "drafter", orgId: "o", instanceId: "i" });
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("to_jsonb(o)");
    expect(got).toEqual({ bucket: 50_000, org: 50_000, instance: 25_000 });
  });
});
