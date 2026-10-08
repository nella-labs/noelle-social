import { beforeEach, expect, test, vi } from "vitest";
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
const user = "00000000-0000-4000-8000-000000000021";
const state = vi.hoisted(() => ({
  role: "x_intern",
  alerts: vi.fn(),
  rules: vi.fn(),
  counts: vi.fn(),
}));
vi.mock("@/lib/auth-cookie", () => ({
  getUserFromCookies: async () => ({ id: "00000000-0000-4000-8000-000000000021" }),
}));
vi.mock("@/lib/db", () => {
  const readSql = async () => [
    {
      id: "00000000-0000-4000-8000-000000000011",
      org_id: "00000000-0000-4000-8000-000000000001",
      role: state.role,
    },
  ];
  return {
    readSql,
    sql: readSql,
    pgOrgMembersClient: () => async () => [{ user_id: "00000000-0000-4000-8000-000000000021" }],
  };
});
vi.mock("@noelle/runtime/pattern-breaker-db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadVisibleAlerts: state.alerts,
  listPatternRules: state.rules,
  countPatternRules: state.counts,
}));
import { listVisiblePatternAlerts, listPatternRules, countPatternRules } from "./queries";
beforeEach(() => {
  state.role = "x_intern";
  state.alerts.mockReset().mockResolvedValue({ alerts: [], nextCursor: null, total: 0 });
  state.rules
    .mockReset()
    .mockResolvedValue({
      rules: [],
      nextCursor: null,
      total: 0,
      counts: { active: 0, disabled: 0, malformedActive: 0 },
    });
  state.counts.mockReset().mockResolvedValue({ active: 0, total: 0 });
});
test("all pattern readers delegate the current verified scope and read-only owner", async () => {
  await listVisiblePatternAlerts(instance);
  await listPatternRules(instance);
  await countPatternRules(instance);
  for (const fn of [state.alerts, state.rules])
    expect(fn).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.any(Function), fragments: expect.any(Function) }),
      { orgId: org, agentInstanceId: instance, role: "x_intern", userId: user },
      {},
    );
  expect(state.counts).toHaveBeenCalledWith(
    expect.objectContaining({ query: expect.any(Function), fragments: expect.any(Function) }),
    { orgId: org, agentInstanceId: instance, role: "x_intern", userId: user },
  );
});
test("an unsupported parent has no pattern dispatch", async () => {
  state.role = "ceo";
  await expect(listVisiblePatternAlerts(instance)).rejects.toThrow("unavailable");
  await expect(listPatternRules(instance)).rejects.toThrow("unavailable");
  expect(await countPatternRules(instance)).toEqual({ active: 0, total: 0 });
  for (const fn of [state.alerts, state.rules, state.counts]) expect(fn).not.toHaveBeenCalled();
});
