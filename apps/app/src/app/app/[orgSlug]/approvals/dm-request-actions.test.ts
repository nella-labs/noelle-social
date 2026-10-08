import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgMembershipError } from "@noelle/runtime";

// requestDmForLead flags the lead behind a specific approval for a one-off DM
// (payload.dm_requested), scoped to the caller's org. These tests mock the SQL
// client + org/auth so we assert: it targets the approval's lead org-scoped, it
// returns no_post when nothing matched (missing post text / cross-tenant id), a
// non-member is forbidden, an unknown slug is not_found, and no user is
// unauthenticated.

interface Captured {
  text: string;
  values: unknown[];
}
let queries: Captured[] = [];
let updateResult: Array<{ id: string }> = [];
let orgThrows = false;
let user: { id: string } | null = { id: "user_1" };

function reconstruct(strings: TemplateStringsArray, exprs: unknown[]): Captured {
  let text = "";
  for (let i = 0; i < strings.length; i++) {
    text += strings[i];
    if (i < exprs.length) text += ` $${i} `;
  }
  return { text: text.replace(/\s+/g, " ").trim(), values: exprs };
}

function tag(strings: TemplateStringsArray | unknown, ...exprs: unknown[]): unknown {
  const q = reconstruct(strings as TemplateStringsArray, exprs);
  queries.push(q);
  if (/update noelle\.leads l .* from noelle\.approvals a/.test(q.text)) {
    return Promise.resolve(updateResult);
  }
  return Promise.resolve([]);
}

vi.mock("@/lib/db", () => ({ sql: tag }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => user,
  getOrgBySlug: async (slug: string) => {
    if (orgThrows) throw new OrgMembershipError("user_1", "org_1");
    return slug === "operator" ? { id: "org_1", slug: "operator" } : null;
  },
}));

const { requestDmForLead } = await import("./dm-request-actions");

const BASE = { orgSlug: "operator", approvalId: "11111111-1111-1111-1111-111111111111" };

beforeEach(() => {
  queries = [];
  updateResult = [{ id: "lead_1" }];
  orgThrows = false;
  user = { id: "user_1" };
});
afterEach(() => vi.clearAllMocks());

describe("requestDmForLead", () => {
  it("flags the lead behind the approval, org-scoped, and revalidates", async () => {
    const res = await requestDmForLead(BASE);
    expect(res).toEqual({ ok: true });
    const upd = queries.find((q) => /update noelle\.leads/.test(q.text));
    expect(upd).toBeTruthy();
    expect(upd!.text).toContain("dm_requested");
    // org-scoped on BOTH the approval and the lead, and keyed by the approval id.
    expect(upd!.values).toContain("org_1");
    expect(upd!.values).toContain(BASE.approvalId);
  });

  it("returns no_post when nothing matched (no post text / cross-tenant approval id)", async () => {
    updateResult = [];
    expect(await requestDmForLead(BASE)).toEqual({ ok: false, error: "no_post" });
  });

  it("forbids a non-member (getOrgBySlug throws OrgMembershipError) and writes nothing", async () => {
    orgThrows = true;
    expect(await requestDmForLead(BASE)).toEqual({ ok: false, error: "forbidden" });
    expect(queries.some((q) => /update/.test(q.text))).toBe(false);
  });

  it("returns not_found for an unknown org slug", async () => {
    expect(await requestDmForLead({ ...BASE, orgSlug: "nope" })).toEqual({
      ok: false,
      error: "not_found",
    });
  });

  it("returns unauthenticated when there is no signed-in user", async () => {
    user = null;
    expect(await requestDmForLead(BASE)).toEqual({ ok: false, error: "unauthenticated" });
    expect(queries.some((q) => /update/.test(q.text))).toBe(false);
  });
});
