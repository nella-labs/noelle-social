import type { Sql } from "postgres";
import { beforeEach, expect, it, vi } from "vitest";
import { BudgetExceededError } from "@noelle/runtime";
import { recordBudgetEscalation } from "./budget-escalation.js";

const notification = vi.hoisted(() => vi.fn());
vi.mock("@noelle/runtime", async importOriginal => ({
  ...await importOriginal<typeof import("@noelle/runtime")>(), notifyBudgetBlockedOnce: notification,
}));
beforeEach(() => { vi.clearAllMocks(); notification.mockResolvedValue("failed"); });
const err = new BudgetExceededError({ layer: "org", spent_cents: 500, estimated_cents: 12, cap_cents: 500 });
const notifier = { prepare: vi.fn() };
const log = { error: vi.fn() } as unknown as import("./logger.js").Logger;

it("records each blocked attempt independently of a failed notification", async () => {
  const sql = vi.fn(async () => []);
  await recordBudgetEscalation({ sql: sql as unknown as Sql, log, err, orgId: "org", instanceId: "instance",
    leadId: null, escalateOnCap: true, notifier });
  expect(sql).toHaveBeenCalledOnce(); expect(notification).toHaveBeenCalledOnce();
  expect(sql.mock.invocationCallOrder[0]).toBeLessThan(notification.mock.invocationCallOrder[0]!);
});
it("still attempts notification when recording a block fails", async () => {
  const sql = vi.fn(async () => { throw new Error("fixture insert failed"); });
  await recordBudgetEscalation({ sql: sql as unknown as Sql, log, err, orgId: "org", instanceId: "instance",
    leadId: null, escalateOnCap: true, notifier });
  expect(notification).toHaveBeenCalledOnce(); expect(log.error).toHaveBeenCalledOnce();
});
it("preserves disabled escalation and silent recording", async () => {
  const sql = vi.fn(async () => []);
  const args = { sql: sql as unknown as Sql, log, err, orgId: "org", instanceId: "instance", leadId: null };
  await recordBudgetEscalation({ ...args, escalateOnCap: false, notifier });
  expect(sql).not.toHaveBeenCalled(); expect(notification).not.toHaveBeenCalled();
  await recordBudgetEscalation({ ...args, escalateOnCap: true });
  expect(sql).toHaveBeenCalledOnce(); expect(notification).not.toHaveBeenCalled();
});
