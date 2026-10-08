import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// The LinkedIn watchlist actions add/remove/objective-edit people on Lyra's
// noelle.linkedin_watchlist_people. These tests mock the SQL client + org/auth
// queries to assert: public_id normalisation on add, that writes are gated to a
// linkedin_intern instance in the caller's org (tenancy / role guard), and that
// remove/objective target the right rows.
// ---------------------------------------------------------------------------

interface Captured {
  text: string;
  values: unknown[];
}
let queries: Captured[] = [];
// What getAgentInstance returns. Tweak per-test for role/tenancy cases.
let instanceRole = "linkedin_intern";
let instanceOrg = "org_1";

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
    queries.push(reconstruct(strings as TemplateStringsArray, exprs));
    return Promise.resolve([]);
  }
  return { __cols: true };
}

vi.mock("@/lib/db", () => ({ sql: tag }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => ({ id: "user_1", email: "u@example.com" }),
  getOrgBySlug: async (slug: string) =>
    slug === "operator" ? { id: "org_1", slug: "operator" } : null,
  getAgentInstance: async (id: string) => ({ id, org_id: instanceOrg, role: instanceRole }),
}));

const {
  addLinkedInWatchlistPerson,
  removeLinkedInWatchlistPerson,
  setLinkedInWatchlistPersonObjective,
} = await import("./linkedin-watchlist-actions");

const BASE = { orgSlug: "operator", instanceId: "11111111-1111-1111-1111-111111111111" };

beforeEach(() => {
  queries = [];
  instanceRole = "linkedin_intern";
  instanceOrg = "org_1";
});
afterEach(() => vi.clearAllMocks());

describe("addLinkedInWatchlistPerson", () => {
  it("normalises a full profile URL to its public_id and inserts (slug as the bootstrap key)", async () => {
    const res = await addLinkedInWatchlistPerson({
      ...BASE,
      publicId: "https://www.linkedin.com/in/Jane-Doe/",
      objective: "build a relationship",
    });
    expect(res.ok).toBe(true);

    const insert = queries.find((q) => /insert into noelle.linkedin_watchlist_people/.test(q.text));
    expect(insert).toBeTruthy();
    // fsd_profile_id + public_id both bootstrapped to the normalised slug.
    expect(insert!.values).toContain("jane-doe");
    expect(insert!.values).toContain("build a relationship");
    expect(insert!.values).not.toContain("https://www.linkedin.com/in/Jane-Doe/");
  });

  it("rejects a reference that yields no slug (no /in/ segment) without writing", async () => {
    const res = await addLinkedInWatchlistPerson({
      ...BASE,
      publicId: "https://www.linkedin.com/company/acme",
    });
    expect(res).toEqual({ ok: false, error: "invalid" });
    expect(queries.some((q) => /insert into/.test(q.text))).toBe(false);
  });

  it("refuses to write to a non-linkedin_intern instance (role guard)", async () => {
    instanceRole = "x_intern";
    const res = await addLinkedInWatchlistPerson({ ...BASE, publicId: "jane-doe" });
    expect(res).toEqual({ ok: false, error: "not_found" });
    expect(queries.some((q) => /insert into/.test(q.text))).toBe(false);
  });

  it("refuses an instance in a different org (tenancy guard)", async () => {
    instanceOrg = "org_2";
    const res = await addLinkedInWatchlistPerson({ ...BASE, publicId: "jane-doe" });
    expect(res).toEqual({ ok: false, error: "not_found" });
    expect(queries.some((q) => /insert into/.test(q.text))).toBe(false);
  });
});

describe("removeLinkedInWatchlistPerson", () => {
  it("deletes the row scoped to org + instance", async () => {
    const res = await removeLinkedInWatchlistPerson({
      ...BASE,
      rowId: "99999999-9999-9999-9999-999999999999",
    });
    expect(res.ok).toBe(true);
    const del = queries.find((q) => /delete from noelle.linkedin_watchlist_people/.test(q.text));
    expect(del).toBeTruthy();
    expect(del!.values).toContain("99999999-9999-9999-9999-999999999999");
  });
});

describe("setLinkedInWatchlistPersonObjective", () => {
  it("updates the objective; an empty string clears it to null", async () => {
    await setLinkedInWatchlistPersonObjective({
      ...BASE,
      rowId: "99999999-9999-9999-9999-999999999999",
      objective: "   ",
    });
    const upd = queries.find((q) => /update noelle.linkedin_watchlist_people/.test(q.text));
    expect(upd).toBeTruthy();
    // Blank objective is stored as null, not whitespace.
    expect(upd!.values).toContain(null);
  });
});
