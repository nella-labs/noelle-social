import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import postgres, { type Sql } from "postgres";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";
import { xApi } from "./x-api.js";

export const xCredsOrg = "00000000-0000-4000-8000-000000000001";
export const xCredsForeignOrg = "00000000-0000-4000-8000-000000000002";
export const xCredsInstance = "00000000-0000-4000-8000-000000000011";
export const xCredsForeignInstance = "00000000-0000-4000-8000-000000000012";
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => {
  c.set("auth", { userId: xCredsOrg, raw: {} });
  await next();
});
app.route("/", xApi);

export async function openXCredsFixture(url: string) {
  const applicationName = `x_creds_fixture_${process.pid}`;
  const sql = postgres(url, { max: 12, onnotice: () => {}, connection: { application_name: applicationName } });
  const [database] = await sql`select current_database() as name`;
  if (!database?.name.endsWith("_x_api_creds_test")) {
    await sql.end();
    throw new Error("Dedicated X API credentials test database required");
  }
  await sql`drop schema if exists noelle cascade`;
  for (const file of ["0001_noelle_schema.sql", "0015_auto_send.sql", "0019_worker_enabled.sql",
    "0075_x_api_write.sql", "0077_x_api_oauth1a.sql", "0081_reply_send_enabled.sql"])
    await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"));
  let afterResolution: (() => Promise<void>) | undefined;
  const proxy = new Proxy(sql, {
    apply(target, thisArg, args) {
      const pending = Reflect.apply(target, thisArg, args);
      const query = Array.isArray(args[0]) ? args[0].join(" ") : "";
      if (!query.includes("select id from noelle.agent_instances")) return pending;
      return (async () => {
        const rows = await pending;
        await afterResolution?.();
        return rows;
      })();
    },
  }) as Sql;
  __setDbClientForTests(proxy);
  return {
    sql,
    async reset() {
      afterResolution = undefined;
      __setDbClientForTests(proxy);
      await sql`drop trigger if exists reject_x_creds_flag on noelle.agent_instances`;
      await sql`truncate noelle.organizations cascade`;
      await sql`insert into noelle.organizations(id,slug,name) values (${xCredsOrg},'one','One'),(${xCredsForeignOrg},'two','Two')`;
      await sql`insert into noelle.agent_instances(id,org_id,role,status) values
        (${xCredsInstance},${xCredsOrg},'x_intern','paused'),(${xCredsForeignInstance},${xCredsForeignOrg},'x_intern','active')`;
    },
    afterResolution(callback: () => Promise<void>) { afterResolution = callback; },
    async connected(orgId = xCredsOrg) {
      await sql`insert into noelle.x_api_tokens(org_id,agent_instance_id,auth_kind,access_token,consumer_key,consumer_secret,access_token_secret,x_handle)
        values (${orgId},${xCredsInstance},'oauth1a','fixture-old','fixture-key','fixture-secret','fixture-access-secret','old_handle')`;
      await sql`update noelle.agent_instances set x_api_write_enabled=true where id=${xCredsInstance}`;
    },
    async rejectFlagWrite() {
      await sql.unsafe(`create or replace function noelle.reject_x_creds_flag() returns trigger language plpgsql as $$
        begin raise exception 'fixture flag rejected'; end $$`);
      await sql.unsafe(`create trigger reject_x_creds_flag before update of x_api_write_enabled on noelle.agent_instances
        for each row execute function noelle.reject_x_creds_flag()`);
    },
    save(extra: Record<string, unknown> = {}) {
      return app.request("/api/x-api/creds", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ orgSlug: "one", consumerKey: "fixture-key", consumerSecret: "fixture-secret",
          accessToken: "123-fixture-new", accessTokenSecret: "fixture-access-secret", ...extra }) });
    },
    remove() { return app.request("/api/x-api/creds?orgSlug=one", { method: "DELETE" }); },
    async state() {
      const [instance] = await sql`select x_api_write_enabled as enabled from noelle.agent_instances where id=${xCredsInstance}`;
      const tokens = await sql`select org_id,access_token,x_handle from noelle.x_api_tokens where agent_instance_id=${xCredsInstance}`;
      return { enabled: instance?.enabled, tokens };
    },
    async waitForBlockedWrite() {
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline) {
        const [row] = await sql`select exists(select 1 from pg_stat_activity where datname=current_database()
          and application_name=${applicationName} and cardinality(pg_blocking_pids(pid))>0) as blocked`;
        if (row?.blocked) return;
        await new Promise(resolve => setTimeout(resolve, 15));
      }
      throw new Error("Expected native parent lock wait was not observed");
    },
    async close() { resetDbClientForTests(); await sql.end(); },
  };
}
