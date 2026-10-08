import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runSchedulerTick } from "./scheduler.js";

const url = process.env.NOELLE_RUN_SCHEDULER_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";
const now = new Date("2026-10-05T12:00:00Z");
const schedule = { enabled: true, mode: "interval", intervalHours: 6, timezone: "UTC", goal: 20 };
describe.skipIf(!url)("recurring scheduler (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 8, onnotice: () => {} });
    const db = (await sql<{ db: string }[]>`select current_database() as db`)[0]?.db;
    if (!db?.endsWith("_run_scheduler_test")) throw new Error(`refusing to reset non-dedicated database ${db}`);
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0019_worker_enabled.sql", "0021_pipeline_goal.sql", "0027_last_goal_started_at.sql", "0032_discovery_config.sql", "0085_run_schedule.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.agent_instances, noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One')`;
    await sql`insert into noelle.agent_instances (id,org_id,role,status,run_schedule,run_schedule_next_at)
      values (${instance},${org},'x_intern','paused',${sql.json(schedule)},${now})`;
  });
  afterAll(async () => { await sql?.end(); });
  it("fires one due occurrence exactly once across eight overlapping ticks", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => runSchedulerTick(sql, now)));
    expect(results.reduce((count,result) => count+result.fired,0)).toBe(1);
    const [row] = await sql<{ goal_target: number; run_schedule_next_at: Date }[]>`select goal_target,run_schedule_next_at from noelle.agent_instances where id=${instance}`;
    expect(row?.goal_target).toBe(20);
    expect(row?.run_schedule_next_at.toISOString()).toBe("2026-10-05T18:00:00.000Z");
  });
  it.each(["start", "disable"])("rechecks an operator %s committed after the due scan", async change => {
    let injected = false;
    const guarded = new Proxy(sql, { apply(target,thisArg,args) {
      const result = Reflect.apply(target,thisArg,args);
      const first = args[0] as { raw?: string[] };
      const query = first?.raw?.join(" ") ?? "";
      if (injected || !query.includes("from noelle.agent_instances") || !query.includes("run_schedule_next_at") || query.includes("for update")) return result;
      injected = true;
      return Promise.resolve(result).then(async rows => {
        if (change === "start") await sql`update noelle.agent_instances set goal_target=50 where id=${instance}`;
        else await sql`update noelle.agent_instances set run_schedule=${sql.json({ ...schedule,enabled:false })},run_schedule_next_at=null where id=${instance}`;
        return rows;
      });
    } });
    expect((await runSchedulerTick(guarded,now)).fired).toBe(0);
    const [row] = await sql<{ goal_target: number | null; run_schedule_next_at: Date | null }[]>`select goal_target,run_schedule_next_at from noelle.agent_instances where id=${instance}`;
    expect(row?.goal_target).toBe(change === "start" ? 50 : null);
    if (change === "disable") expect(row?.run_schedule_next_at).toBeNull();
  });
});
