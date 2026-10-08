import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const fixture = vi.hoisted(() => ({ sql: null as unknown as Sql, beforeWrite: null as null | (() => Promise<void>), revalidate: vi.fn() }));
const org = "00000000-0000-4000-8000-000000000001", foreign = "00000000-0000-4000-8000-000000000002", id = "00000000-0000-4000-8000-000000000011";
vi.mock("@/lib/queries", () => ({ getCurrentUser: async () => ({ id: "fixture-member" }), getOrgBySlug: async () => ({ id: org }) }));
vi.mock("next/cache", () => ({ revalidatePath: fixture.revalidate }));
vi.mock("@/lib/db", () => ({ sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
  if (strings.join("?").trim().startsWith("update noelle.agent_instances")) {
    const hook = fixture.beforeWrite; fixture.beforeWrite = null; await hook?.();
  }
  return Reflect.apply(fixture.sql, undefined, [strings, ...values]);
} }));
import { updateObjective } from "./agent-targeting";

const url = process.env.NOELLE_DASHBOARD_OBJECTIVE_TEST_DATABASE_URL;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
describe.skipIf(!url)("objective mutation (dedicated native schema)", () => {
  let sql: Sql;
  const save = (objective: string) => updateObjective({ orgSlug: "fixture", instanceId: id, objective });
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {}, connection: { application_name: "noelle-objective-fixture" } });
    const [row] = await sql`select current_database() as db`;
    if (row?.db !== "noelle_dashboard_objective_test") throw new Error("Dedicated dashboard objective test database required");
    fixture.sql = sql; await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0017_agent_objective.sql"])
      await sql.unsafe(readFileSync(resolve(repo, "infra/cloudsql/schema", name), "utf8"));
  });
  beforeEach(async () => {
    fixture.beforeWrite = null; fixture.revalidate.mockReset();
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'fixture','Fixture'),(${foreign},'foreign','Foreign')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,objective) values (${id},${org},'x_intern','Old custom objective')`;
  });
  afterAll(async () => { await sql?.end(); });

  test.each(["  New objective  ", " \n\t "])("persists and acknowledges the native %j update", async (objective) => {
    const persisted = objective.trim() || null;
    expect(await save(objective)).toEqual({ ok: true, objective: persisted });
    expect((await sql`select objective from noelle.agent_instances where id=${id}`)[0]?.objective).toBe(persisted);
    expect(fixture.revalidate).toHaveBeenCalledTimes(2);
  });
  test.each(["New objective", ""])("rejects a tenant-rebound row before writing %j", async (objective) => {
    let hookRan = false;
    fixture.beforeWrite = async () => { hookRan = true; await sql`update noelle.agent_instances set org_id=${foreign} where id=${id}`; };
    const result = await save(objective);
    expect(hookRan).toBe(true);
    expect((await sql`select org_id,objective from noelle.agent_instances where id=${id}`)[0]).toEqual({ org_id: foreign, objective: "Old custom objective" });
    expect(result).toEqual({ ok: false, error: "not_found" }); expect(fixture.revalidate).not.toHaveBeenCalled();
  });
  test.each(["New objective", ""])("rejects a deleted row before writing %j", async (objective) => {
    let hookRan = false;
    fixture.beforeWrite = async () => { hookRan = true; await sql`delete from noelle.agent_instances where id=${id}`; };
    expect(await save(objective)).toEqual({ ok: false, error: "not_found" }); expect(hookRan).toBe(true);
    expect(await sql`select id from noelle.agent_instances where id=${id}`).toHaveLength(0);
    expect(fixture.revalidate).not.toHaveBeenCalled();
  });
  test.each(["foreign", "missing"] as const)("rejects an already %s instance without mutation", async (kind) => {
    if (kind === "foreign") await sql`update noelle.agent_instances set org_id=${foreign} where id=${id}`;
    else await sql`delete from noelle.agent_instances where id=${id}`;
    expect(await save("New objective")).toEqual({ ok: false, error: "not_found" });
    if (kind === "foreign") expect((await sql`select objective from noelle.agent_instances where id=${id}`)[0]?.objective).toBe("Old custom objective");
    expect(fixture.revalidate).not.toHaveBeenCalled();
  });
  test.each(["rebind", "delete"] as const)("a pending update rechecks the committed parent %s before acknowledging", async (kind) => {
    let release!: () => void, locked!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { locked = resolve; });
    const mutation = sql.begin(async (tx) => {
      await tx`select id from noelle.agent_instances where id=${id} for update`; locked(); await gate;
      if (kind === "rebind") await tx`update noelle.agent_instances set org_id=${foreign} where id=${id}`;
      else await tx`delete from noelle.agent_instances where id=${id}`;
    });
    await ready; let settled = false;
    const pending = save("New objective"); void pending.then(() => { settled = true; }, () => { settled = true; });
    try {
      const deadline = performance.now() + 2_000;
      let waiting = false;
      while (!waiting && performance.now() < deadline) {
        const rows = await sql`select pid from pg_stat_activity where application_name='noelle-objective-fixture'
          and wait_event_type='Lock'`;
        waiting = rows.length > 0;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(waiting).toBe(true); expect(settled).toBe(false); expect(fixture.revalidate).not.toHaveBeenCalled();
      release(); await mutation;
      expect(await pending).toEqual({ ok: false, error: "not_found" });
      expect(fixture.revalidate).not.toHaveBeenCalled();
      if (kind === "rebind") expect((await sql`select objective from noelle.agent_instances where id=${id}`)[0]?.objective).toBe("Old custom objective");
      else expect(await sql`select id from noelle.agent_instances where id=${id}`).toHaveLength(0);
    } finally { release(); await Promise.allSettled([mutation, pending]); }
  });
});
