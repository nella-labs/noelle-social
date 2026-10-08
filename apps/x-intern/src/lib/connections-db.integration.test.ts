import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pruneInvalidApifyTokens } from "./connections-db.js";

const url = process.env.NOELLE_TEST_DATABASE_URL;
const orgId = "00000000-0000-4000-8000-000000000001";
const otherOrgId = "00000000-0000-4000-8000-000000000002";
const credentialId = "00000000-0000-4000-8000-000000000003";

describe.skipIf(!url)("Apify credential retirement (integration)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [row] = await sql<{ db: string }[]>`select current_database() as db`;
    if (!row?.db.includes("test")) throw new Error("Apify retention tests require a test database");
  });
  beforeEach(async () => {
    await sql`begin`;
    await sql`create schema noelle`;
    await sql`create table noelle.connections (
      id uuid primary key, org_id uuid not null, kind text not null, label text not null,
      active boolean not null default true, in_use boolean not null default true,
      invalid_at timestamptz, updated_at timestamptz default now()
    )`;
    await sql`create table noelle.llm_calls (
      credential_id uuid references noelle.connections(id) on delete set null,
      cents integer not null
    )`;
  });
  afterEach(async () => { await sql`rollback`; });
  afterAll(async () => { await sql?.end(); });

  it("retires dead tokens while keeping their label and linked expenses", async () => {
    await sql`insert into noelle.connections (id, org_id, kind, label, invalid_at)
      values (${credentialId}, ${orgId}, 'apify', 'apify_…dead', now())`;
    await sql`insert into noelle.llm_calls (credential_id, cents)
      values (${credentialId}, 237), (${credentialId}, 113)`;

    expect(await pruneInvalidApifyTokens(sql, orgId)).toBe(1);
    const [retired] = await sql`select id, label, active, in_use from noelle.connections
      where id = ${credentialId}`;
    expect(retired).toEqual({ id: credentialId, label: 'apify_…dead', active: false, in_use: false });
    const [expense] = await sql`select c.label, sum(l.cents)::int as cents
      from noelle.connections c join noelle.llm_calls l on l.credential_id = c.id
      where c.id = ${credentialId} group by c.label`;
    expect(expense).toEqual({ label: 'apify_…dead', cents: 350 });
    expect(await pruneInvalidApifyTokens(sql, orgId)).toBe(0);
  });

  it("leaves healthy tokens, other organizations and already retired tokens untouched", async () => {
    await sql`insert into noelle.connections (id, org_id, kind, label, active, invalid_at)
      values
        (${credentialId}, ${orgId}, 'apify', 'healthy', true, null),
        ('00000000-0000-4000-8000-000000000004', ${otherOrgId}, 'apify', 'other org', true, now()),
        ('00000000-0000-4000-8000-000000000005', ${orgId}, 'other', 'other kind', true, now()),
        ('00000000-0000-4000-8000-000000000006', ${orgId}, 'apify', 'retired', false, now())`;
    const before = await sql`select * from noelle.connections order by id`;
    expect(await pruneInvalidApifyTokens(sql, orgId)).toBe(0);
    expect(await sql`select * from noelle.connections order by id`).toEqual(before);
  });
});
