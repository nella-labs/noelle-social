import { describe, it, expect, vi } from "vitest";

// Mock the SQL client + tenancy + supabase + auth-cookie before importing
// queries.ts. queries.ts uses module-level singletons, so we need to mock
// them at import time.

vi.mock("@/lib/db", () => {
  const query = vi.fn();
  return {
    sql: query,
    readSql: query,
    pgOrgMembersClient: () => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { user_id: "user_1" },
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: "user_1" } }, error: null }),
    },
  }),
}));

vi.mock("@/lib/auth-cookie", () => ({
  getUserFromCookies: async () => ({ id: "user_1", email: "user_1@example.com" }),
}));

vi.mock("@noelle/runtime", () => ({
  assertOrgMember: async () => {},
}));

// Importing AFTER the mocks so the module sees the fakes.
import {
  getOrgSpendForMonth,
  getOrgSpendByBucketRange,
  isApifyBucket,
  resolveSpendRange,
} from "./queries";
import { sql } from "./db";

describe("getOrgSpendForMonth", () => {
  it("queries noelle.org_spend_month scoped to (org_id, month)", async () => {
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { org_id: "org_1", month: "2026-05-01", bucket: "drafter-codex", cents: 540 },
      { org_id: "org_1", month: "2026-05-01", bucket: "classifier", cents: 12 },
    ]);
    const rows = await getOrgSpendForMonth("org_1", "2026-05-01");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.bucket).toBe("drafter-codex");
    expect(rows[0]?.cents).toBe(540);

    const callArgs = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const values = callArgs.slice(1);
    expect(values).toContain("org_1");
    expect(values).toContain("2026-05-01");
  });

  it("returns an empty array when the org has no spend rows for the month", async () => {
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const rows = await getOrgSpendForMonth("org_1", "2026-05-01");
    expect(rows).toEqual([]);
  });

  it("coerces bigint cents (returned as strings by postgres.js) to numbers", async () => {
    // org_spend_month.cents is a BIGINT — postgres.js hands these back as
    // STRINGS. The previous test mocked numbers and so never caught that
    // `acc + row.cents` would string-concatenate in prod. Mock the real shape.
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { org_id: "org_1", month: "2026-05-01", bucket: "profiler-codex", cents: "3" },
      { org_id: "org_1", month: "2026-05-01", bucket: "classifier", cents: "70" },
      { org_id: "org_1", month: "2026-05-01", bucket: "drafter", cents: "41" },
      { org_id: "org_1", month: "2026-05-01", bucket: "drafter-codex", cents: "280" },
    ]);
    const rows = await getOrgSpendForMonth("org_1", "2026-05-01");
    for (const r of rows) expect(typeof r.cents).toBe("number");
    // Sum must be 394 ($3.94), never the concatenation 37041280 ($370412.80).
    expect(rows.reduce((acc, r) => acc + (r.cents ?? 0), 0)).toBe(394);
  });
});

describe("resolveSpendRange", () => {
  // Fixed "now": 15 Aug 2026 — in Q3 (Jul–Sep), so month/quarter starts differ.
  const now = new Date("2026-08-15T12:00:00.000Z");

  it("defaults to month (to-date) for missing/unknown keys", () => {
    for (const key of [undefined, "", "bogus"]) {
      const r = resolveSpendRange(key, now);
      expect(r.key).toBe("month");
      expect(r.startIso).toBe("2026-08-01T00:00:00.000Z");
      expect(r.granularity).toBe("day");
    }
  });

  it("quarter starts at the first day of the current quarter, daily granularity", () => {
    const r = resolveSpendRange("quarter", now);
    expect(r).toMatchObject({ key: "quarter", startIso: "2026-07-01T00:00:00.000Z", granularity: "day" });
  });

  it("year starts on Jan 1, monthly granularity (keeps a year of bars readable)", () => {
    const r = resolveSpendRange("year", now);
    expect(r).toMatchObject({ key: "year", startIso: "2026-01-01T00:00:00.000Z", granularity: "month" });
  });

  it("all-time uses a pre-history floor + monthly granularity", () => {
    const r = resolveSpendRange("all", now);
    expect(r).toMatchObject({ key: "all", startIso: "2000-01-01T00:00:00.000Z", granularity: "month" });
  });
});

describe("getOrgSpendByBucketRange", () => {
  it("sums real per-call cents by bucket over the range and coerces bigint strings", async () => {
    (sql as unknown as ReturnType<typeof vi.fn>).mockResolvedValue([
      { bucket: "apify-discovery", cents: "140229" },
      { bucket: "drafter", cents: "10746" },
    ]);
    const rows = await getOrgSpendByBucketRange("org_1", "2026-01-01T00:00:00.000Z");
    expect(rows).toEqual([
      { bucket: "apify-discovery", cents: 140229 },
      { bucket: "drafter", cents: 10746 },
    ]);
    for (const r of rows) expect(typeof r.cents).toBe("number");
    // The org + the range's start bound are both passed to the query. (The sql
    // mock is shared across tests, so assert on THIS query's call — the last one.)
    const values = (sql as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)!.slice(1);
    expect(values).toContain("org_1");
    expect(values).toContain("2026-01-01T00:00:00.000Z");
  });
});

describe("isApifyBucket", () => {
  it("matches apify-<worker> buckets and nothing else", () => {
    expect(isApifyBucket("apify-drafter")).toBe(true);
    expect(isApifyBucket("apify-discovery")).toBe(true);
    expect(isApifyBucket("apify")).toBe(true);
    expect(isApifyBucket("drafter-codex")).toBe(false);
    expect(isApifyBucket("classifier")).toBe(false);
    expect(isApifyBucket(null)).toBe(false);
    expect(isApifyBucket(undefined)).toBe(false);
  });
});
