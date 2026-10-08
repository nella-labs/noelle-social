import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { haltXSend } from "./send-halt-db.js";

const url = process.env.NOELLE_X_HALT_TEST_DATABASE_URL;
const orgId = "00000000-0000-4000-8000-000000000001";
const otherOrg = "00000000-0000-4000-8000-000000000002";
const instanceId = "00000000-0000-4000-8000-000000000011";
const scope = { orgId, instanceId };
describe.skipIf(!url)("acknowledged X halt (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, {
      max: 4,
      onnotice: () => {},
      connection: { application_name: "x-send-halt-proof" },
    });
    const [db] = await sql<{ name: string }[]>`select current_database() as name`;
    if (!db?.name.endsWith("_x_send_halt_test")) {
      await sql.end();
      throw new Error("dedicated halt database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0019_worker_enabled.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.agent_instances,noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${orgId},'one','One'),(${otherOrg},'two','Two')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,status) values (${instanceId},${orgId},'x_intern','active')`;
  });
  afterAll(async () => {
    await sql?.end();
    if (!url) return;
    const observer = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await vi.waitFor(
        async () => {
          const [row] = await observer<
            { count: number }[]
          >`select count(*)::int as count from pg_stat_activity
          where datname=current_database() and application_name='x-send-halt-proof'`;
          expect(row?.count).toBe(0);
        },
        { timeout: 4000 },
      );
    } finally {
      await observer.end();
    }
  });
  async function enabled() {
    return (
      await sql<
        { send_enabled: boolean }[]
      >`select send_enabled from noelle.agent_instances where id=${instanceId}`
    )[0]?.send_enabled;
  }
  it.each(["active", "paused"])(
    "acknowledges a committed %s X halt and preserves other worker flags",
    async (status) => {
      await sql`update noelle.agent_instances set status=${status},discovery_enabled=false where id=${instanceId}`;
      expect(await haltXSend(sql, scope)).toBe(true);
      expect(await enabled()).toBe(false);
      expect(
        (
          await sql`select status,discovery_enabled,classifier_enabled from noelle.agent_instances where id=${instanceId}`
        )[0],
      ).toEqual({ status, discovery_enabled: false, classifier_enabled: true });
    },
  );
  it("acknowledges an already halted scoped parent", async () => {
    await sql`update noelle.agent_instances set send_enabled=false where id=${instanceId}`;
    expect(await haltXSend(sql, scope)).toBe(true);
  });
  it("returns no acknowledgment for a missing parent", async () => {
    await sql`delete from noelle.agent_instances where id=${instanceId}`;
    expect(await haltXSend(sql, scope)).toBe(false);
  });
  it.each(["org", "role", "status"])(
    "preserves a parent with changed %s authority",
    async (field) => {
      if (field === "org")
        await sql`update noelle.agent_instances set org_id=${otherOrg} where id=${instanceId}`;
      if (field === "role")
        await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instanceId}`;
      if (field === "status")
        await sql`update noelle.agent_instances set status='draft' where id=${instanceId}`;
      expect(await haltXSend(sql, scope)).toBe(false);
      expect(await enabled()).toBe(true);
    },
  );
  async function waitBlocked() {
    await vi.waitFor(async () => {
      const [row] = await sql<
        { blocked: boolean }[]
      >`select exists(select 1 from pg_stat_activity where datname=current_database()
        and application_name='x-send-halt-proof' and wait_event_type='Lock' and query like 'update noelle.agent_instances%') as blocked`;
      expect(row?.blocked).toBe(true);
    });
  }
  it.each(["org", "role"])(
    "rechecks committed %s rebind after waiting on the current parent",
    async (field) => {
      const tx = await sql.reserve();
      await tx`begin`;
      await tx`select id from noelle.agent_instances where id=${instanceId} for no key update`;
      const pending = haltXSend(sql, scope);
      try {
        await waitBlocked();
        if (field === "org")
          await tx`update noelle.agent_instances set org_id=${otherOrg} where id=${instanceId}`;
        else
          await tx`update noelle.agent_instances set role='linkedin_intern' where id=${instanceId}`;
        await tx`commit`;
        expect(await pending).toBe(false);
        expect(await enabled()).toBe(true);
      } finally {
        await tx`rollback`.catch(() => {});
        tx.release();
        await pending.catch(() => {});
      }
    },
  );
  it("bounds a held parent and leaves no late halt after unlock, then recovers", async () => {
    const tx = await sql.reserve();
    await tx`begin`;
    await tx`select id from noelle.agent_instances where id=${instanceId} for no key update`;
    const pending = haltXSend(sql, scope);
    const observed = pending.then(
      () => "unexpected",
      () => "rejected",
    );
    try {
      await waitBlocked();
      expect(await observed).toBe("rejected");
    } finally {
      await tx`rollback`;
      tx.release();
      await observed;
    }
    expect(await enabled()).toBe(true);
    expect(await haltXSend(sql, scope)).toBe(true);
    expect(await enabled()).toBe(false);
  });
});
