import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import postgres, { type Sql, type TransactionSql } from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

type RequestContext = { user: { id: string; email: string } | null; cookie: string; deleted: boolean };
const fixture = vi.hoisted(() => ({ sql: null as unknown as Sql,
  requests: null as unknown as AsyncLocalStorage<RequestContext>, afterLookup: null as null | (() => Promise<void>), revalidate: vi.fn() }));
fixture.requests = new AsyncLocalStorage<RequestContext>();
vi.mock("@/lib/db", () => ({
  sql: async (...args: unknown[]) => {
    const rows = await Reflect.apply(fixture.sql, undefined, args);
    if (/from noelle\.alpha_invitations/.test((args[0] as string[]).join(""))) await fixture.afterLookup?.();
    return rows;
  },
  withTx: (fn: (tx: TransactionSql) => Promise<unknown>) => fixture.sql.begin(fn),
}));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => fixture.requests.getStore()?.user ?? null }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: () => { throw new Error("Supabase forbidden"); } }));
vi.mock("next/headers", () => ({ cookies: async () => ({
  get: () => ({ value: fixture.requests.getStore()?.cookie }),
  delete: () => { fixture.requests.getStore()!.deleted = true; },
}) }));
vi.mock("next/cache", () => ({ revalidatePath: fixture.revalidate }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`fixture-redirect:${path}`); } }));
import { createOrgFromOnboarding } from "./actions";

const url = process.env.NOELLE_ONBOARDING_INVITE_TEST_DATABASE_URL;
const repo = resolve(import.meta.dirname, "../../../../..");
const user = { id: "00000000-0000-4000-8000-000000000001", email: "member@example.test" };
const other = { id: "00000000-0000-4000-8000-000000000002", email: "other@example.test" };
const code = "fixture-invitation", secret = "fixture-invite-secret";
function context(invite = code, member: typeof user | null = user): RequestContext {
  return { user: member, cookie: `${invite}.${createHmac("sha256", secret).update(invite).digest("hex")}`, deleted: false };
}
async function create(slug: string, request = context()) {
  const form = new FormData(); form.set("name", "Fixture organization"); form.set("slug", slug);
  return fixture.requests.run(request, async () => {
    try { return await createOrgFromOnboarding(undefined, form); }
    catch (error) {
      if (error instanceof Error && error.message === `fixture-redirect:/app/${slug}`) return { ok: true };
      throw error;
    }
  });
}
describe.skipIf(!url)("onboarding single-use invitations with native transactions", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = postgres(url!, { fetch_types: false, max: 6, onnotice: () => {}, connection: { statement_timeout: 2000, lock_timeout: 1000 } });
    expect((await sql`select current_database() as db`)[0]?.db).toBe("noelle_onboarding_invite_test");
    fixture.sql = sql;
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0015_auto_send.sql", "0016_alpha_invitations.sql", "0019_worker_enabled.sql", "0081_reply_send_enabled.sql"])
      await sql.unsafe(readFileSync(resolve(repo, "infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    vi.stubEnv("NOELLE_INVITE_COOKIE_SECRET", secret); vi.stubEnv("NOELLE_ALPHA_INVITE_CODES", ""); vi.stubEnv("NOELLE_AUTH_MODE", "supabase");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Fetch forbidden"); }));
    vi.spyOn(http, "request").mockImplementation(() => { throw new Error("HTTP forbidden"); });
    vi.spyOn(https, "request").mockImplementation(() => { throw new Error("HTTPS forbidden"); });
    fixture.afterLookup = null; fixture.revalidate.mockReset();
    await sql`drop trigger if exists suppress_redemption on noelle.alpha_invitations`;
    await sql`truncate noelle.organizations cascade`; await sql`truncate noelle.alpha_invitations`;
    await sql`insert into noelle.alpha_invitations(code) values (${code})`;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
  afterAll(async () => { await sql?.end(); });
  const counts = async () => (await sql`select
    (select count(*)::int from noelle.organizations) as orgs,
    (select count(*)::int from noelle.org_members) as members,
    (select count(*)::int from noelle.agent_instances) as agents`)[0];
  test("two signed-in requests can create only one organization from the same invitation", async () => {
    let arrived = 0, release!: () => void; const ready = new Promise<void>(resolve => { release = resolve; });
    fixture.afterLookup = async () => { if (++arrived === 2) release(); await ready; };
    const results = await Promise.all([create("first-org"), create("second-org", context(code, other))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(await counts()).toEqual({ orgs: 1, members: 1, agents: 1 });
    const [invite] = await sql`select redeemed_org_id,redeemed_by,status from noelle.alpha_invitations`;
    expect(invite!.status).toBe("redeemed");
    expect(await sql`select org_id,user_id from noelle.org_members`).toEqual([{ org_id: invite!.redeemed_org_id, user_id: invite!.redeemed_by }]);
  });
  test.each(["revoked", "expired", "recipient"] as const)("rechecks %s after the initial lookup", async variant => {
    fixture.afterLookup = async () => {
      fixture.afterLookup = null;
      if (variant === "revoked") await sql`update noelle.alpha_invitations set status='revoked'`;
      else if (variant === "expired") await sql`update noelle.alpha_invitations set expires_at=clock_timestamp()-interval '1 second'`;
      else await sql`update noelle.alpha_invitations set kind='email',email=${other.email}`;
    };
    expect((await create("stale-invite")).ok).toBe(false);
    expect(await counts()).toEqual({ orgs: 0, members: 0, agents: 0 });
    expect(fixture.revalidate).not.toHaveBeenCalled();
  });
  test("a suppressed invitation update rolls back the entire organization", async () => {
    await sql.unsafe("create or replace function noelle.suppress_redemption() returns trigger language plpgsql as $$ begin return null; end $$");
    await sql.unsafe("create trigger suppress_redemption before update on noelle.alpha_invitations for each row execute function noelle.suppress_redemption()");
    const request = context(); expect((await create("missing-receipt", request)).ok).toBe(false);
    expect(await counts()).toEqual({ orgs: 0, members: 0, agents: 0 }); expect(request.deleted).toBe(false);
    expect(fixture.revalidate).not.toHaveBeenCalled();
  });
  test("expiry during a real row-lock wait is checked against the post-wait clock", async () => {
    let unlock!: () => void, locked!: () => void;
    const release = new Promise<void>(resolve => { unlock = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    let holder: Promise<unknown> | undefined;
    fixture.afterLookup = async () => {
      fixture.afterLookup = null;
      holder = sql.begin(async tx => {
        await tx`update noelle.alpha_invitations set expires_at=clock_timestamp()+interval '0.1 seconds'`;
        locked(); await release;
      });
      await acquired;
    };
    const operation = create("waited-expiry");
    let result: Awaited<ReturnType<typeof create>> | undefined;
    try {
      const deadline = performance.now() + 1500; let waiting = false;
      while (performance.now() < deadline) {
        const rows = await sql`select pid from pg_stat_activity where datname=current_database()
          and pid<>pg_backend_pid() and wait_event_type='Lock' and query like '%alpha_invitations%'`;
        if (rows.length) { waiting = true; break; } await delay(5);
      }
      expect(waiting).toBe(true);
      await delay(120);
    } finally { unlock(); await holder; result = await operation; }
    expect(result?.ok).toBe(false);
    expect(await counts()).toEqual({ orgs: 0, members: 0, agents: 0 });
  });
  test("a healthy redemption commits membership, provisioning seeds and its exact receipt", async () => {
    const request = context(); expect(await create("healthy-org", request)).toEqual({ ok: true });
    expect(await counts()).toEqual({ orgs: 1, members: 1, agents: 1 }); expect(request.deleted).toBe(true);
    expect(await sql`select role,status,send_enabled,auto_send_enabled,reply_send_enabled from noelle.agent_instances`).toEqual([{ role: "x_intern", status: "paused", send_enabled: false, auto_send_enabled: false, reply_send_enabled: false }]);
    expect(fixture.revalidate).toHaveBeenCalledWith("/app/healthy-org");
  });
  test("local mode creates only a paused social channel without invitation access", async () => {
    vi.stubEnv("NOELLE_AUTH_MODE", "local");
    const request = { ...context(), cookie: "" };
    expect(await create("local-org", request)).toEqual({ ok: true });
    expect(request.deleted).toBe(false);
    expect(await counts()).toEqual({ orgs: 1, members: 1, agents: 1 });
    expect(await sql`select role,status,send_enabled,auto_send_enabled,reply_send_enabled from noelle.agent_instances`).toEqual([
      { role: "x_intern", status: "paused", send_enabled: false, auto_send_enabled: false, reply_send_enabled: false },
    ]);
    expect((await sql`select status from noelle.alpha_invitations`)[0]?.status).toBe("pending");
  });
  test("a slug collision leaves the invitation redeemable for a subsequent valid request", async () => {
    await sql`insert into noelle.organizations(slug,name) values ('taken','Existing')`;
    expect(await create("taken")).toMatchObject({ ok: false, fieldErrors: { slug: "Slug is taken." } });
    expect((await sql`select status from noelle.alpha_invitations`)[0]?.status).toBe("pending");
    expect(await create("new-slug")).toEqual({ ok: true });
  });
  test("legacy environment codes retain their configured reusable behavior", async () => {
    vi.stubEnv("NOELLE_ALPHA_INVITE_CODES", "legacy-fixture");
    expect(await create("legacy-one", context("legacy-fixture"))).toEqual({ ok: true });
    expect(await create("legacy-two", context("legacy-fixture", other))).toEqual({ ok: true });
    expect(await counts()).toEqual({ orgs: 2, members: 2, agents: 2 });
  });
  test("unsigned and unauthenticated requests cannot create an organization", async () => {
    const tampered = context(); tampered.cookie = "unsigned";
    expect((await create("tampered", tampered)).ok).toBe(false);
    expect((await create("signed-out", context(code, null))).ok).toBe(false);
    expect(await counts()).toEqual({ orgs: 0, members: 0, agents: 0 });
  });
});
