import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";

const effects = vi.hoisted(() => ({ put: vi.fn(), remove: vi.fn(),
  onCheck: undefined as (() => Promise<void>) | undefined }));
vi.mock("../lib/auth.js", () => ({ resolveActiveInstanceForPlatform: async () => ({
  org_id: "00000000-0000-4000-8000-000000000002", agent_instance_id: "00000000-0000-4000-8000-000000000021",
}), isOrgMember: async (_user: string, org: string) => {
  await effects.onCheck?.(); return org === "00000000-0000-4000-8000-000000000001";
} }));
vi.mock("../lib/content-storage.js", () => ({ getContentStorage: () => ({ put: effects.put, delete: effects.remove }) }));
vi.mock("../env.js", () => ({ loadEnv: () => ({}) }));
import { contentMedia } from "./content-media.js";

const url = process.env.NOELLE_CONTENT_MEDIA_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001", foreign = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011", other = "00000000-0000-4000-8000-000000000012";
const foreignInstance = "00000000-0000-4000-8000-000000000021";
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => { c.set("auth", { userId: org, raw: {} }); await next(); });
app.route("/", contentMedia);

describe.skipIf(!url)("content media bindings (native PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const [db] = await sql`select current_database() as db`;
    if (db?.db !== "noelle_content_media_test") throw Error("Dedicated content media database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0045_post_ideas.sql", "0046_post_drafts.sql", "0057_content_media.sql", "0059_content_crossplatform.sql", "0060_post_draft_fields.sql", "0074_content_schedule_slots.sql", "0079_x_self_tracking.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    __setDbClientForTests(sql); effects.onCheck = undefined;
    effects.put.mockReset().mockResolvedValue({ url: "https://fixture.invalid/media" }); effects.remove.mockReset().mockResolvedValue(undefined);
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'one','One'),(${foreign},'two','Two')`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values
      (${instance},${org},'x_intern'),(${other},${org},'linkedin_intern'),(${foreignInstance},${foreign},'x_intern')`;
  });
  afterAll(async () => { resetDbClientForTests(); await sql?.end(); });
  async function seed(ownerOrg = org, owner = instance, platform = "x") {
    const [idea] = await sql`insert into noelle.post_ideas(org_id,agent_instance_id,platform,hook,status)
      values (${ownerOrg},${owner},'linkedin','Scoped idea','ready') returning id`;
    const [draft] = await sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,status)
      values (${ownerOrg},${owner},${idea!.id},${platform},'Reviewed body','ready') returning id`;
    return { ideaId: idea!.id as string, draftId: draft!.id as string };
  }
  function upload(binding: Record<string, unknown>) {
    return app.request("/api/content-media", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ mimeType: "image/png", dataBase64: "aGVsbG8=", ...binding }) });
  }
  async function asset(binding?: { ideaId: string; draftId: string }) {
    const [row] = await sql`insert into noelle.content_media(org_id,agent_instance_id,idea_id,draft_id,storage_key)
      values (${org},${binding ? instance : null},${binding?.ideaId ?? null},${binding?.draftId ?? null},${randomUUID()}) returning id`;
    return row!.id as string;
  }
  function patch(id: string, binding: Record<string, unknown>) {
    return app.request(`/api/content-media/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(binding) });
  }
  function remove(id: string) { return app.request(`/api/content-media/${id}`, { method: "DELETE" }); }

  it.each(["upload", "unlink", "delete"])("rejects %s while the parent is publishing", async action => {
    const own = await seed(), id = await asset(own);
    await sql`insert into noelle.content_schedule_slots(org_id,agent_instance_id,idea_id,draft_id,platform,slot_at,status)
      values (${org},${instance},${own.ideaId},${own.draftId},'x',now(),'publishing')`;
    const response = action === "upload" ? await upload({ draftId: own.draftId })
      : action === "unlink" ? await patch(id, { draftId: null, ideaId: null }) : await remove(id);
    expect(response.status).toBe(409); expect(effects.put).not.toHaveBeenCalled(); expect(effects.remove).not.toHaveBeenCalled();
  });
  it.each(["upload", "unlink", "relink", "delete"])("rejects %s on a published draft", async action => {
    const own = await seed(), id = await asset(action === "relink" ? undefined : own);
    await sql`update noelle.post_drafts set status='published' where id=${own.draftId}`;
    const response = action === "upload" ? await upload({ draftId: own.draftId }) : action === "delete" ? await remove(id)
      : await patch(id, action === "relink" ? { draftId: own.draftId } : { draftId: null, ideaId: null });
    expect(response.status).toBe(409); expect(effects.put).not.toHaveBeenCalled(); expect(effects.remove).not.toHaveBeenCalled();
  });
  it.each(["upload", "unlink", "delete"])("protects idea-shared media during %s after a sibling was posted manually", async action => {
    const own = await seed(), id = await asset(own);
    await sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,status)
      values (${org},${instance},${own.ideaId},'x','Published sibling','published')`;
    const response = action === "upload" ? await upload({ ideaId: own.ideaId })
      : action === "unlink" ? await patch(id, { draftId: null, ideaId: null }) : await remove(id);
    expect(response.status).toBe(409); expect(effects.put).not.toHaveBeenCalled(); expect(effects.remove).not.toHaveBeenCalled();
  });
  it("retains a durable deletion claim after storage failure, refuses relinking, and retries the same key", async () => {
    const own = await seed(), id = await asset(own);
    const [original] = await sql`select storage_key from noelle.content_media where id=${id}`;
    effects.remove.mockRejectedValueOnce(Error("storage unavailable"));
    expect((await remove(id)).status).toBe(503);
    expect((await sql`select status,storage_key,idea_id,draft_id from noelle.content_media where id=${id}`)[0])
      .toEqual({ status: "deleting", storage_key: original!.storage_key, idea_id: null, draft_id: null });
    expect((await patch(id, { draftId: own.draftId })).status).toBe(409);
    expect((await remove(id)).status).toBe(200); expect(await sql`select id from noelle.content_media where id=${id}`).toHaveLength(0);
    expect(effects.remove.mock.calls.map(call => call[0])).toEqual([original!.storage_key, original!.storage_key]);
  });
  it("cannot delete an asset moved to a foreign organization during authorization", async () => {
    const id = await asset(); effects.onCheck = async () => { effects.onCheck = undefined;
      await sql`update noelle.content_media set org_id=${foreign} where id=${id}`; };
    expect((await remove(id)).status).toBe(404); expect(effects.remove).not.toHaveBeenCalled();
    expect(await sql`select id from noelle.content_media where id=${id}`).toHaveLength(1);
  });
  it("waits for publication parent locks before deleting bytes and sees the committed publication", async () => {
    const own = await seed(), id = await asset(own);
    let unlock!: () => void, signal!: () => void;
    const locked = new Promise<void>(resolve => { signal = resolve; }), release = new Promise<void>(resolve => { unlock = resolve; });
    const publication = sql.begin(async tx => { await tx`update noelle.post_drafts set status='published' where id=${own.draftId}`;
      signal(); await release; });
    await locked; const deletion = remove(id);
    try { await new Promise(resolve => setTimeout(resolve, 30)); expect(effects.remove).not.toHaveBeenCalled(); }
    finally { unlock(); await publication; }
    expect((await deletion).status).toBe(409); expect(await sql`select id from noelle.content_media where id=${id}`).toHaveLength(1);
  });

  it("keeps an unbound library upload in the explicitly authorized organization", async () => {
    expect((await upload({ orgId: org })).status).toBe(200);
    expect((await sql`select org_id,agent_instance_id,idea_id,draft_id from noelle.content_media`)[0])
      .toEqual({ org_id: org, agent_instance_id: null, idea_id: null, draft_id: null });
    expect(effects.put.mock.calls[0]![0].key).toContain(org);
  });
  it("rejects a supplied organization that disagrees with the linked parent", async () => {
    const own = await seed(); expect((await upload({ orgId: foreign, draftId: own.draftId })).status).toBe(400);
    expect(effects.put).not.toHaveBeenCalled();
  });
  it("rejects an unbound upload without organization and a foreign library upload before storage", async () => {
    expect((await upload({})).status).toBe(400);
    expect((await upload({ orgId: foreign })).status).toBe(403);
    expect(effects.put).not.toHaveBeenCalled();
  });

  it.each(["foreign-idea", "different-idea", "detached-instance", "detached-parent", "wrong-platform"])(
    "rejects %s upload before writing bytes", async fault => {
      const own = await seed(); const detached = await seed(foreign, foreignInstance);
      const binding: Record<string, unknown> = { draftId: own.draftId, platform: "x" };
      if (fault === "foreign-idea") binding.ideaId = detached.ideaId;
      if (fault === "different-idea") binding.ideaId = (await seed()).ideaId;
      if (fault === "detached-instance") await sql`update noelle.post_drafts set agent_instance_id=${foreignInstance} where id=${own.draftId}`;
      if (fault === "detached-parent") await sql`update noelle.post_ideas set org_id=${foreign} where id=${own.ideaId}`;
      if (fault === "wrong-platform") binding.platform = "linkedin";
      expect((await upload(binding)).status).toBe(400);
      expect(effects.put).not.toHaveBeenCalled(); expect(await sql`select id from noelle.content_media`).toHaveLength(0);
    },
  );
  it("preserves a coherent X variant on a LinkedIn-home idea", async () => {
    const own = await seed(); expect((await upload({ draftId: own.draftId, platform: "x" })).status).toBe(200);
    expect((await sql`select idea_id,draft_id,org_id,agent_instance_id from noelle.content_media`)[0])
      .toEqual({ idea_id: own.ideaId, draft_id: own.draftId, org_id: org, agent_instance_id: instance });
  });
  it("rechecks parents after storage completes and removes an abandoned object", async () => {
    const own = await seed();
    effects.put.mockImplementationOnce(async () => { await sql`update noelle.post_ideas set org_id=${foreign} where id=${own.ideaId}`;
      return { url: "https://fixture.invalid/media" }; });
    expect((await upload({ draftId: own.draftId })).status).toBe(400);
    expect(effects.remove).toHaveBeenCalledOnce(); expect(await sql`select id from noelle.content_media`).toHaveLength(0);
  });
  it("commits the upload key before writing bytes and refuses mutation during the upload", async () => {
    const own = await seed();
    effects.put.mockImplementationOnce(async ({ key }) => {
      const [pending] = await sql`select id,org_id,storage_key,status,url from noelle.content_media`;
      expect(pending).toMatchObject({ org_id: org, storage_key: key, status: "uploading", url: null });
      expect((await patch(pending!.id, { ideaId: null, draftId: null })).status).toBe(409);
      expect((await remove(pending!.id)).status).toBe(409);
      expect(effects.remove).not.toHaveBeenCalled();
      return { url: "https://fixture.invalid/media" };
    });
    expect((await upload({ draftId: own.draftId })).status).toBe(200);
    expect((await sql`select status from noelle.content_media`)[0]).toEqual({ status: "ready" });
  });
  it.each(["storage", "parent"])("retains the key after a failed %s upload and failed compensation", async failure => {
    const own = await seed();
    effects.put.mockImplementationOnce(async () => {
      if (failure === "storage") throw Error("partial storage write");
      await sql`update noelle.post_ideas set org_id=${foreign} where id=${own.ideaId}`;
      return { url: "https://fixture.invalid/media" };
    });
    effects.remove.mockRejectedValueOnce(Error("cleanup unavailable"));
    expect((await upload({ draftId: own.draftId })).status).toBe(503);
    const [pending] = await sql`select id,status,storage_key,idea_id,draft_id from noelle.content_media`;
    expect(pending).toMatchObject({ status: "deleting", idea_id: null, draft_id: null });
    expect(pending!.storage_key).toBe(effects.put.mock.calls[0]![0].key);
    expect(effects.remove.mock.calls[0]![0]).toBe(pending!.storage_key);
    expect((await remove(pending!.id)).status).toBe(200);
    expect(effects.remove.mock.calls[1]![0]).toBe(pending!.storage_key);
    expect(await sql`select id from noelle.content_media`).toHaveLength(0);
  });
  it("does not dispatch storage when the durable upload record cannot be committed", async () => {
    await sql.unsafe(`create function noelle.reject_media_upload() returns trigger language plpgsql as $$ begin raise exception 'fixture insert failure'; end $$;
      create trigger reject_media_upload before insert on noelle.content_media for each row execute function noelle.reject_media_upload()`);
    try {
      expect((await upload({ orgId: org })).status).toBe(500);
      expect(effects.put).not.toHaveBeenCalled(); expect(effects.remove).not.toHaveBeenCalled();
      expect(await sql`select id from noelle.content_media`).toHaveLength(0);
    } finally {
      await sql.unsafe('drop trigger reject_media_upload on noelle.content_media; drop function noelle.reject_media_upload()');
    }
  });
  it("can clean up a crashed never-ready upload after its former parent was published", async () => {
    const own = await seed(), id = await asset(own);
    await sql`update noelle.content_media set status='uploading',url=null,
      updated_at=now()-interval '1 hour' where id=${id}`;
    await sql`update noelle.post_drafts set status='published' where id=${own.draftId}`;
    const [before] = await sql`select storage_key from noelle.content_media where id=${id}`;
    expect((await remove(id)).status).toBe(200);
    expect(effects.remove).toHaveBeenCalledWith(before!.storage_key);
    expect(await sql`select id from noelle.content_media where id=${id}`).toHaveLength(0);
  });
  it("retains a crashed upload cleanup claim when storage fails and retries its same key", async () => {
    const id = await asset();
    await sql`update noelle.content_media set status='uploading',url=null,
      updated_at=now()-interval '1 hour' where id=${id}`;
    const [before] = await sql`select storage_key from noelle.content_media where id=${id}`;
    effects.remove.mockRejectedValueOnce(Error("cleanup unavailable"));
    expect((await remove(id)).status).toBe(503);
    expect((await sql`select status,storage_key from noelle.content_media where id=${id}`)[0])
      .toEqual({ status: "deleting", storage_key: before!.storage_key });
    expect((await remove(id)).status).toBe(200);
    expect(effects.remove.mock.calls.map(call => call[0])).toEqual([before!.storage_key, before!.storage_key]);
  });
  it("does not clean up an active upload even when its persisted timestamp is old", async () => {
    effects.put.mockImplementationOnce(async () => {
      const [pending] = await sql`select id from noelle.content_media`;
      await sql`update noelle.content_media set updated_at=now()-interval '1 hour' where id=${pending!.id}`;
      expect((await remove(pending!.id)).status).toBe(409);
      expect(effects.remove).not.toHaveBeenCalled();
      return { url: "https://fixture.invalid/media" };
    });
    expect((await upload({ orgId: org })).status).toBe(200);
    expect((await sql`select status from noelle.content_media`)[0]).toEqual({ status: "ready" });
  });
  it("does not expire the upload lease under a shorter database idle timeout", async () => {
    const pool = postgres(url!, { max: 2, onnotice: () => {}, connection: { idle_in_transaction_session_timeout: 50 } });
    __setDbClientForTests(pool);
    effects.put.mockImplementationOnce(async () => {
      const [pending] = await sql`select id from noelle.content_media`;
      await sql`update noelle.content_media set updated_at=now()-interval '1 hour' where id=${pending!.id}`;
      await new Promise(resolve => setTimeout(resolve, 100));
      expect((await remove(pending!.id)).status).toBe(409);
      expect(effects.remove).not.toHaveBeenCalled();
      return { url: "https://fixture.invalid/media" };
    });
    try { expect((await upload({ orgId: org })).status).toBe(200); }
    finally { __setDbClientForTests(sql); await pool.end({ timeout: 0 }); }
  });
  it("finishes two parallel uploads using only their two transaction connections", async () => {
    const pool = postgres(url!, { max: 2, onnotice: () => {} });
    __setDbClientForTests(pool);
    let started = 0, safetyReleased = false, release!: () => void;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const both = new Promise<void>(resolve => { release = resolve; });
    const safety = setTimeout(() => { safetyReleased = true; release(); }, 1500);
    effects.put.mockImplementation(async () => {
      if (++started === 2) release();
      await both; return { url: "https://fixture.invalid/media" };
    });
    try {
      const requests = Promise.all([upload({ orgId: org }), upload({ orgId: org })]);
      const deadline = new Promise<never>((_resolve, reject) => { deadlineTimer = setTimeout(() => {
        void pool.end({ timeout: 0 }); reject(Error("parallel upload connection deadlock"));
      }, 3000).unref(); });
      const results = await Promise.race([requests, deadline]);
      expect(results.map(response => response.status)).toEqual([200, 200]);
      expect(started).toBe(2); expect(safetyReleased).toBe(false);
      expect(await sql`select id from noelle.content_media where status='ready'`).toHaveLength(2);
    } finally { clearTimeout(safety); clearTimeout(deadlineTimer); release(); __setDbClientForTests(sql); await pool.end({ timeout: 0 }); }
  });
  it("rejects an explicit draft and contradictory idea during relinking", async () => {
    const own = await seed(), different = await seed(), id = await asset();
    expect((await patch(id, { draftId: own.draftId, ideaId: different.ideaId })).status).toBe(400);
    expect((await sql`select draft_id,idea_id from noelle.content_media where id=${id}`)[0]).toEqual({ draft_id: null, idea_id: null });
  });
  it("idea-only relinking clears the prior draft and derives the new owning instance", async () => {
    const own = await seed(), next = await seed(org, other), id = await asset(own);
    expect((await patch(id, { ideaId: next.ideaId })).status).toBe(200);
    expect((await sql`select draft_id,idea_id,agent_instance_id from noelle.content_media where id=${id}`)[0])
      .toEqual({ draft_id: null, idea_id: next.ideaId, agent_instance_id: other });
  });
  it("does not overwrite a newer draft binding read after authorization", async () => {
    const own = await seed(), next = await seed(), id = await asset(own);
    effects.onCheck = async () => { effects.onCheck = undefined;
      await sql`update noelle.content_media set idea_id=${next.ideaId},draft_id=${next.draftId} where id=${id}`; };
    expect((await patch(id, { ideaId: next.ideaId })).status).toBe(200);
    expect((await sql`select draft_id,idea_id from noelle.content_media where id=${id}`)[0])
      .toEqual({ draft_id: next.draftId, idea_id: next.ideaId });
  });
  it("cannot relink an asset moved to a foreign organization during authorization", async () => {
    const own = await seed(), id = await asset();
    effects.onCheck = async () => { effects.onCheck = undefined; await sql`update noelle.content_media set org_id=${foreign} where id=${id}`; };
    expect((await patch(id, { draftId: own.draftId })).status).toBe(404);
    expect((await sql`select org_id,draft_id from noelle.content_media where id=${id}`)[0]).toEqual({ org_id: foreign, draft_id: null });
  });
});
