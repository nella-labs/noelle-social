import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_COOLDOWN_DAYS, markApifyTokenExhausted,
  listApifyTokensForHealthSweep, pruneInvalidApifyTokens, clearApifyTokenExhausted,
  listApifyTokens, getActiveConnection, markApifyTokenInvalid,
} from "./apifyPoolDb.js";

const url = process.env.NOELLE_SHARED_APIFY_COOLDOWN_TEST_DATABASE_URL;
const dayMs = 24 * 60 * 60 * 1000;

describe.skipIf(!url)("shared Apify cooldown (native PostgreSQL)", () => {
  let sql: Sql;
  let orgId: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    const [current] = await sql`select current_database() as db`;
    if (!String(current?.db).includes("shared_apify_cooldown_test")) {
      throw new Error("dedicated shared Apify cooldown test database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0033_connections_credentials.sql",
      "0040_connections_multi_token.sql", "0041_connections_token_retry.sql", "0058_connections_in_use.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    const [org] = await sql`insert into noelle.organizations(slug,name) values ('cooldown_test','Cooldown test') returning id`;
    orgId = org!.id as string;
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });

  async function token(kind = "apify", exhaustedAt: Date | null = null, retryAt: Date | null = null) {
    const [row] = await sql`insert into noelle.connections(org_id,kind,label,secret,in_use,exhausted_at,retry_at)
      values (${orgId},${kind},'test credential','test-only-secret',true,${exhaustedAt},${retryAt}) returning id`;
    return row!.id as string;
  }
  async function state(id: string) {
    const [row] = await sql`select exhausted_at, retry_at, updated_at,
      (exhausted_at is null or retry_at <= now()) as available from noelle.connections where id=${id}`;
    return row!;
  }
  it("renews an expired cooldown after another failed attempt", async () => {
    const id = await token("apify", new Date(Date.now() - 3 * dayMs), new Date(Date.now() - dayMs));
    expect((await state(id)).available).toBe(true);
    const before = Date.now();
    await markApifyTokenExhausted(sql, id, { cooldownDays: 1 });
    const row = await state(id);
    expect(row.available).toBe(false);
    expect(row.exhausted_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row.retry_at.getTime()).toBeGreaterThanOrEqual(before + dayMs);
    expect(row.retry_at.getTime()).toBeLessThanOrEqual(Date.now() + dayMs);
  });
  it("uses the measured reset time ahead of the fallback duration", async () => {
    const id = await token();
    const retryAt = new Date(Date.now() + 2 * dayMs);
    await markApifyTokenExhausted(sql, id, { retryAt, cooldownDays: 7 });
    expect((await state(id)).retry_at).toEqual(retryAt);
  });
  it("keeps the default thirty-day cooldown", async () => {
    const id = await token();
    const before = Date.now();
    await markApifyTokenExhausted(sql, id);
    const retry = (await state(id)).retry_at.getTime();
    expect(DEFAULT_RETRY_COOLDOWN_DAYS).toBe(30);
    expect(retry).toBeGreaterThanOrEqual(before + 30 * dayMs);
    expect(retry).toBeLessThanOrEqual(Date.now() + 30 * dayMs);
  });
  it("retains an active future cooldown and its original timestamps", async () => {
    const id = await token("apify", new Date(Date.now() - dayMs), new Date(Date.now() + dayMs));
    const before = await state(id);
    await markApifyTokenExhausted(sql, id, { cooldownDays: 7 });
    expect(await state(id)).toEqual(before);
  });
  it("does not alter another credential, another kind, or a missing ID", async () => {
    const selected = await token();
    const other = await token();
    const otherKind = await token("openai");
    const untouched = [await state(other), await state(otherKind)];
    await markApifyTokenExhausted(sql, otherKind);
    await markApifyTokenExhausted(sql, crypto.randomUUID());
    await markApifyTokenExhausted(sql, selected);
    expect((await state(selected)).available).toBe(false);
    expect([await state(other), await state(otherKind)]).toEqual(untouched);
  });
  it("concurrent failed attempts preserve the first active cooldown", async () => {
    const id = await token("apify", new Date(Date.now() - 3 * dayMs), new Date(Date.now() - dayMs));
    const retryAt = new Date(Date.now() + dayMs);
    const alternateRetryAt = new Date(Date.now() + 7 * dayMs);
    await Promise.all([
      markApifyTokenExhausted(sql, id, { retryAt }),
      markApifyTokenExhausted(sql, id, { retryAt: alternateRetryAt }),
    ]);
    const settled = await state(id);
    expect([retryAt.getTime(), alternateRetryAt.getTime()]).toContain(settled.retry_at.getTime());
    await markApifyTokenExhausted(sql, id, { cooldownDays: 30 });
    expect(await state(id)).toEqual(settled);
  });

  it("sweeps parked and cooling credentials but excludes inactive, invalid and foreign rows", async () => {
    const fresh = await token();
    const parked = await token();
    await sql`update noelle.connections set in_use=false where id=${parked}`;
    const cooling = await token("apify", new Date(Date.now() - dayMs), new Date(Date.now() + dayMs));
    const invalid = await token();
    await sql`update noelle.connections set invalid_at=now() where id=${invalid}`;
    const inactive = await token();
    await sql`update noelle.connections set active=false where id=${inactive}`;
    await token("other");
    const [other] = await sql`insert into noelle.organizations(slug,name) values ('foreign','Foreign') returning id`;
    await sql`insert into noelle.connections(org_id,kind,label,secret)
      values (${other!.id},'apify','foreign','test-only-token')`;
    expect((await listApifyTokensForHealthSweep(sql, orgId)).map(row => row.credentialId))
      .toEqual([fresh, parked, cooling]);
  });

  it("keeps fresh, reset and cooling pool rows while excluding parked, invalid and foreign credentials", async () => {
    const fresh = await token();
    const reset = await token("apify", new Date(Date.now() - 2 * dayMs), new Date(Date.now() - dayMs));
    const cooling = await token("apify", new Date(Date.now() - dayMs), new Date(Date.now() + dayMs));
    const parked = await token(); const invalid = await token(); const inactive = await token();
    await sql`update noelle.connections set in_use=false where id=${parked}`;
    await sql`update noelle.connections set invalid_at=now() where id=${invalid}`;
    await sql`update noelle.connections set active=false where id=${inactive}`;
    await token("other");
    const [other] = await sql`insert into noelle.organizations(slug,name) values ('foreign','Foreign') returning id`;
    await sql`insert into noelle.connections(org_id,kind,label,secret,in_use)
      values (${other!.id},'apify','foreign','test-only-token',true)`;
    expect(await listApifyTokens(sql, orgId)).toEqual([
      { credentialId: fresh, token: 'test-only-secret', wasExhausted: false, available: true },
      { credentialId: reset, token: 'test-only-secret', wasExhausted: true, available: true },
      { credentialId: cooling, token: 'test-only-secret', wasExhausted: true, available: false },
    ]);
  });

  it("reads a selected active org and kind without claiming a unique active pool", async () => {
    const id = await token("other");
    const inactive = await token("other");
    await sql`update noelle.connections set active=false where id=${inactive}`;
    expect(await getActiveConnection(sql, { orgId, kind: 'other' })).toEqual({ id, secret: 'test-only-secret' });
    expect(await getActiveConnection(sql, { orgId, kind: 'absent' })).toBeNull();
    expect(await getActiveConnection(sql, { orgId: crypto.randomUUID(), kind: 'other' })).toBeNull();
  });

  it("invalidates only the selected Apify ID and retains the first invalid timestamp", async () => {
    const id = await token(); const other = await token(); const otherKind = await token("other");
    const claim = (credentialId: string) => ({ orgId, credentialId, token: "test-only-secret" });
    expect(await markApifyTokenInvalid(sql, claim(id))).toBe(true);
    expect(await markApifyTokenInvalid(sql, claim(otherKind))).toBe(false);
    expect(await markApifyTokenInvalid(sql, claim(crypto.randomUUID()))).toBe(false);
    const [before] = await sql`select invalid_at,updated_at from noelle.connections where id=${id}`;
    expect(await markApifyTokenInvalid(sql, claim(id))).toBe(false);
    expect((await sql`select invalid_at,updated_at from noelle.connections where id=${id}`)[0]).toEqual(before);
    expect((await sql`select count(*)::int as n from noelle.connections
      where id in (${other},${otherKind}) and invalid_at is not null`)[0]?.n).toBe(0);
  });

  it("retires scoped invalid credentials while preserving labels and linked native spend rows", async () => {
    const invalid = await token();
    await sql`update noelle.connections set invalid_at=now() where id=${invalid}`;
    const healthy = await token();
    const otherKind = await token("other");
    await sql`update noelle.connections set invalid_at=now() where id=${otherKind}`;
    const [other] = await sql`insert into noelle.organizations(slug,name) values ('foreign','Foreign') returning id`;
    const [foreign] = await sql`insert into noelle.connections(org_id,kind,label,secret,invalid_at,in_use)
      values (${other!.id},'apify','foreign','test-only-token',now(),true) returning id`;
    await sql`insert into noelle.llm_calls
      (org_id,agent_role,worker,engine,model,bucket,cents,latency_ms,credential_id)
      values (${orgId},'x_intern','fixture','apify','fixture','discovery',237,0,${invalid}),
             (${orgId},'x_intern','fixture','apify','fixture','discovery',113,0,${invalid})`;
    expect(await pruneInvalidApifyTokens(sql, orgId)).toBe(1);
    expect(await pruneInvalidApifyTokens(sql, orgId)).toBe(0);
    const [retired] = await sql`select label,active,in_use from noelle.connections where id=${invalid}`;
    expect(retired).toEqual({ label: 'test credential', active: false, in_use: false });
    const [spend] = await sql`select sum(cents)::int as cents from noelle.llm_calls where credential_id=${invalid}`;
    expect(spend?.cents).toBe(350);
    const kept = await sql`select active,in_use from noelle.connections where id in (${healthy},${otherKind},${foreign!.id})`;
    expect(kept).toEqual(Array.from({ length: 3 }, () => ({ active: true, in_use: true })));
  });

  it("can retain a healthy timestamp while preserving the existing unconditional clear default", async () => {
    const id = await token();
    const old = new Date('2020-01-01T00:00:00Z');
    await sql`update noelle.connections set updated_at=${old} where id=${id}`;
    await clearApifyTokenExhausted(sql, id, { onlyIfFlagged: true });
    expect((await state(id)).updated_at).toEqual(old);
    await clearApifyTokenExhausted(sql, id);
    expect((await state(id)).updated_at.getTime()).toBeGreaterThan(old.getTime());
    await sql`update noelle.connections set invalid_at=now(),exhausted_at=now(),retry_at=now()+interval '1 day' where id=${id}`;
    await clearApifyTokenExhausted(sql, id, { onlyIfFlagged: true });
    expect(await state(id)).toMatchObject({ exhausted_at: null, retry_at: null, available: true });
    expect((await sql`select invalid_at from noelle.connections where id=${id}`)[0]?.invalid_at).toBeNull();
    const otherKind = await token("other");
    await sql`update noelle.connections set invalid_at=now(),updated_at=${old} where id=${otherKind}`;
    await clearApifyTokenExhausted(sql, otherKind); await clearApifyTokenExhausted(sql, crypto.randomUUID());
    const [untouched] = await sql`select invalid_at,updated_at from noelle.connections where id=${otherKind}`;
    expect(untouched?.invalid_at).not.toBeNull();
    expect(untouched?.updated_at).toEqual(old);
