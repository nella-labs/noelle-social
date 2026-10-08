import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { notifyBudgetBlockedOnce } from "./budgetAlert.js";
import { BudgetExceededError } from "./budgetBucket.js";
import type { NotifyResult } from "./notifier.js";

const db = vi.hoisted(() => ({ has: vi.fn(), send: vi.fn() }));
vi.mock("./budgetAlertDb.js", () => ({ hasBudgetNotification: db.has, sendBudgetNotificationOnce: db.send }));
const sql = {} as Sql;
const log = { info: vi.fn(), error: vi.fn() };
const err = new BudgetExceededError({ layer: "org", spent_cents: 50_000, estimated_cents: 12, cap_cents: 50_000 });
const sent: NotifyResult = { status: "sent", channel: "pushover", request: "fixture-accepted" };
function notifier(receipt: NotifyResult = sent) {
  const notify = vi.fn(async (_args: { title: string; message: string }, _options?: { timeoutMs?: number }) => receipt);
  return { notify, prepare: vi.fn(async (_orgId: string) => ({ notify })) };
}
beforeEach(() => {
  vi.clearAllMocks();
  db.has.mockResolvedValue(false);
  db.send.mockImplementation(async (_sql, _org, _period, send) => { await send(1000); return "notified"; });
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("notifyBudgetBlockedOnce", () => {
  it("prepares the owning org and reports only the committed accepted notification", async () => {
    const n = notifier();
    expect(await notifyBudgetBlockedOnce({ sql, notifier: n, log }, { orgId: "o", err })).toBe("notified");
    expect(n.prepare).toHaveBeenCalledWith("o");
    const [args, options] = n.notify.mock.calls[0]!;
    expect(args.title).toMatch(/budget cap reached/i);
    expect(args.message).toContain("$500.00");
    expect(args.message).toContain("cap-pause.sh");
    expect(options).toEqual({ timeoutMs: 1000 });
    expect(log.info).toHaveBeenCalledOnce();
  });
  it.each<NotifyResult>([
    { status: "error", channel: "pushover", detail: "provider rejected the notification" },
    { status: "no_channel", channel: null, detail: "no notification channel configured" },
  ])("does not claim an accepted notification for $status", async receipt => {
    db.send.mockImplementation(async (_sql, _org, _period, send) => {
      expect(await send(1000)).toEqual(receipt); return "failed";
    });
    expect(await notifyBudgetBlockedOnce({ sql, notifier: notifier(receipt), log }, { orgId: "o", err })).toBe("failed");
    expect(log.info).not.toHaveBeenCalled();
  });
  it("stays silent without resolving secrets once the window has an accepted receipt", async () => {
    db.has.mockResolvedValue(true);
    const n = notifier();
    expect(await notifyBudgetBlockedOnce({ sql, notifier: n, log }, { orgId: "o", err })).toBe("already-notified");
    expect(n.prepare).not.toHaveBeenCalled(); expect(db.send).not.toHaveBeenCalled();
  });
  it("uses the configured week for both receipt reads and guarded sends", async () => {
    vi.stubEnv("NOELLE_BUDGET_PERIOD", "week");
    await notifyBudgetBlockedOnce({ sql, notifier: notifier(), log }, { orgId: "o", err });
    expect(db.has).toHaveBeenCalledWith(sql, "o", "week");
    expect(db.send.mock.calls[0]?.[2]).toBe("week");
  });
  it("contains a receipt database failure before credential preparation", async () => {
    db.has.mockRejectedValue(new Error("db down"));
    const n = notifier();
    expect(await notifyBudgetBlockedOnce({ sql, notifier: n, log }, { orgId: "o", err })).toBe("failed");
    expect(n.prepare).not.toHaveBeenCalled(); expect(log.error).toHaveBeenCalledOnce();
  });
  it("contains failed credential preparation and provider exceptions", async () => {
    const n = notifier();
    n.prepare.mockRejectedValueOnce(new Error("secret source down"));
    expect(await notifyBudgetBlockedOnce({ sql, notifier: n, log }, { orgId: "o", err })).toBe("failed");
    expect(db.send).not.toHaveBeenCalled();
    n.notify.mockRejectedValueOnce(new Error("provider failed"));
    expect(await notifyBudgetBlockedOnce({ sql, notifier: n, log }, { orgId: "o", err })).toBe("failed");
  });
  it("does not claim success while another worker holds the notification lease", async () => {
    db.send.mockResolvedValue("in-progress");
    expect(await notifyBudgetBlockedOnce({ sql, notifier: notifier(), log }, { orgId: "o", err })).toBe("in-progress");
    expect(log.info).not.toHaveBeenCalled(); expect(log.error).not.toHaveBeenCalled();
  });
  it("contains a non-Error exception from credential preparation", async () => {
    const n = notifier();
    n.prepare.mockRejectedValueOnce(null);
    expect(await notifyBudgetBlockedOnce({ sql, notifier: n, log }, { orgId: "o", err })).toBe("failed");
  });
});
