import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { markApifyTokenExhausted } from "./connections-db.js";

const url = process.env.NOELLE_TEST_DATABASE_URL;
describe.skipIf(!url)("Apify cooldown renewal (integration)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [row] = await sql`select current_database() as name`;
    if (!row?.name.includes("test")) throw new Error("Cooldown tests require a test database");
  });
  beforeEach(async () => {
    await sql`begin`;
    await sql`create schema noelle`;
    await sql`create table noelle.connections (
      id text primary key, kind text not null, exhausted_at timestamptz,
      retry_at timestamptz, updated_at timestamptz default now()
    )`;
  });
  afterEach(async () => {
    await sql`rollback`;
  });
  afterAll(async () => {
    await sql?.end();
  });

  it("renews an expired cooldown after the retried token fails", async () => {
    await sql`insert into noelle.connections values ('due','apify',now() - interval '31 days',now() - interval '1 hour',now())`;
    await markApifyTokenExhausted(sql, "due", { cooldownDays: 1 });
    const [row] =
      await sql`select exhausted_at >= now() as renewed_exhaustion, retry_at > now() as renewed from noelle.connections where id = 'due'`;
    expect(row).toEqual({ renewed_exhaustion: true, renewed: true });
  });

  it("flags a fresh token with its provider-reported retry time", async () => {
    await sql`insert into noelle.connections (id,kind) values ('fresh','apify')`;
    const retryAt = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    await markApifyTokenExhausted(sql, "fresh", { retryAt });
    const [row] =
      await sql`select exhausted_at is not null as exhausted, retry_at from noelle.connections where id = 'fresh'`;
    expect(row).toEqual({ exhausted: true, retry_at: retryAt });
  });

  it("keeps an active future cooldown unchanged after another fatal report", async () => {
    await sql`insert into noelle.connections values ('cooling','apify',now() - interval '1 day',now() + interval '2 days',now())`;
    const [before] = await sql`select * from noelle.connections where id = 'cooling'`;
    await markApifyTokenExhausted(sql, "cooling", { cooldownDays: 1 });
    expect((await sql`select * from noelle.connections where id = 'cooling'`)[0]).toEqual(before);
  });

  it("leaves other credential IDs and non-Apify kinds untouched", async () => {
    await sql`insert into noelle.connections (id,kind) values ('other-id','apify'),('other-kind','x-api')`;
    const before = await sql`select * from noelle.connections order by id`;
    await markApifyTokenExhausted(sql, "other-kind", { cooldownDays: 1 });
    await markApifyTokenExhausted(sql, "missing", { cooldownDays: 1 });
    expect(await sql`select * from noelle.connections order by id`).toEqual(before);
  });
});
