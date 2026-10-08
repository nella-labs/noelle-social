import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ sql: undefined as unknown as Sql, instance: { id: "", org_id: "" } }));
vi.mock("@/lib/db", () => ({ readSql: (...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args),
  sql: (...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args) }));
vi.mock("@/lib/queries", () => ({ getAgentInstance: () => fixture.instance }));
import { listStyleSamples } from "./feeder-queries";

const url = process.env.NOELLE_CORPUS_METRICS_TEST_DATABASE_URL;
describe.skipIf(!url)("dashboard corpus measurements (native PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = fixture.sql = postgres(url!, { max: 1, onnotice: () => {} });
    if (!String((await sql`select current_database() as name`)[0]?.name).includes("account_corpus_metrics_test")) throw new Error("dedicated corpus metrics test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0051_account_feeder.sql", "0119_account_corpus_metrics_nullable.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    fixture.instance.org_id = String((await sql`insert into noelle.organizations(slug,name) values ('dashboard_corpus','Dashboard corpus') returning id`)[0]!.id);
    fixture.instance.id = String((await sql`insert into noelle.agent_instances(org_id,role) values (${fixture.instance.org_id},'x_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const insert = (body: string, likes: number | null, comments: number | null) => sql`
    insert into noelle.account_style_posts(org_id,agent_instance_id,platform,account_handle,external_id,body,like_count,comment_count)
    values (${fixture.instance.org_id},${fixture.instance.id},'x','source',${body},${body},${likes},${comments})`;

  it("ranks measured large values and zero before unknown samples and decodes bigint strings", async () => {
    await insert("unknown", null, null);
    await insert("zero", 0, 0);
    await insert("large", 2 ** 31, 1);
    expect((await listStyleSamples(fixture.instance.id, 2)).map(p => [p.body, p.likeCount, p.commentCount]))
      .toEqual([["large", 2 ** 31, 1], ["zero", 0, 0]]);
    expect((await listStyleSamples(fixture.instance.id, 3))[2]).toMatchObject({ body: "unknown", likeCount: null, commentCount: null });
  });
  it("returns legacy negative and unsafe values as unknown without bigint sum overflow", async () => {
    await insert("legacy", 0, 0);
    await sql`update noelle.account_style_posts set like_count=9223372036854775807,comment_count=-1 where body='legacy'`;
    expect((await listStyleSamples(fixture.instance.id))[0]).toMatchObject({ likeCount: null, commentCount: null });
  });
  it("excludes saved rows whose current parent no longer belongs to their org", async () => {
    await insert("saved", 1, 0);
    const [other] = await sql`insert into noelle.organizations(slug,name) values ('foreign','Foreign') returning id`;
    await sql`update noelle.agent_instances set org_id=${other!.id} where id=${fixture.instance.id}`;
    expect(await listStyleSamples(fixture.instance.id)).toEqual([]);
  });
});
