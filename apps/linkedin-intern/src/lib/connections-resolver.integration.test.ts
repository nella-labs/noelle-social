import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearApifyTokenExhausted, clearApifyTokenInvalid } from "./connections-db.js";
import { createApifyResolver, createApifyPoolResolver } from "./apify-resolver.js";

const dedicatedUrl = process.env.NOELLE_LINKEDIN_APIFY_RESOLVER_TEST_DATABASE_URL;
const url = dedicatedUrl ?? process.env.NOELLE_SHARED_APIFY_COOLDOWN_TEST_DATABASE_URL;
const old = new Date("2020-01-01T00:00:00.000Z");
const day = 86_400_000;

// The shared pool suite prepares this schema; dedicated mode prepares it here.
describe.skipIf(!url)("linkedin Apify connections and resolver (native PostgreSQL)", () => {
  let sql: Sql;
  let orgId: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    const validDatabase = dedicatedUrl
      ? db?.name === "noelle_linkedin_apify_resolver_test"
      : String(db?.name).includes("shared_apify_cooldown_test");
    if (!validDatabase) {
      await sql.end({ timeout: 0 });
      throw new Error("dedicated Apify resolver test database required");
    }
    if (dedicatedUrl) {
      await sql`drop schema if exists noelle cascade`;
      for (const name of ["0001_noelle_schema.sql", "0033_connections_credentials.sql",
        "0040_connections_multi_token.sql", "0041_connections_token_retry.sql", "0058_connections_in_use.sql"]) {
        await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
      }
    }
    await sql`select id, org_id, secret, in_use, invalid_at, exhausted_at, retry_at from noelle.connections limit 0`;
  });
  beforeEach(async () => {
    const [org] = await sql`insert into noelle.organizations(slug,name)
      values (${crypto.randomUUID()},'Apify resolver fixture') returning id`;
    orgId = org!.id as string;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("provider dispatch forbidden in native resolver fixture"); }));
  });
  afterEach(async () => {
    await sql`delete from noelle.organizations where id=${orgId}`;
    vi.unstubAllGlobals();
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  async function token(args: { org?: string; kind?: string; active?: boolean; inUse?: boolean;
    invalid?: boolean; exhausted?: boolean; retry?: Date | null; created?: Date } = {}) {
    const [row] = await sql`insert into noelle.connections
      (org_id,kind,label,secret,active,in_use,invalid_at,exhausted_at,retry_at,created_at,updated_at)
      values (${args.org ?? orgId},${args.kind ?? "apify"},'fixture','test-only-token',
      ${args.active ?? true},${args.inUse ?? true},${args.invalid ? old : null},
      ${args.exhausted ? old : null},${args.retry ?? null},${args.created ?? old},${old}) returning id`;
    return row!.id as string;
  }
  const deps = (get = vi.fn(async () => "test-only-env-token")) => ({
    sql, secrets: { get }, apifyTokenSecretId: "fixture", log: { warn: vi.fn() },
  });
  const resolve = (kind: "single" | "pool", args = deps()) =>
    kind === "single" ? createApifyResolver(args) : createApifyPoolResolver(args);

  it.each(["single", "pool"] as const)("rejects a failed native %s read without selecting a legacy token", async kind => {
    const args = deps();
    await expect(resolve(kind, args)("invalid-fixture-uuid")).rejects.toMatchObject({ category: "database" });
    expect(args.secrets.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["single", "pool"] as const)("bounds a held-table %s read and recovers after release", async kind => {
    const id = await token();
    const args = deps();
    const locker = postgres(url!, { max: 1, onnotice: () => {} });
    let pending: Promise<string> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observed: string;
    try {
      await locker`begin`;
      await locker`lock table noelle.connections in access exclusive mode`;
      pending = resolve(kind, args)(orgId).then(() => "fulfilled", () => "rejected");
      observed = await Promise.race([
        pending,
        new Promise<string>(done => { timer = setTimeout(() => done("still pending"), 3400); }),
      ]);
      expect(args.secrets.get).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      await locker`rollback`;
      await pending;
      await locker.end({ timeout: 0 });
    }
    expect(observed!).toBe("rejected");
    const recovered = await resolve(kind, args)(orgId);
    expect(Array.isArray(recovered) ? recovered.map(row => row.credentialId) : recovered?.credentialId)
      .toEqual(kind === "pool" ? [id] : id);
    expect(args.secrets.get).not.toHaveBeenCalled();
    expect((await sql`select count(*)::int as n from pg_stat_activity
      where datname=current_database() and wait_event_type='Lock'
        and query like '%select id, secret,%'`)[0]?.n).toBe(0);
  }, 10_000);
  it("preserves the guarded clear wrapper timestamp for healthy and flagged credentials", async () => {
    const fresh = await token();
    const flagged = await token({ invalid: true, exhausted: true, retry: new Date(Date.now() + day) });
    await clearApifyTokenExhausted(sql, fresh); await clearApifyTokenExhausted(sql, flagged);
    expect((await sql`select updated_at from noelle.connections where id=${fresh}`)[0]?.updated_at).toEqual(old);
    expect((await sql`select exhausted_at,retry_at,invalid_at from noelle.connections where id=${flagged}`)[0])
      .toEqual({ exhausted_at: null, retry_at: null, invalid_at: null });
  });
  it("resolves the measured first eligible credential without consulting env fallback", async () => {
    const id = await token(); await token({ exhausted: true, retry: new Date(Date.now() + day) });
    const args = deps(); const handle = await createApifyResolver(args)(orgId);
    expect(handle?.credentialId).toBe(id); expect(args.secrets.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("retains the revalidation alias and its guarded timestamp semantics", async () => {
    const id = await token();
    await clearApifyTokenInvalid(sql, id);
    expect((await sql`select updated_at from noelle.connections where id=${id}`)[0]?.updated_at).toEqual(old);
    await sql`update noelle.connections set invalid_at=now(),retry_at=now()+interval '1 day' where id=${id}`;
    await clearApifyTokenInvalid(sql, id);
    expect((await sql`select invalid_at,retry_at from noelle.connections where id=${id}`)[0])
      .toEqual({ invalid_at: null, retry_at: null });
  });
  it("preserves the exact full cooling count and rejects before provider dispatch", async () => {
    for (let i = 0; i < 3; i++) await token({ exhausted: true, retry: new Date(Date.now() + day) });
    const args = deps(); const handle = await createApifyResolver(args)(orgId);
    expect(handle?.credentialId).toBeNull();
    await expect(handle!.client.profilePosts({ profileUrl: "https://www.linkedin.com/in/fixture/", maxPosts: 1 })).rejects.toMatchObject({ name: "AllApifyTokensExhaustedError", tokenCount: 3 });
    expect(args.secrets.get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("uses env fallback only for an empty DB pool and returns null when no env token exists", async () => {
    const args = deps(); expect((await createApifyResolver(args)(orgId))?.credentialId).toBeNull();
    expect(args.secrets.get).toHaveBeenCalledOnce();
    expect(await createApifyResolver(deps(vi.fn(async () => "")))(orgId)).toBeNull();
  });
  it("builds pool handles only for eligible IDs and never falls back for an all-cooling pool", async () => {
    const fresh = await token(); const reset = await token({ exhausted: true, retry: new Date(Date.now() - day) });
    await token({ exhausted: true, retry: new Date(Date.now() + day) }); await token({ inUse: false });
    const args = deps();
    expect((await createApifyPoolResolver(args)(orgId)).map(h => h.credentialId)).toEqual([fresh, reset]);
    await sql`update noelle.connections set exhausted_at=now(),retry_at=now()+interval '1 day' where org_id=${orgId}`;
    expect(await createApifyPoolResolver(args)(orgId)).toEqual([]);
    expect(args.secrets.get).not.toHaveBeenCalled();
  });

});
