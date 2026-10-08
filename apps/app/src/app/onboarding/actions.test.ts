import { createHmac } from "node:crypto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ user: true, cookie: "", sql: vi.fn(), find: vi.fn(), lock: vi.fn(), redeem: vi.fn(), deleted: vi.fn() }));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => state.user ? { id: "member", email: "member@example.test" } : null }));
vi.mock("@/lib/db", () => ({ sql: state.sql, withTx: async (fn: (tx: typeof state.sql) => Promise<unknown>) => fn(state.sql) }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => ({ value: state.cookie }), delete: state.deleted }) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`redirect:${path}`); } }));
vi.mock("@/lib/invitations", () => ({ findPendingEmailInvite: vi.fn(), findRedeemableInvite: state.find, lockInvitationForRedemption: state.lock, redeemLockedInvitation: state.redeem }));
import { createOrgFromOnboarding } from "./actions";
const form = () => { const value = new FormData(); value.set("name", "Social workspace"); value.set("slug", "social-workspace"); return value; };
beforeEach(() => {
  vi.stubEnv("NOELLE_AUTH_MODE", "supabase"); vi.stubEnv("NOELLE_INVITE_COOKIE_SECRET", "fixture-secret"); vi.stubEnv("NOELLE_ALPHA_INVITE_CODES", "");
  state.user = true; state.cookie = ""; state.sql.mockReset().mockImplementation(async (query: TemplateStringsArray) => query.join("").includes("insert into noelle.organizations") ? [{ id: "org", slug: "social-workspace" }] : []);
  state.find.mockReset().mockResolvedValue(null); state.lock.mockReset(); state.redeem.mockReset(); state.deleted.mockReset();
});
afterEach(() => { vi.unstubAllEnvs(); });
test("local mode creates owner membership and one paused X channel with every send switch off", async () => {
  vi.stubEnv("NOELLE_AUTH_MODE", "local");
  await expect(createOrgFromOnboarding(undefined, form())).rejects.toThrow("redirect:/app/social-workspace");
  expect(state.find).not.toHaveBeenCalled(); expect(state.lock).not.toHaveBeenCalled(); expect(state.redeem).not.toHaveBeenCalled(); expect(state.deleted).not.toHaveBeenCalled();
  const membership = state.sql.mock.calls.find(([query]) => query.join("").includes("insert into noelle.org_members"));
  expect(membership?.slice(1)).toEqual(["org", "member"]); expect(membership?.[0].join("")).toContain("'owner'");
  const agents = state.sql.mock.calls.filter(([query]) => query.join("").includes("insert into noelle.agent_instances"));
  expect(agents).toHaveLength(1); expect(agents[0]?.slice(1)).toEqual(["org", "x_intern", "paused", "Vega", 10000]); expect(agents[0]?.[0].join("")).toContain("false, false, false");
});
test.each(["supabase", "", "LOCAL"])("%s mode still requires a valid signed invitation", async mode => {
  vi.stubEnv("NOELLE_AUTH_MODE", mode);
  expect(await createOrgFromOnboarding(undefined, form())).toMatchObject({ ok: false, error: expect.stringContaining("Invite code") }); expect(state.sql).not.toHaveBeenCalled();
});
test("local mode still requires the configured operator identity", async () => {
  vi.stubEnv("NOELLE_AUTH_MODE", "local"); state.user = false;
  expect(await createOrgFromOnboarding(undefined, form())).toMatchObject({ ok: false, error: "Sign in first." }); expect(state.sql).not.toHaveBeenCalled();
});
test("hosted invitations still enforce their recipient before any write", async () => {
  state.cookie = `fixture.${createHmac("sha256", "fixture-secret").update("fixture").digest("hex")}`;
  state.find.mockResolvedValue({ id: "invite", code: "fixture", email: "other@example.test" });
  expect(await createOrgFromOnboarding(undefined, form())).toMatchObject({ ok: false, error: "This invite is for a different email address." }); expect(state.sql).not.toHaveBeenCalled();
});
