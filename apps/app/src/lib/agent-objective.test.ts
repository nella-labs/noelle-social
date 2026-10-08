import { beforeEach, expect, test, vi } from "vitest";
import { OBJECTIVE_MAX } from "@noelle/contracts";
import { OrgMembershipError } from "@noelle/runtime";

const fixture = vi.hoisted(() => ({ authenticated: true, org: true, forbidden: false, rows: [] as { objective: string | null }[], writes: [] as unknown[][], failWrite: false, revalidate: vi.fn() }));
const org = "00000000-0000-4000-8000-000000000001", id = "00000000-0000-4000-8000-000000000011";
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => fixture.authenticated ? { id: "fixture-member" } : null,
  getOrgBySlug: async () => { if (fixture.forbidden) throw new OrgMembershipError("fixture-member", org); return fixture.org ? { id: org } : null; },
}));
vi.mock("next/cache", () => ({ revalidatePath: fixture.revalidate }));
vi.mock("@/lib/db", () => ({ sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const query = strings.join("?").trim();
  if (!query.startsWith("update noelle.agent_instances")) throw new Error("Unexpected objective fixture query");
  fixture.writes.push(values);
  if (fixture.failWrite) throw new Error("fixture database unavailable");
  return fixture.rows;
} }));
import { updateObjective } from "./agent-targeting";
const save = (objective: string) => updateObjective({ orgSlug: "fixture", instanceId: id, objective });
beforeEach(() => { fixture.authenticated = true; fixture.org = true; fixture.forbidden = false; fixture.rows = []; fixture.writes = []; fixture.failWrite = false; fixture.revalidate.mockReset(); });

test.each(["New objective", "", " \n\t "])("does not acknowledge a zero-row update for %j", async (objective) => {
  expect(await save(objective)).toEqual({ ok: false, error: "not_found" });
  expect(fixture.writes).toHaveLength(1); expect(fixture.revalidate).not.toHaveBeenCalled();
});
test.each([["  New objective  ", "New objective"], [" \n\t ", null]] as const)("returns the persisted %j objective and refreshes its consumers", async (raw, persisted) => {
  fixture.rows = [{ objective: persisted }];
  expect(await save(raw)).toEqual({ ok: true, objective: persisted });
  expect(fixture.writes).toHaveLength(1);
  expect(fixture.writes[0]).toEqual(expect.arrayContaining([id, org]));
  expect(fixture.revalidate.mock.calls).toEqual([["/app/[orgSlug]/agents/[instanceId]", "page"], ["/app/[orgSlug]/agents/[instanceId]/watchlist", "page"]]);
});
test("acknowledges the returned database value rather than inventing a receipt from the input", async () => {
  fixture.rows = [{ objective: "Stored by the database" }];
  expect(await save("Requested objective")).toEqual({ ok: true, objective: "Stored by the database" });
});
test("rejects an overlong objective before writing or refreshing", async () => {
  expect(await save("x".repeat(OBJECTIVE_MAX + 1))).toEqual({ ok: false, error: "invalid" });
  expect(fixture.writes).toHaveLength(0); expect(fixture.revalidate).not.toHaveBeenCalled();
});
test.each(["unauthenticated", "not_found", "forbidden"] as const)("preserves %s authorization without a mutation", async (error) => {
  fixture.authenticated = error !== "unauthenticated"; fixture.org = error !== "not_found"; fixture.forbidden = error === "forbidden";
  expect(await save("New objective")).toEqual({ ok: false, error });
  expect(fixture.writes).toHaveLength(0); expect(fixture.revalidate).not.toHaveBeenCalled();
});
test("does not refresh or acknowledge an update whose database write failed", async () => {
  fixture.failWrite = true;
  await expect(save("New objective")).rejects.toThrow("fixture database unavailable");
  expect(fixture.revalidate).not.toHaveBeenCalled();
});
