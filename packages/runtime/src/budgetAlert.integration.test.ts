import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BudgetExceededError } from "./budgetBucket.js";
import { notifyBudgetBlockedOnce } from "./budgetAlert.js";
import type { NotifyResult } from "./notifier.js";

const url = process.env.NOELLE_BUDGET_ALERT_TEST_DATABASE_URL;
const sent: NotifyResult = { status: "sent", channel: "pushover", request: "fixture-receipt" };
const err = new BudgetExceededError({ layer: "org", spent_cents: 500, estimated_cents: 12, cap_cents: 500 });
const log = { info: vi.fn(), error: vi.fn() };

describe.skipIf(!url)("budget notification acceptance receipts (native PostgreSQL)", () => {
  let sql: Sql, other: Sql, orgId: string, instanceId: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    if (!String(db?.name).endsWith("_budget_alert_test")) throw new Error("Dedicated budget alert test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0010_agent_policies.sql", "0118_budget_block_notifications.sql"])
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"));
    other = postgres(url!, { max: 2, onnotice: () => {} });
  });
  beforeEach(async () => {
    vi.clearAllMocks();
    await sql`drop trigger if exists reject_budget_receipt on noelle.budget_block_notifications`;
    await sql`truncate noelle.organizations cascade`;
    const [org] = await sql`insert into noelle.organizations(slug,name) values ('budget-fixture','Budget fixture') returning id`;
    orgId = org!.id as string;
    const [instance] = await sql`insert into noelle.agent_instances(org_id,role,status)
      values (${orgId},'x_intern','active') returning id`;
    instanceId = instance!.id as string;
  });
  afterAll(async () => { await delay(1100); await Promise.all([sql?.end({ timeout: 0 }), other?.end({ timeout: 0 })]); });
  function notifier(receipt: NotifyResult = sent) {
    const notify = vi.fn(async (_args: unknown, _options?: { timeoutMs?: number }) => receipt);
    return { notify, prepare: vi.fn(async (_orgId: string) => ({ notify })) };
  }
  const invoke = (n: ReturnType<typeof notifier>, parent = sql, period: "month" | "week" = "month") =>
    notifyBudgetBlockedOnce({ sql: parent, notifier: n, log }, { orgId, err, period });
  const receipts = () => sql`select * from noelle.budget_block_notifications where org_id=${orgId}`;
  async function block() {
    await sql`insert into noelle.budget_escalations(agent_instance_id,org_id,attempted_cents,cap_cents)
      values (${instanceId},${orgId},512,500)`;
  }

  it("stores an accepted receipt and deduplicates after a worker connection restart", async () => {
    const n = notifier();
    expect(await invoke(n)).toBe("notified");
    expect(await receipts()).toMatchObject([{ notify_channel: "pushover", provider_request: "fixture-receipt" }]);
    expect(await invoke(n, other)).toBe("already-notified");
    expect(n.notify).toHaveBeenCalledOnce();
  });
  it("does not treat an existing cap-block row as an accepted notification", async () => {
    await block();
    const n = notifier();
    expect(await invoke(n)).toBe("notified");
    expect(n.notify).toHaveBeenCalledOnce();
  });
  it("can notify after a rejected attempt and its persisted cap-block event", async () => {
    await invoke(notifier({ status: "error", channel: "pushover", detail: "fixture rejection" }));
    await block();
    const n = notifier();
    expect(await invoke(n)).toBe("notified");
    expect(n.notify).toHaveBeenCalledOnce();
    expect(await receipts()).toHaveLength(1);
  });
  it.each<NotifyResult>([
    { status: "error", channel: "pushover", detail: "fixture rejection" },
    { status: "no_channel", channel: null, detail: "fixture missing channel" },
    { status: "sent", channel: "pushover", request: " " },
  ])("keeps $status without a valid acceptance receipt retryable", async receipt => {
    expect(await invoke(notifier(receipt))).toBe("failed");
    expect(await receipts()).toHaveLength(0);
    expect(log.info).not.toHaveBeenCalled();
  });
  it("serializes competing worker pools without overlapping provider dispatch", async () => {
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    const n = notifier();
    n.notify.mockImplementation(async () => { started(); await gate; return sent; });
    const calls = Array.from({ length: 8 }, (_, i) => invoke(n, i % 2 ? other : sql));
    let results: string[] = [];
    try {
      await ready; await delay(40);
      expect(n.notify).toHaveBeenCalledOnce();
    } finally { release(); results = await Promise.all(calls); }
    expect(results.filter(result => result === "notified")).toHaveLength(1);
    expect(results.every(result => ["notified", "already-notified", "in-progress"].includes(result))).toBe(true);
    expect(await receipts()).toHaveLength(1);
  });
  it("does not claim success when storing an accepted receipt fails", async () => {
    await sql.unsafe(`create or replace function noelle.reject_budget_receipt() returns trigger language plpgsql as $$
      begin raise exception 'fixture rejected receipt'; end $$`);
    await sql.unsafe(`create trigger reject_budget_receipt before insert on noelle.budget_block_notifications
      for each row execute function noelle.reject_budget_receipt()`);
    expect(await invoke(notifier())).toBe("failed");
    expect(await receipts()).toHaveLength(0);
    expect(log.info).not.toHaveBeenCalled();
  });
  it("separates organization, week and month receipts and ignores an older window", async () => {
    await sql`insert into noelle.budget_block_notifications(org_id,budget_period,period_started_at,notify_channel,provider_request)
      values (${orgId},'month',date_trunc('month',now())-interval '1 month','pushover','older-receipt')`;
    const n = notifier();
    expect(await invoke(n)).toBe("notified");
    expect(await invoke(n, other, "week")).toBe("notified");
    const [org] = await sql`insert into noelle.organizations(slug,name) values ('other-fixture','Other fixture') returning id`;
    expect(await notifyBudgetBlockedOnce({ sql, notifier: n, log }, { orgId: org!.id as string, err })).toBe("notified");
    expect(n.notify).toHaveBeenCalledTimes(3);
    expect(await receipts()).toHaveLength(3);
  });
});
