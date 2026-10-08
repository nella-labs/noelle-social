import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrgMembershipError } from "@noelle/runtime";

// ---------------------------------------------------------------------------
// pauseAllSending is the org-wide panic stop: one UPDATE that flips
// reply_send_enabled=false on every intern currently ON. These tests mock the
// SQL client + org/auth queries to assert the write is hard-coded to `false`
// (never true), org-scoped + role-gated, idempotent, tenancy-guarded, and that
// the module exposes NO symmetric resume (the asymmetry is a safety rule).
// Deterministic: no Date.now, no network. Mirrors vip-dm-actions.test.ts.
// ---------------------------------------------------------------------------

interface Captured {
  text: string;
  values: unknown[];
}
let queries: Captured[] = [];

// Programmable UPDATE result (rows returned by `returning id`).
let updateRows: Array<{ id: string }> = [];
// Programmable auth.
let currentUser: { id: string } | null = { id: "user_1" };
let orgResult: { id: string; slug: string } | null = { id: "org-1", slug: "operator" };
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
    if (/update noelle\.agent_instances/.test(q.text)) {
      return Promise.resolve(updateRows);
    }
    return Promise.resolve([]);
  }
  // sql(INTERN_ROLES) column/array helper — not a template call.
  return { __cols: true };
}

vi.mock("@/lib/db", () => ({ sql: tag }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => currentUser,
  getOrgBySlug: async (slug: string) => {
    if (orgThrows) throw new OrgMembershipError("user_1", "org-1");
    return orgResult && slug === orgResult.slug ? orgResult : null;
  },
}));

const actions = await import("./actions");
const { pauseAllSending } = actions;
const { revalidatePath } = await import("next/cache");

const BASE = { orgSlug: "operator" };

beforeEach(() => {
  queries = [];
  updateRows = [{ id: "a" }, { id: "b" }];
  currentUser = { id: "user_1" };
  orgResult = { id: "org-1", slug: "operator" };
  orgThrows = false;
});
afterEach(() => vi.clearAllMocks());

describe("pauseAllSending", () => {
  it("flips reply_send_enabled=false, org- and role-scoped, gated on currently-on rows", async () => {
    const res = await pauseAllSending(BASE);
    expect(res).toEqual({ ok: true, paused: 2 });

    const update = queries.find((q) => /update noelle\.agent_instances/.test(q.text));
    expect(update).toBeTruthy();
    // The SET writes false — literally, never true.
    expect(update!.text).toMatch(/set send_enabled = false/);
    for (const flag of ["send_enabled", "reply_send_enabled", "auto_send_enabled", "x_api_write_enabled"]) {
      expect(update!.text).toContain(`${flag} = false`);
      expect(update!.text).toContain(`${flag} = true`);
    }
    expect(queries.filter((q) => /update noelle\.agent_instances/.test(q.text))).toHaveLength(1);
    expect(update!.text).not.toMatch(/set reply_send_enabled = true/);
    // Scoped by org_id (IDOR guard, bound to the resolved org) + role + gated
    // to only rows already ON (so `paused` is an honest count).
    expect(update!.text).toMatch(/org_id = /);
    expect(update!.text).toMatch(/role in /);
    expect(update!.text).toMatch(/reply_send_enabled = true/);
    expect(update!.values).toContain("org-1");
  });

  it("revalidates the agent page pattern, the org chart, and the approvals page", async () => {
    await pauseAllSending(BASE);
    expect(revalidatePath).toHaveBeenCalledWith(
      "/app/[orgSlug]/agents/[instanceId]",
      "page",
    );
    expect(revalidatePath).toHaveBeenCalledWith("/app/operator/org-chart");
    expect(revalidatePath).toHaveBeenCalledWith("/app/operator/approvals");
  });

  it("forbids a non-member and never runs the UPDATE (no cross-tenant kill, no enable)", async () => {
    orgThrows = true;
    const res = await pauseAllSending(BASE);
    expect(res).toEqual({ ok: false, error: { code: "forbidden", message: "forbidden" } });
    expect(queries.find((q) => /update noelle\.agent_instances/.test(q.text))).toBeUndefined();
  });

  it("rejects an unauthenticated caller and never runs the UPDATE", async () => {
    currentUser = null;
    const res = await pauseAllSending(BASE);
    expect(res).toEqual({
      ok: false,
      error: { code: "unauthenticated", message: "unauthenticated" },
    });
    expect(queries.length).toBe(0);
  });

  it("is a safe no-op when nothing was on (paused:0, no error)", async () => {
    updateRows = [];
    const res = await pauseAllSending(BASE);
    expect(res).toEqual({ ok: true, paused: 0 });
  });

  it("exposes NO symmetric resume (asymmetry is enforced in code)", () => {
    expect(Object.keys(actions)).not.toContain("resumeAllSending");
    expect(Object.keys(actions)).not.toContain("resumeAll");
  });
});
