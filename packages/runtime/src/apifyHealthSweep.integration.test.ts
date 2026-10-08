import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { healthFixture } from "./apifyHealthSweep.fixture.js";
import { listApifyTokensForHealthSweep, markApifyTokenInvalid, withApifyCredentialDb } from "./apifyPoolDb.js";

const url = process.env.NOELLE_APIFY_HEALTH_TEST_DATABASE_URL;
const alive = { alive: true, httpStatus: 200 };
const dead = { alive: false, httpStatus: 401 };
describe.skipIf(!url)("Apify health receipts (native PostgreSQL)", () => {
  const f = healthFixture(url!);
  const { sql, orgId, foreignOrgId, state, token, sweep } = f;
  beforeAll(f.setup);
  beforeEach(f.reset);
  afterAll(async () => { await sql.end({ timeout: 0 }); });

  it("probes all eligible tokens beyond 64, including parked and cooling rows", async () => {
    const ids = [];
    for (let n = 0; n < 70; n++) ids.push(await token());
    await sql`update noelle.connections set in_use=false where id=${ids[65]!}`;
    await sql`update noelle.connections set exhausted_at=now(),retry_at=now()+interval '30 days' where id=${ids[66]!}`;
    await sql`update noelle.connections set active=false where id=${ids[67]!}`;
    await sql`update noelle.connections set invalid_at=now() where id=${ids[68]!}`;
    await sql`update noelle.connections set org_id=${foreignOrgId} where id=${ids[69]!}`;
    const selected = (await listApifyTokensForHealthSweep(sql, orgId)).map(row => row.credentialId);
    expect(selected).toEqual(ids.slice(0, 67));
    let checked = 0;
    expect(await sweep(async () => { checked++; return alive; }))
      .toEqual({ pruned: 0, checked: 67, invalidated: 0, alive: 67, inconclusive: 0 });
    expect(checked).toBe(67);
  });

  it("reports a valid definitive 401 once, preserving the exact stored whitespace key", async () => {
    const id = await token(" fixture-value ");
    expect((await sweep(async value => { expect(value).toBe(" fixture-value "); return dead; })).invalidated).toBe(1);
    expect((await state(id))?.invalid_at).not.toBeNull();
    expect(await markApifyTokenInvalid(sql, { orgId, credentialId: id, token: " fixture-value " })).toBe(false);
  });

  it.each(["org", "key", "delete", "invalid", "kind", "inactive"])(
    "does not acknowledge stale %s credential identity after a provider probe",
    async change => {
      const id = await token();
      const result = await sweep(async () => {
        if (change === "org") await sql`update noelle.connections set org_id=${foreignOrgId} where id=${id}`;
        if (change === "key") await sql`update noelle.connections set secret='replacement-fixture' where id=${id}`;
        if (change === "delete") await sql`delete from noelle.connections where id=${id}`;
        if (change === "invalid") await sql`update noelle.connections set invalid_at=now() where id=${id}`;
        if (change === "kind") await sql`update noelle.connections set kind='other' where id=${id}`;
        if (change === "inactive") await sql`update noelle.connections set active=false where id=${id}`;
        return dead;
      });
      expect(result).toEqual({ pruned: 0, checked: 1, invalidated: 0, alive: 0, inconclusive: 1 });
      if (change === "delete") expect(await state(id)).toBeUndefined();
      else if (change === "invalid") expect((await state(id))?.invalid_at).not.toBeNull();
      else expect((await state(id))?.invalid_at).toBeNull();
    },
  );

  it("acknowledges exactly one concurrent current-key invalidation", async () => {
    const id = await token();
    const claim = { orgId, credentialId: id, token: "fixture-value" };
    const receipts = await Promise.all(Array.from({ length: 8 }, () => markApifyTokenInvalid(sql, claim)));
    expect(receipts.filter(Boolean)).toHaveLength(1);
  });

  it("holds no database transaction through provider work", async () => {
    await token();
    expect((await sweep(async () => {
      const [row] = await sql`select count(*)::int as n from pg_stat_activity
        where datname=current_database() and application_name='apify-health-native' and state='idle in transaction'`;
      expect(row?.n).toBe(0);
      return alive;
    })).alive).toBe(1);
  });

  it("bounds held credential writes, rejects excess queue admission, and recovers without late writes", async () => {
    const id = await token();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const holder = sql.begin(async tx => {
      await tx`select id from noelle.connections where id=${id} for no key update`;
      acquired(); await gate;
    });
    await ready;
    const claim = { orgId, credentialId: id, token: "fixture-value" };
    const operations = Array.from({ length: 35 }, () => markApifyTokenInvalid(sql, claim));
    const outcomes = Promise.allSettled(operations);
    try {
      await vi.waitFor(async () => {
        const [row] = await sql`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and application_name='apify-health-native'
            and wait_event_type='Lock' and query like '%for no key update%'`;
        expect(row?.n).toBe(1);
      }, { timeout: 1200, interval: 20 });
      const settled = await outcomes;
      expect(settled.every(row => row.status === "rejected")).toBe(true);
      const categories = settled.map(row => row.status === "rejected" ? row.reason.category : null);
      expect(categories.filter(value => value === "queue_full")).toHaveLength(3);
      expect(categories).toContain("deadline");
    } finally { release(); await holder; await outcomes; }
    expect((await state(id))?.invalid_at).toBeNull();
    expect((await sql`select 1 as healthy`)[0]?.healthy).toBe(1);
    expect(await markApifyTokenInvalid(sql, claim)).toBe(true);
    const ownedPid = await withApifyCredentialDb(sql, async connection => {
      const [row] = await connection`select pg_backend_pid() as pid`;
      return row!.pid as number;
    });
    await vi.waitFor(async () => {
      const [row] = await sql`select count(*)::int as n from pg_stat_activity where pid=${ownedPid}`;
      expect(row?.n).toBe(0);
    }, { timeout: 2500, interval: 50 });
  }, 8000);

  it.each(["org", "key"])("rechecks committed %s changes after waiting for the credential lock", async change => {
    const id = await token();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const holder = sql.begin(async tx => {
      if (change === "org") await tx`update noelle.connections set org_id=${foreignOrgId} where id=${id}`;
      else await tx`update noelle.connections set secret='replacement' where id=${id}`;
      acquired(); await gate;
    });
    await ready;
    const writing = markApifyTokenInvalid(sql, { orgId, credentialId: id, token: "fixture-value" });
    try {
      await vi.waitFor(async () => {
        const [row] = await sql`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and application_name='apify-health-native'
            and wait_event_type='Lock' and query like '%for no key update%'`;
        expect(row?.n).toBe(1);
      }, { timeout: 800, interval: 10 });
    } finally { release(); await holder; }
    expect(await writing).toBe(false);
    expect((await state(id))?.invalid_at).toBeNull();
  });

  it("reports a blocked invalidation as inconclusive and never writes after lock release", async () => {
    const id = await token();
    let release!: () => void;
    let acquired!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { acquired = resolve; });
    const holder = sql.begin(async tx => {
      await tx`select id from noelle.connections where id=${id} for no key update`;
      acquired(); await gate;
    });
    await ready;
    try {
      expect(await sweep(async () => dead))
        .toEqual({ pruned: 0, checked: 1, invalidated: 0, alive: 0, inconclusive: 1 });
    } finally { release(); await holder; }
    expect((await state(id))?.invalid_at).toBeNull();
  });

  it("reports exact retired, checked, alive and inconclusive counts", async () => {
    const invalid = await token();
    await sql`update noelle.connections set invalid_at=now() where id=${invalid}`;
    await token(); await token();
    let checked = 0;
    expect(await sweep(async () => ++checked === 1 ? alive : { alive: false, httpStatus: 429 }, true))
      .toEqual({ pruned: 1, checked: 2, invalidated: 0, alive: 1, inconclusive: 1 });
    expect((await state(invalid))?.active).toBe(false);
  });
});
