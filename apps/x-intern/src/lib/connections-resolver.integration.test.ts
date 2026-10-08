import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createApifyResolver } from "./apify-resolver.js";
import { createApifyShardResolver } from "./apify-shard-resolver.js";

const url = process.env.NOELLE_SHARED_APIFY_COOLDOWN_TEST_DATABASE_URL;
const old = new Date("2020-01-01T00:00:00.000Z");
const day = 86_400_000;

// The shared pool native suite prepares the real 0001/0033/0040/0041/0058 schema.
describe.skipIf(!url)("x Apify connections and resolver (native PostgreSQL)", () => {
  let sql: Sql;
  let orgId: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    if (!String(db?.name).includes("shared_apify_cooldown_test")) throw new Error("dedicated shared Apify test database required");
    await sql`select id, org_id, secret, in_use, invalid_at, exhausted_at, retry_at from noelle.connections limit 0`;
  });
  beforeEach(async () => {
    await sql`begin`;
    const [org] = await sql`insert into noelle.organizations(slug,name)
      values (${crypto.randomUUID()},'Apify resolver fixture') returning id`;
    orgId = org!.id as string;
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("provider dispatch forbidden in native resolver fixture"); }));
  });
  afterEach(async () => { await sql`rollback`; vi.unstubAllGlobals(); });
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
  it("resolves the measured first eligible credential without consulting env fallback", async () => {
    const id = await token(); await token({ exhausted: true, retry: new Date(Date.now() + day) });
    const args = deps(); const handle = await createApifyResolver(args)(orgId);
    expect(handle?.credentialId).toBe(id); expect(args.secrets.get).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("preserves the exact full cooling count and rejects before provider dispatch", async () => {
    for (let i = 0; i < 3; i++) await token({ exhausted: true, retry: new Date(Date.now() + day) });
    const args = deps(); const handle = await createApifyResolver(args)(orgId);
    expect(handle?.credentialId).toBeNull();
    await expect(handle!.client.userTweets({ handle: "fixture", limit: 1 })).rejects.toMatchObject({ name: "AllApifyTokensExhaustedError", tokenCount: 3 });
    expect(args.secrets.get).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("uses env fallback only for an empty DB pool and returns null when no env token exists", async () => {
    const args = deps(); expect((await createApifyResolver(args)(orgId))?.credentialId).toBeNull();
    expect(args.secrets.get).toHaveBeenCalledOnce();
    expect(await createApifyResolver(deps(vi.fn(async () => "")))(orgId)).toBeNull();
  });
  it("keeps shard credentials disjoint and returns one fail-closed handle for a cooling pool", async () => {
    const ids = [await token(), await token({ created: new Date(old.getTime() + day) })];
    const args = deps();
    expect((await createApifyShardResolver(args)(orgId, 8)).map(h => h.credentialId)).toEqual(ids);
    await sql`update noelle.connections set exhausted_at=now(),retry_at=now()+interval '1 day' where org_id=${orgId}`;
    const handles = await createApifyShardResolver(args)(orgId, 8); expect(handles).toHaveLength(1);
    await expect(handles[0]!.client.userTweets({ handle: "fixture", limit: 1 })).rejects.toMatchObject({ tokenCount: 2 });
    expect(fetch).not.toHaveBeenCalled(); expect(args.secrets.get).not.toHaveBeenCalled();
  });

});
