import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { signHmacBody } from "../middleware/hmac.js";
import type { Context } from "hono";

const fixture = vi.hoisted(() => ({ resolve: vi.fn() }));
const org = "00000000-0000-4000-8000-000000000001", otherOrg = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011", other = "00000000-0000-4000-8000-000000000012";
const foreignInstance = "00000000-0000-4000-8000-000000000021", secret = "synthetic-media-secret".repeat(2);
vi.mock("../lib/auth.js", () => ({ isOrgMember: async (_user: string, requested: string) => requested === "00000000-0000-4000-8000-000000000001" }));
vi.mock("../lib/content-storage.js", () => ({ getContentStorage: () => ({ resolveUrl: fixture.resolve }) }));
vi.mock("../env.js", () => ({ loadEnv: () => ({ NOELLE_HMAC_SECRET: "synthetic-media-secret".repeat(2) }) }));
vi.mock("../middleware/jwt.js", () => ({ requireUserJwt: async (c: Context, next: () => Promise<void>) => {
  c.set("auth", { userId: "fixture-member", raw: {} }); await next();
} }));
vi.mock("../middleware/ratelimit.js", () => ({ requireRateLimit: async (_c: unknown, next: () => Promise<void>) => next() }));
import { createApp } from "../app.js";
const app = createApp(), url = process.env.NOELLE_MEDIA_READ_TEST_DATABASE_URL;

describe.skipIf(!url)("current media read links (native PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [database] = await sql`select current_database() as db`;
    if (database?.db !== "noelle_content_media_read_test") throw Error("Dedicated media read database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0045_post_ideas.sql", "0046_post_drafts.sql", "0057_content_media.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    __setDbClientForTests(sql); fixture.resolve.mockReset().mockImplementation(async key => `https://storage.googleapis.com/fixture/${key}?fresh=1`);
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'one','One'),(${otherOrg},'two','Two')`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values
      (${instance},${org},'x_intern'),(${other},${org},'linkedin_intern'),(${foreignInstance},${otherOrg},'x_intern')`;
  });
  afterAll(async () => { resetDbClientForTests(); await sql?.end(); });
  async function asset(owner = org, ownerInstance: string | null = null, status = "ready") {
    const id = randomUUID(), key = `${owner}/media/${id}.png`;
    await sql`insert into noelle.content_media(id,org_id,agent_instance_id,storage_key,url,status)
      values (${id},${owner},${ownerInstance},${key},'https://storage.googleapis.com/fixture/expired?X-Goog-Signature=old',${status})`;
    return { id, key };
  }
  function request(body: unknown, worker = false, signed = true) {
    const json = JSON.stringify(body), hmac = signHmacBody(secret, Math.floor(Date.now() / 1000), json);
    return app.request(`/api/content-media/${worker ? "resolve-worker" : "resolve"}`, { method: "POST",
      headers: { "content-type": "application/json", ...(worker && signed ? {
        "x-noelle-timestamp": hmac.timestamp, "x-noelle-signature": hmac.signature,
      } : {}) }, body: json });
  }
  it("mints a fresh transferable URL without changing the stored fingerprint", async () => {
    const media = await asset(); const [before] = await sql`select to_jsonb(m)::text as fingerprint from noelle.content_media m`;
    const response = await request({ orgId: org, ids: [media.id] });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ media: [{ id: media.id, url: `https://storage.googleapis.com/fixture/${media.key}?fresh=1` }] });
    expect(fixture.resolve).toHaveBeenCalledWith(media.key);
    expect((await sql`select to_jsonb(m)::text as fingerprint from noelle.content_media m`)[0]).toEqual(before);
  });
  it("checks JWT organization membership before signing", async () => {
    const media = await asset(otherOrg, foreignInstance);
    expect((await request({ orgId: otherOrg, ids: [media.id] })).status).toBe(403);
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("requires existing HMAC authentication for worker reads", async () => {
    const media = await asset(); expect((await request({ orgId: org, agentInstanceId: instance, ids: [media.id] }, true, false)).status).toBe(401);
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("rejects an organization/instance disagreement before signing", async () => {
    const media = await asset(); expect((await request({ orgId: org, agentInstanceId: foreignInstance, ids: [media.id] }, true)).status).toBe(400);
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("preserves instance-owned and shared assets while excluding other instances and tenants", async () => {
    const own = await asset(org, instance), shared = await asset(), detached = await asset(org, other), foreign = await asset(otherOrg, foreignInstance);
    const response = await request({ orgId: org, agentInstanceId: instance, ids: [own.id, shared.id, detached.id, foreign.id] }, true);
    expect(response.status).toBe(200); const result = await response.json() as { media: Array<{ id: string }> };
    expect(result.media.map((row: { id: string }) => row.id).sort()).toEqual([own.id, shared.id].sort());
    expect(fixture.resolve).toHaveBeenCalledTimes(2);
  });
  it.each(["uploading", "deleting", "failed"])("does not mint a read link for %s storage", async status => {
    const media = await asset(org, null, status), response = await request({ orgId: org, ids: [media.id] });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ media: [] }); expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("never falls back to an expired stored URL after signing failure", async () => {
    const media = await asset(); fixture.resolve.mockRejectedValueOnce(Error("signing unavailable"));
    const response = await request({ orgId: org, ids: [media.id] });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ media: [{ id: media.id, url: null }] });
  });
  it("does not sign a shared asset linked to a different worker instance", async () => {
    const media = await asset(), idea = randomUUID();
    await sql`insert into noelle.post_ideas(id,org_id,agent_instance_id,platform,hook) values (${idea},${org},${other},'x','Fixture')`;
    await sql`update noelle.content_media set idea_id=${idea} where id=${media.id}`;
    const response = await request({ orgId: org, agentInstanceId: instance, ids: [media.id] }, true);
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ media: [] }); expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("does not sign a draft whose instance belongs to another organization", async () => {
    const media = await asset(), idea = randomUUID(), draft = randomUUID();
    await sql`insert into noelle.post_ideas(id,org_id,agent_instance_id,platform,hook) values (${idea},${org},${foreignInstance},'x','Fixture')`;
    await sql`insert into noelle.post_drafts(id,org_id,agent_instance_id,idea_id,platform,body) values (${draft},${org},${foreignInstance},${idea},'x','Fixture')`;
    await sql`update noelle.content_media set draft_id=${draft} where id=${media.id}`;
    const response = await request({ orgId: org, ids: [media.id] });
    expect(response.status).toBe(200); expect(await response.json()).toEqual({ media: [] }); expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("does not resolve a key in another organization's storage namespace", async () => {
    const media = await asset(); await sql`update noelle.content_media set storage_key=${`${otherOrg}/media/${media.id}.png`} where id=${media.id}`;
    expect(await (await request({ orgId: org, ids: [media.id] })).json()).toEqual({ media: [] }); expect(fixture.resolve).not.toHaveBeenCalled();
  });
  it("signs a full batch concurrently after releasing the database read", async () => {
    const assets = await Promise.all(Array.from({ length: 4 }, () => asset()));
    let active = 0, maximum = 0;
    fixture.resolve.mockImplementation(async key => {
      active++; maximum = Math.max(maximum, active);
      await sql`select pg_sleep(0.01)`; active--;
      return `https://storage.googleapis.com/fixture/${key}?fresh=1`;
    });
    const response = await request({ orgId: org, ids: assets.map(row => row.id) });
    expect(response.status).toBe(200); expect((await response.json() as { media: unknown[] }).media).toHaveLength(4); expect(maximum).toBe(4);
  });
  it("returns an unavailable link if a signer produces an invalid receipt URL", async () => {
    const media = await asset(); fixture.resolve.mockResolvedValueOnce("javascript:alert(1)");
    expect(await (await request({ orgId: org, ids: [media.id] })).json()).toEqual({ media: [{ id: media.id, url: null }] });
  });
  it("rejects an excessive signing batch before storage work", async () => {
    expect((await request({ orgId: org, ids: Array.from({ length: 5 }, () => randomUUID()) })).status).toBe(400);
    expect(fixture.resolve).not.toHaveBeenCalled();
  });
});
