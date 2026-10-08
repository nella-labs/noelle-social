import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";
import { contentSchedule } from "./content-schedule.js";

const membership = vi.hoisted(() => ({ allowed: true, onCheck: undefined as (() => Promise<void>) | undefined }));
vi.mock("../lib/auth.js", () => ({ isOrgMember: async () => {
  await membership.onCheck?.(); return membership.allowed;
} }));
const url = process.env.NOELLE_CONTENT_SCHEDULE_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const foreign = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011";
const otherInstance = "00000000-0000-4000-8000-000000000012";
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => { c.set("auth", { userId: org, raw: {} }); await next(); });
app.route("/", contentSchedule);

describe.skipIf(!url)("content schedule writes (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 5, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    if (!db?.name.endsWith("_content_schedule_test")) throw Error("Dedicated schedule test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0045_post_ideas.sql", "0046_post_drafts.sql", "0059_content_crossplatform.sql", "0060_post_draft_fields.sql", "0074_content_schedule_slots.sql", "0079_x_self_tracking.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    __setDbClientForTests(sql); membership.allowed = true; membership.onCheck = undefined;
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'one','One'),(${foreign},'two','Two')`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values (${instance},${org},'x_intern'),(${otherInstance},${foreign},'x_intern')`;
  });
  afterAll(async () => { resetDbClientForTests(); await sql?.end(); });
  async function seed(platform = "x") {
    const [idea] = await sql`insert into noelle.post_ideas(org_id,agent_instance_id,platform,hook,status)
      values (${org},${instance},'x','A concrete finding','ready') returning id`;
    const [draft] = await sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,status)
      values (${org},${instance},${idea!.id},${platform},'Reviewed original','ready') returning id`;
    return { ideaId: idea!.id as string, draftId: draft!.id as string };
  }
  function create(draftId?: string, platform = "x", autoPublish = false) {
    return app.request("/api/content/slots", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: instance, platform, slotAt: "2026-10-07T14:00:00Z", draftId, autoPublish }) });
  }
  async function slot() {
    const d = await seed();
    const [row] = await sql`insert into noelle.content_schedule_slots(org_id,agent_instance_id,platform,slot_at,status,idea_id,draft_id,auto_publish)
      values (${org},${instance},'x','2026-10-07T14:00:00Z','ready',${d.ideaId},${d.draftId},true) returning id`;
    return row!.id as string;
  }
  function mutate(id: string, method: "PATCH" | "DELETE") {
    return app.request(`/api/content/slots/${id}`, { method, headers: { "content-type": "application/json" },
      ...(method === "PATCH" ? { body: JSON.stringify({ slotAt: "2026-10-08T14:00:00Z" }) } : {}) });
  }

  it("derives an owned manual draft's idea binding", async () => {
    const d = await seed(); expect((await create(d.draftId, "x", true)).status).toBe(201);
    expect((await sql`select idea_id,draft_id from noelle.content_schedule_slots`)[0])
      .toEqual({ idea_id: d.ideaId, draft_id: d.draftId });
  });
  it("preserves a reviewed cross-platform variant on its idea's owning instance", async () => {
    const d = await seed("linkedin"); expect((await create(d.draftId, "linkedin")).status).toBe(201);
  });
  it.each(["draft-org", "draft-instance", "draft-platform", "idea-org", "idea-instance", "idea-dismissed", "idea-published", "dismissed", "published", "receipt"])(
    "rejects a manual %s soft binding before creating a slot", async fault => {
      const d = await seed();
      if (fault === "draft-org") await sql`update noelle.post_drafts set org_id=${foreign} where id=${d.draftId}`;
      if (fault === "draft-instance") await sql`update noelle.post_drafts set agent_instance_id=${otherInstance} where id=${d.draftId}`;
      if (fault === "draft-platform") await sql`update noelle.post_drafts set platform='linkedin' where id=${d.draftId}`;
      if (fault === "idea-org") await sql`update noelle.post_ideas set org_id=${foreign} where id=${d.ideaId}`;
      if (fault === "idea-instance") await sql`update noelle.post_ideas set agent_instance_id=${otherInstance} where id=${d.ideaId}`;
      if (fault === "idea-dismissed" || fault === "idea-published") await sql`update noelle.post_ideas set status=${fault.slice(5)} where id=${d.ideaId}`;
      if (fault === "dismissed" || fault === "published") await sql`update noelle.post_drafts set status=${fault} where id=${d.draftId}`;
      if (fault === "receipt") await sql`update noelle.post_drafts set posted_url='https://x.com/operator/status/123' where id=${d.draftId}`;
      expect((await create(d.draftId)).status).toBe(400);
      expect(await sql`select id from noelle.content_schedule_slots`).toHaveLength(0);
    });
  it("rejects automatic publication of another platform on an X instance", async () => {
    expect((await create(undefined, "linkedin", true)).status).toBe(403);
  });
  it("returns a conflict when an owned draft already has a slot", async () => {
    const d = await seed(); expect((await create(d.draftId)).status).toBe(201);
    expect((await create(d.draftId)).status).toBe(409);
  });

  for (const method of ["PATCH", "DELETE"] as const) {
    it(`${method} applies to an eligible owned slot`, async () => {
      const id = await slot(); expect((await mutate(id, method)).status).toBe(200);
      const [row] = await sql`select status,slot_at from noelle.content_schedule_slots where id=${id}`;
      expect(row?.status).toBe(method === "PATCH" ? "ready" : "skipped");
      expect(new Date(row!.slot_at).toISOString()).toBe(method === "PATCH" ? "2026-10-08T14:00:00.000Z" : "2026-10-07T14:00:00.000Z");
    });
    it.each(["publishing", "published", "receipt"])(`${method} preserves a committed %s change after authorization read`, async state => {
      const id = await slot();
      membership.onCheck = async () => {
        membership.onCheck = undefined;
        if (state === "receipt") await sql`update noelle.content_schedule_slots set status='failed',posted_tweet_id='123' where id=${id}`;
        else await sql`update noelle.content_schedule_slots set status=${state} where id=${id}`;
      };
      expect((await mutate(id, method)).status).toBe(409);
      const [row] = await sql`select status,slot_at,posted_tweet_id from noelle.content_schedule_slots where id=${id}`;
      expect(row?.status).toBe(state === "receipt" ? "failed" : state);
      expect(new Date(row!.slot_at).toISOString()).toBe("2026-10-07T14:00:00.000Z");
      expect(row?.posted_tweet_id).toBe(state === "receipt" ? "123" : null);
    });
    it(`${method} rechecks a publishing transition committed while its UPDATE waits`, async () => {
      const id = await slot(); let release!: () => void; let transaction: Promise<unknown> | undefined;
      const held = new Promise<void>(resolve => { release = resolve; });
      membership.onCheck = async () => {
        membership.onCheck = undefined;
        let ready!: () => void; const locked = new Promise<void>(resolve => { ready = resolve; });
        transaction = sql.begin(async tx => { await tx`update noelle.content_schedule_slots set status='publishing' where id=${id}`; ready(); await held; });
        await locked;
      };
      const response = mutate(id, method);
      try {
        let waiting = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const [row] = await sql`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock') as waiting`;
          if (row?.waiting) { waiting = true; break; }
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        expect(waiting).toBe(true);
      } finally { release(); await transaction; }
      expect((await response).status).toBe(409);
      expect((await sql`select status from noelle.content_schedule_slots where id=${id}`)[0]?.status).toBe("publishing");
    });
  }
  it("keeps membership denial free of calendar writes", async () => {
    membership.allowed = false; expect((await create()).status).toBe(403);
    expect(await sql`select id from noelle.content_schedule_slots`).toHaveLength(0);
  });
  it("does not follow an instance moved to another organization during authorization", async () => {
    await sql`update noelle.agent_instances set role='linkedin_intern' where id=${otherInstance}`;
    membership.onCheck = async () => { membership.onCheck = undefined;
      await sql`update noelle.agent_instances set org_id=${foreign} where id=${instance}`; };
    expect((await create()).status).toBe(404);
    expect(await sql`select id from noelle.content_schedule_slots`).toHaveLength(0);
  });
  function bulk(platform = "x", autoPublish = true) {
    return app.request("/api/content/slots/bulk", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: instance, platform, perDay: 2, days: 1, startDate: "2026-10-07", autoPublish }) });
  }
  it("creates an explicit owned X compose batch with bound ideas", async () => {
    expect((await bulk()).status).toBe(201);
    expect(await sql`select id from noelle.agent_compose_jobs`).toHaveLength(1);
    expect(await sql`select s.id from noelle.content_schedule_slots s join noelle.post_ideas i on i.id=s.idea_id
      where s.org_id=${org} and s.agent_instance_id=${instance} and i.org_id=s.org_id and i.agent_instance_id=s.agent_instance_id
        and s.platform='x' and s.auto_publish=true`).toHaveLength(2);
  });
  it("rejects another platform's automatic compose before creating a job", async () => {
    expect((await bulk("linkedin")).status).toBe(403);
    expect(await sql`select id from noelle.agent_compose_jobs`).toHaveLength(0);
  });
  it("rechecks the compose owner's role after authorization", async () => {
    membership.onCheck = async () => { membership.onCheck = undefined;
      await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`; };
    expect((await bulk()).status).toBe(403);
    expect(await sql`select id from noelle.agent_compose_jobs`).toHaveLength(0);
  });
});
