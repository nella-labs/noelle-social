import { beforeEach, expect, test, vi } from "vitest";
const state = vi.hoisted(() => ({
  role: "x_intern",
  changed: true,
  user: true,
  write: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: state.revalidate }));
vi.mock("@/lib/queries", () => ({
  getCurrentUser: async () => (state.user ? { id: "00000000-0000-4000-8000-000000000021" } : null),
  getOrgBySlug: async () => ({ id: "00000000-0000-4000-8000-000000000001" }),
  getAgentInstance: async () => ({
    id: "00000000-0000-4000-8000-000000000011",
    org_id: "00000000-0000-4000-8000-000000000001",
    role: state.role,
  }),
}));
vi.mock("@/lib/db", () => ({ withTx: async (fn: (tx: unknown) => unknown) => fn({}) }));
vi.mock("@noelle/runtime/pattern-breaker-db", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  setPatternRuleActiveInTx: state.write,
}));
import { setPatternRuleActive } from "./actions";
const input = {
  orgSlug: "one",
  instanceId: "00000000-0000-4000-8000-000000000011",
  ruleId: "00000000-0000-4000-8000-000000000031",
  active: false,
};
beforeEach(() => {
  state.role = "x_intern";
  state.user = true;
  state.write.mockReset().mockResolvedValue(true);
  state.revalidate.mockReset();
});
test("passes a verified explicit owner to the shared atomic mutation", async () => {
  expect(await setPatternRuleActive(input)).toEqual({ ok: true, active: false });
  expect(state.write).toHaveBeenCalledWith(
    {},
    {
      orgId: "00000000-0000-4000-8000-000000000001",
      agentInstanceId: input.instanceId,
      role: "x_intern",
      userId: "00000000-0000-4000-8000-000000000021",
    },
    input.ruleId,
    false,
  );
});
test("does not acknowledge a zero-row shared mutation", async () => {
  state.write.mockResolvedValue(false);
  expect(await setPatternRuleActive(input)).toEqual({ ok: false, error: "not_found" });
  expect(state.revalidate).not.toHaveBeenCalled();
});
test("rejects unsupported roles before dispatch", async () => {
  state.role = "ceo";
  expect(await setPatternRuleActive(input)).toEqual({ ok: false, error: "not_found" });
  expect(state.write).not.toHaveBeenCalled();
});
test("keeps the explicit label conflict result", async () => {
  state.write.mockRejectedValue({ code: "23505" });
  expect(await setPatternRuleActive(input)).toEqual({ ok: false, error: "label_conflict" });
});
