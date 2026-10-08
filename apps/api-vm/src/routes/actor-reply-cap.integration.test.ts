import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { actorReplyCap } from "./actor-reply-cap.js";

const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
const url = process.env.NOELLE_X_DAILY_REPLY_CAP_TEST_DATABASE_URL;
vi.mock("../middleware/actuator.js", () => ({ requireActuatorToken: async (
  c: { set(key: string, value: unknown): void }, next: () => Promise<void>,
) => { c.set("actuator", { orgId: "00000000-0000-4000-8000-000000000001" }); await next(); } }));

describe.skipIf(!url)("persisted X daily cap (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  const endpoint = (id = instance) => `/api/actuator/reply-cap?platform=x&instanceId=${id}`;
  const state = async () => {
    const response = await actorReplyCap.request(endpoint());
    expect(response.status).toBe(200);
    return await response.json() as { cap: number; configuredCap?: number; minimum?: number; day?: string };
  };
  const save = (policy: { cap: number | null; minimum?: number | null }) => actorReplyCap.request(endpoint(), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(policy),
  });
  beforeAll(async () => {
    sql = postgres(url!, { max: 12, onnotice: () => {} });
    const [database] = await sql<{ db: string }[]>`select current_database() as db`;
    if (database?.db !== "noelle_x_daily_reply_cap_test") throw new Error("refusing non-dedicated daily-cap database");
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0004_drafts_sent_at.sql", "0003_x_watchlist.sql",
      "0005_leads_full_schema.sql", "0015_auto_send.sql", "0018_x_watchlist_people.sql", "0019_worker_enabled.sql",
      "0081_reply_send_enabled.sql", "0083_x_activity.sql", "0089_actuator_remote_control.sql", "0106_tenant_scoped_lead_identity.sql",
      "0108_x_browser_discovery.sql", "0110_actuator_daily_reply_cap.sql", "0126_x_daily_reply_cap_variation.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
    await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema/0126_x_daily_reply_cap_variation.sql"), "utf8"));
  });
  beforeEach(async () => {
    __setDbClientForTests(sql);
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values(${org},'cap-test','Cap test')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,actuator_daily_reply_cap,send_enabled,actuator_desired_state)
      values(${instance},${org},'x_intern',140,false,'stopped')`;
  });
  afterAll(async () => { resetDbClientForTests(); await sql?.end(); });

  it("preserves the exact fixed-cap response", async () => {
    expect(await state()).toEqual({ sent: 0, cap: 140, remaining: 140 });
  });
  it("initializes today's variation at the upper bound", async () => {
    expect((await save({ cap: 140, minimum: 80 })).status).toBe(200);
    const [date] = await sql<{ day: string }[]>`select current_date::text as day`;
    expect(await state()).toEqual({ sent: 0, cap: 140, remaining: 140, configuredCap: 140, minimum: 80, day: date!.day });
    const [flags] = await sql`select reply_send_enabled,auto_send_enabled,send_enabled,
      actuator_desired_state from noelle.agent_instances where id=${instance}`;
    expect(flags).toMatchObject({ reply_send_enabled: false, auto_send_enabled: false, send_enabled: false,
      actuator_desired_state: "stopped" });
  });
  it("rolls a stale day once across concurrent readers and a fresh connection", async () => {
    await sql`update noelle.agent_instances set actuator_daily_reply_cap_min=80,
      actuator_daily_reply_cap_day=current_date-1,actuator_daily_reply_cap_effective=140 where id=${instance}`;
    const values = await Promise.all(Array.from({ length: 12 }, state));
    expect(new Set(values.map(value => value.cap)).size).toBe(1);
    expect(values[0]!.cap).toBeGreaterThanOrEqual(80);
    expect(values[0]!.cap).toBeLessThan(140);
    const fresh = postgres(url!, { max: 1 });
    try {
      __setDbClientForTests(fresh);
      expect(await state()).toEqual(values[0]);
    } finally { __setDbClientForTests(sql); await fresh.end(); }
  });
  it("preserves a valid same-day sample across policy saves", async () => {
    await sql`update noelle.agent_instances set actuator_daily_reply_cap_min=80,
      actuator_daily_reply_cap_day=current_date,actuator_daily_reply_cap_effective=120 where id=${instance}`;
    await save({ cap: 140, minimum: 80 });
    expect((await state()).cap).toBe(120);
    await save({ cap: 130, minimum: 100 });
    expect((await state()).cap).toBe(120);
  });
  it("clamps a same-day sample when the upper bound or minimum changes", async () => {
    await save({ cap: 140, minimum: 80 });
    await save({ cap: 110, minimum: 80 });
    expect((await state()).cap).toBe(110);
    await save({ cap: 140, minimum: 130 });
    expect((await state()).cap).toBe(130);
  });
  it("clears variation on a legacy fixed write", async () => {
    await save({ cap: 140, minimum: 80 });
    await save({ cap: 100 });
    expect(await state()).toEqual({ sent: 0, cap: 100, remaining: 100 });
    const [row] = await sql`select actuator_daily_reply_cap_min,actuator_daily_reply_cap_day,
      actuator_daily_reply_cap_effective from noelle.agent_instances where id=${instance}`;
    expect(Object.values(row!)).toEqual([null, null, null]);
  });
  it("allows a single-value range without rerolling", async () => {
    await save({ cap: 80, minimum: 80 });
    await sql`update noelle.agent_instances set actuator_daily_reply_cap_day=current_date-1 where id=${instance}`;
    expect((await state()).cap).toBe(80);
  });
  it("rejects invalid ranges and foreign instances", async () => {
    expect((await save({ cap: 140, minimum: 141 })).status).toBe(400);
    expect((await save({ cap: null, minimum: 80 })).status).toBe(400);
    expect((await actorReplyCap.request(endpoint("00000000-0000-4000-8000-000000000099"))).status).toBe(403);
    expect(await state()).toEqual({ sent: 0, cap: 140, remaining: 140 });
  });
});
