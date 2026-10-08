import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({ user: true, writes: vi.fn(), membership: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => state.user ? { id: "member" } : null }));
vi.mock("@/lib/db", () => ({ sql: state.writes, pgOrgMembersClient: () => "guard" }));
vi.mock("@noelle/runtime", () => ({ assertOrgMember: state.membership }));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
import { hireAgent } from "./actions";
beforeEach(() => { state.user = true; state.writes.mockReset().mockResolvedValue([{ id: "org" }]); state.membership.mockReset().mockResolvedValue(undefined); state.revalidate.mockReset(); });
test.each(["x_intern", "linkedin_intern", "reddit_intern", "video_intern"] as const)("members can set up %s with sending disabled", async role => {
  await hireAgent({ orgSlug: "selected", role });
  expect(state.membership).toHaveBeenCalledWith("guard", "member", "org");
  const [query, ...values] = state.writes.mock.calls[1]!;
  expect(query.join("")).toMatch(/'paused'/); expect(query.join("")).toMatch(/false, false, false/);
  expect(query.join("")).toMatch(/where noelle\.agent_instances\.status = 'provisioning_alpha'/);
  expect(values).toContain(role); expect(state.revalidate).toHaveBeenCalledWith("/app/selected/settings");
});
test.each(["ceo", "cmo", "engineer"])("retired role %s cannot be provisioned", async role => {
  await expect(hireAgent({ orgSlug: "selected", role: role as "x_intern" })).rejects.toThrow(); expect(state.writes).not.toHaveBeenCalled();
});
test("membership failures cannot create a channel", async () => {
  state.membership.mockRejectedValue(new Error("forbidden"));
  await expect(hireAgent({ orgSlug: "selected", role: "x_intern" })).rejects.toThrow("forbidden"); expect(state.writes).toHaveBeenCalledTimes(1);
});
