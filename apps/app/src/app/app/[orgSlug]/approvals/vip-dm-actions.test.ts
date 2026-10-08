import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgMembershipError } from "@noelle/runtime";

// ---------------------------------------------------------------------------
// parkVipIntroDm turns a VIP scout's precomputed intro DM
// (noelle.leads.vip_signal.suggested_dm) into a parked kind='dm' draft so it
// shows in the inbox under "DMs On". These tests mock the SQL client + org/auth
// queries to assert: the DM body is read server-side from the lead (never the
// client), the parked draft is kind='dm' + source='vip_intro_dm' (so the DMs On
// filter `payload->>'kind'='dm'` surfaces it), re-parking is idempotent, a lead
// with no scout DM is refused, a cross-tenant approval id resolves to nothing,
// and a non-member is forbidden.
// ---------------------------------------------------------------------------

interface Captured {
  text: string;
  values: unknown[];
}
let queries: Captured[] = [];

// Programmable read results, tweaked per-test.
let approvalRow: {
  lead_id: string;
  agent_instance_id: string;
  vip_signal: unknown;
} | null = null;
let existingDm: Array<{ one: number }> = [];
let orgThrows = false;

function reconstruct(strings: TemplateStringsArray, exprs: unknown[]): Captured {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < exprs.length) text += ` $${i} `;
  }
  return { text: text.replace(/\s+/g, " ").trim(), values: exprs };
}

function tag(strings: TemplateStringsArray | unknown, ...exprs: unknown[]): unknown {
  if (Array.isArray((strings as TemplateStringsArray)?.raw)) {
    const q = reconstruct(strings as TemplateStringsArray, exprs);
    queries.push(q);
    if (/from noelle\.approvals a join noelle\.leads/.test(q.text)) {
      return Promise.resolve(approvalRow ? [approvalRow] : []);
    }
    if (/select 1 as one from noelle\.drafts/.test(q.text)) {
      return Promise.resolve(existingDm);
    }
    return Promise.resolve([]);
  }
  // sql(obj, ...cols) column helper — unused by these inserts.
  return { __cols: true };
}
(tag as unknown as { json: (v: unknown) => unknown }).json = (v) => v;

vi.mock("@/lib/db", () => ({ sql: tag }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => ({ id: "user_1", email: "u@example.com" }),
  getOrgBySlug: async (slug: string) => {
    if (orgThrows) throw new OrgMembershipError("user_1", "org_1");
    return slug === "operator" ? { id: "org_1", slug: "operator" } : null;
  },
}));

const { parkVipIntroDm } = await import("./vip-dm-actions");

const BASE = {
  orgSlug: "operator",
  approvalId: "11111111-1111-1111-1111-111111111111",
};

beforeEach(() => {
  queries = [];
  existingDm = [];
  orgThrows = false;
  approvalRow = {
    lead_id: "lead_1",
    agent_instance_id: "inst_1",
    vip_signal: {
      vip: true,
      reason: "YC visiting partner",
      tags: ["yc-founder"],
      add_to_watchlist: true,
      dm_soon: true,
      suggested_dm: "Excited to see S26 kicking off — would love to grab a quick call.",
    },
  };
});
afterEach(() => vi.clearAllMocks());

describe("parkVipIntroDm", () => {
  it("parks the scout DM as a kind='dm' draft + pending approval scoped to the lead's org/instance", async () => {
    const res = await parkVipIntroDm(BASE);
    expect(res).toEqual({ ok: true, already: false });

    const draftInsert = queries.find((q) => /insert into noelle\.drafts/.test(q.text));
    expect(draftInsert).toBeTruthy();
    // The payload is passed via sql.json() — it's one of the bound values.
    const payload = draftInsert!.values.find(
      (v): v is Record<string, unknown> =>
        typeof v === "object" && v !== null && "kind" in v,
    );
    expect(payload).toMatchObject({
      kind: "dm",
      angle: null,
      source: "vip_intro_dm",
      body: "Excited to see S26 kicking off — would love to grab a quick call.",
    });
    // The body is the scout's text, read server-side — verbatim from vip_signal.
    expect(draftInsert!.values).toContain("lead_1");

    const approvalInsert = queries.find((q) => /insert into noelle\.approvals/.test(q.text));
    expect(approvalInsert).toBeTruthy();
    expect(approvalInsert!.values).toContain("org_1");
    expect(approvalInsert!.values).toContain("inst_1");
    expect(approvalInsert!.values).toContain("lead_1");
  });

  it("is idempotent: a second park no-ops when a vip_intro_dm draft already exists", async () => {
    existingDm = [{ one: 1 }];
    const res = await parkVipIntroDm(BASE);
    expect(res).toEqual({ ok: true, already: true });
    expect(queries.some((q) => /insert into/.test(q.text))).toBe(false);
  });

  it("refuses a lead whose scout did not warrant a DM (no suggested_dm)", async () => {
    approvalRow!.vip_signal = {
      vip: true,
      reason: "engage with a public reply",
      tags: [],
      add_to_watchlist: false,
      dm_soon: false,
      suggested_dm: null,
    };
    const res = await parkVipIntroDm(BASE);
    expect(res).toEqual({ ok: false, error: "no_dm" });
    expect(queries.some((q) => /insert into/.test(q.text))).toBe(false);
  });

  it("returns not_found for a cross-tenant / unknown approval id (resolves to no row)", async () => {
    approvalRow = null;
    const res = await parkVipIntroDm(BASE);
    expect(res).toEqual({ ok: false, error: "not_found" });
    expect(queries.some((q) => /insert into/.test(q.text))).toBe(false);
  });

  it("forbids a non-member (getOrgBySlug throws OrgMembershipError)", async () => {
    orgThrows = true;
    const res = await parkVipIntroDm(BASE);
    expect(res).toEqual({ ok: false, error: "forbidden" });
    expect(queries.some((q) => /insert into/.test(q.text))).toBe(false);
  });
});
