import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres, { type Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ sql: null as unknown as Sql }));
const org = "00000000-0000-4000-8000-000000000001", foreignOrg = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011", otherInstance = "00000000-0000-4000-8000-000000000012";
const videoInstance = "00000000-0000-4000-8000-000000000013", foreignInstance = "00000000-0000-4000-8000-000000000021";
const range = { from: "2000-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" };
vi.mock("react", () => ({ cache: <T>(fn: T) => fn }));
vi.mock("@/lib/db", () => ({
  sql: (...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args),
  readSql: (...args: unknown[]) => Reflect.apply(fixture.sql, undefined, args), pgOrgMembersClient: () => ({}),
}));
vi.mock("@/lib/auth-cookie", () => ({ getUserFromCookies: async () => ({ id: "fixture-member" }) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({}) }));
vi.mock("@noelle/runtime", () => ({ assertOrgMember: async (_db: unknown, _user: string, requestedOrg: string) => {
  if (requestedOrg !== org) throw new Error("fixture user is not a foreign org member");
} }));
import { getPostThread, listPostDraftsForOrg, getIntelligenceStatus } from "./posts-queries";
import { listScheduleSlotsForOrg, listComposeJobsForInstance, getTrendingRefs, getInstanceBrandConfig, getAgentPerformance, getPublishedPostPerformance } from "./schedule-queries";
import { listVideoDrafts } from "./video-studio-queries";

const url = process.env.NOELLE_DASHBOARD_SCOPE_TEST_DATABASE_URL;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
describe.skipIf(!url)("content read scope (dedicated native schemas)", () => {
  let sql: Sql;
  beforeAll(async () => {
    sql = postgres(url!, { max: 6, onnotice: () => {} });
    const [row] = await sql`select current_database() as db`;
    if (!row?.db.endsWith("_dashboard_scope_test")) throw new Error("Dedicated dashboard scope test database required");
    fixture.sql = sql;
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0025_agent_brand_config.sql", "0045_post_ideas.sql", "0046_post_drafts.sql", "0047_drafter_notes.sql", "0048_watchlist_playbooks.sql", "0057_content_media.sql", "0059_content_crossplatform.sql", "0060_post_draft_fields.sql", "0067_video_intern_studio.sql", "0074_content_schedule_slots.sql", "0079_x_self_tracking.sql"])
      await sql.unsafe(readFileSync(resolve(repo, "infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'fixture','Fixture'),(${foreignOrg},'foreign','Foreign')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,brand_config) values
      (${instance},${org},'x_intern','{}'),(${otherInstance},${org},'linkedin_intern','{}'),
      (${videoInstance},${org},'video_intern','{}'),(${foreignInstance},${foreignOrg},'x_intern','{"foreign":true}')`;
  });
  afterAll(async () => { await sql?.end(); });
  async function idea(ownerOrg = org, ownerInstance = instance, hook = "Scoped idea") {
    const [row] = await sql`insert into noelle.post_ideas(org_id,agent_instance_id,platform,target_platforms,hook,inspiration_refs)
      values (${ownerOrg},${ownerInstance},'linkedin',array['linkedin','x'],${hook},'[ {"url":"https://fixture.invalid/ref","note":"Fixture"} ]') returning id`;
    return row!.id as string;
  }
  async function draft(ideaId: string, ownerOrg = org, ownerInstance = instance, platform = "x") {
    const [row] = await sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body)
      values (${ownerOrg},${ownerInstance},${ideaId},${platform},'Draft body') returning id`; return row!.id as string;
  }
  async function slot(draftId: string | null, ideaId: string | null, ownerOrg = org, ownerInstance = instance, platform = "x", batchId: string | null = null) {
    const [row] = await sql`insert into noelle.content_schedule_slots(org_id,agent_instance_id,platform,slot_at,status,draft_id,idea_id,batch_id)
      values (${ownerOrg},${ownerInstance},${platform},now(),'ready',${draftId},${ideaId},${batchId}) returning id`; return row!.id as string;
  }
  async function metric(externalId: string, ownerOrg = org, ownerInstance = instance, slotId: string | null = null, ideaId: string | null = null, platform = "x") {
    await sql`insert into noelle.own_post_metrics(org_id,agent_instance_id,external_id,slot_id,idea_id,platform,likes,views)
      values (${ownerOrg},${ownerInstance},${externalId},${slotId},${ideaId},${platform},7,11)`;
  }

  it.each([[foreignOrg, foreignInstance], [org, otherInstance]])("draft board excludes a parent from %s/%s", async (parentOrg, parentInstance) => {
    const parent = await idea(parentOrg, parentInstance, "Detached parent"); await draft(parent);
    expect(await listPostDraftsForOrg(org)).toEqual([]);
  });
  it.each([[foreignOrg, foreignInstance], [org, otherInstance]])("thread excludes detached draft/note/media from %s/%s", async (childOrg, childInstance) => {
    const parent = await idea(); await draft(parent, childOrg, childInstance);
    await sql`insert into noelle.drafter_notes(org_id,agent_instance_id,idea_id,scope,role,body)
      values (${childOrg},${childInstance},${parent},'post','operator','Detached note')`;
    await sql`insert into noelle.content_media(org_id,agent_instance_id,idea_id,storage_key,url)
      values (${childOrg},${childInstance},${parent},${randomUUID()},'https://fixture.invalid/detached')`;
    const thread = await getPostThread(parent);
    expect({ drafts: thread?.drafts, notes: thread?.notes, media: thread?.media }).toEqual({ drafts: [], notes: [], media: [] });
  });
  it("preserves cross-platform versions and an org-shared null-instance asset", async () => {
    const parent = await idea(); await draft(parent); await draft(parent, org, instance, "linkedin");
    await sql`insert into noelle.content_media(org_id,agent_instance_id,idea_id,storage_key,url)
      values (${org},null,${parent},${randomUUID()},'https://fixture.invalid/shared')`;
    await sql`insert into noelle.drafter_notes(org_id,agent_instance_id,idea_id,scope,role,body)
      values (${org},${instance},${parent},'post','operator','Scoped note')`;
    const thread = await getPostThread(parent);
    expect(thread?.drafts.map((d) => d.platform).sort()).toEqual(["linkedin", "x"]); expect(thread?.media).toHaveLength(1); expect(thread?.notes).toHaveLength(1);
  });
  it.each(["foreign", "other-instance", "wrong-platform", "contradictory-idea"] as const)("calendar keeps the own slot but hides %s preview", async (variant) => {
    const parent = await idea(variant === "foreign" ? foreignOrg : org, variant === "other-instance" ? otherInstance : variant === "foreign" ? foreignInstance : instance, "Detached hook");
    const child = await draft(parent, variant === "foreign" ? foreignOrg : org, variant === "other-instance" ? otherInstance : variant === "foreign" ? foreignInstance : instance, variant === "wrong-platform" ? "linkedin" : "x");
    const id = await slot(child, variant === "contradictory-idea" ? await idea() : parent);
    const rows = await listScheduleSlotsForOrg(org, range); expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id, preview: null, hook: null });
  });
  it("calendar preserves a legacy null idea binding and LinkedIn-home X fanout", async () => {
    const parent = await idea(); const child = await draft(parent); await slot(child, null);
    expect((await listScheduleSlotsForOrg(org, range))[0]?.preview).toBe("Draft body");
  });
  it.each(["jobs", "trends", "brand", "performance", "intelligence", "metrics"] as const)("%s cannot read a foreign instance through an own org argument", async (kind) => {
    const parent = await idea(foreignOrg, foreignInstance); const child = await draft(parent, foreignOrg, foreignInstance); await slot(child, parent, foreignOrg, foreignInstance);
    await sql`insert into noelle.agent_compose_jobs(org_id,agent_instance_id,kind,prompt) values (${foreignOrg},${foreignInstance},'bulk_draft','Foreign prompt')`;
    await sql`insert into noelle.watchlist_playbooks(org_id,agent_instance_id,author_handle) values (${foreignOrg},${foreignInstance},'foreign')`;
    await metric("foreign", foreignOrg, foreignInstance);
    if (kind === "jobs") expect(await listComposeJobsForInstance(org, foreignInstance)).toEqual([]);
    if (kind === "trends") expect(await getTrendingRefs(org, foreignInstance)).toEqual([]);
    if (kind === "brand") expect(await getInstanceBrandConfig(org, foreignInstance)).toEqual({});
    if (kind === "performance") expect(await getAgentPerformance(org, foreignInstance)).toMatchObject({ byStatus: [], draftsThisWeek: 0 });
    if (kind === "intelligence") expect((await getIntelligenceStatus(org, foreignInstance)).playbookCount).toBe(0);
    if (kind === "metrics") expect((await getPublishedPostPerformance(org, foreignInstance)).posts).toEqual([]);
  });
  it("compose progress excludes a foreign-org or other-instance slot sharing its batch", async () => {
    const [job] = await sql`insert into noelle.agent_compose_jobs(org_id,agent_instance_id,kind) values (${org},${instance},'bulk_draft') returning id`;
    await slot(null, null, foreignOrg, foreignInstance, "x", job!.id); await slot(null, null, org, otherInstance, "linkedin", job!.id);
    expect((await listComposeJobsForInstance(org, instance))[0]?.items_drafted).toBe(0);
  });
  it("org-scoped records cannot make a foreign instance appear locally owned", async () => {
    await idea(org, foreignInstance);
    await sql`insert into noelle.agent_compose_jobs(org_id,agent_instance_id,kind) values (${org},${foreignInstance},'bulk_draft')`;
    await sql`insert into noelle.watchlist_playbooks(org_id,agent_instance_id,author_handle) values (${org},${foreignInstance},'contradictory')`;
    expect({ jobs: await listComposeJobsForInstance(org, foreignInstance), trends: await getTrendingRefs(org, foreignInstance), intelligence: (await getIntelligenceStatus(org, foreignInstance)).playbookCount })
      .toEqual({ jobs: [], trends: [], intelligence: 0 });
  });
  it.each([[foreignOrg, instance, "x"], [org, instance, "linkedin"], [org, foreignInstance, "x"]])("metrics refuse contradictory %s/%s/%s attribution", async (metricOrg, metricInstance, platform) => {
    await metric("detached", metricOrg, metricInstance, null, null, platform);
    expect((await getPublishedPostPerformance(org, metricInstance)).posts).toEqual([]);
  });
  it("an own metric retains counts without dereferencing a foreign slot/idea/draft", async () => {
    const parent = await idea(foreignOrg, foreignInstance); const child = await draft(parent, foreignOrg, foreignInstance); const id = await slot(child, parent, foreignOrg, foreignInstance);
    await metric("scoped", org, instance, id, parent);
    expect((await getPublishedPostPerformance(org, instance)).posts[0]).toMatchObject({ likes: 7, views: 11, url: null, preview: null });
  });
  it("fresh foreign impressions cannot replace a prior scoped snapshot", async () => {
    await metric("same-post"); await sql`update noelle.own_post_metrics set captured_at=now()-interval '1 minute'`;
    await metric("same-post", foreignOrg, instance); await sql`update noelle.own_post_metrics set likes=99,views=999 where org_id=${foreignOrg}`;
    expect((await getPublishedPostPerformance(org, instance)).posts[0]).toMatchObject({ likes: 7, views: 11 });
  });
  it("manual metric fallback never selects a foreign-org draft with an own instance soft reference", async () => {
    const parent = await idea(foreignOrg, foreignInstance); const child = await draft(parent, foreignOrg, instance);
    await sql`update noelle.post_drafts set posted_url='https://x.com/fixture/status/manual' where id=${child}`; await metric("manual");
    expect((await getPublishedPostPerformance(org, instance)).posts[0]).toMatchObject({ likes: 7, url: null, preview: null });
  });
  it("scoped compose, trends, brand, activity, playbooks and latest impressions remain visible", async () => {
    const [job] = await sql`insert into noelle.agent_compose_jobs(org_id,agent_instance_id,kind,prompt) values (${org},${instance},'bulk_draft','Scoped prompt') returning id`;
    const parent = await idea(), child = await draft(parent), id = await slot(child, parent, org, instance, "x", job!.id);
    await sql`update noelle.content_schedule_slots set status='published',published_at=now(),posted_url='https://x.com/fixture/status/owned' where id=${id}`;
    await sql`update noelle.post_drafts set final_body='Scoped final body' where id=${child}`;
    await sql`update noelle.agent_instances set brand_config='{"scoped":true}' where id=${instance}`;
    await sql`insert into noelle.watchlist_playbooks(org_id,agent_instance_id,author_handle) values (${org},${instance},'scoped')`;
    await metric("owned", org, instance, id, parent); await sql`update noelle.own_post_metrics set captured_at=now()-interval '1 minute'`;
    await metric("owned", org, instance, id, parent); await sql`update noelle.own_post_metrics set likes=9,views=null where captured_at>now()-interval '30 seconds'`;
    expect((await listComposeJobsForInstance(org, instance))[0]).toMatchObject({ prompt: "Scoped prompt", items_drafted: 1 });
    expect(await getTrendingRefs(org, instance)).toHaveLength(1); expect(await getInstanceBrandConfig(org, instance)).toEqual({ scoped: true });
    expect(await getAgentPerformance(org, instance)).toMatchObject({ publishedAllTime: 1, publishedThisWeek: 1, draftsThisWeek: 1 });
    expect((await getIntelligenceStatus(org, instance)).playbookCount).toBe(1);
    expect((await getPublishedPostPerformance(org, instance)).posts[0]).toMatchObject({ likes: 9, views: 11, url: "https://x.com/fixture/status/owned", preview: "Scoped final body" });
  });
  it("a scoped manually acknowledged draft retains its metric fallback", async () => {
    const parent = await idea(), child = await draft(parent);
    await sql`update noelle.post_drafts set posted_url='https://x.com/fixture/status/manual-owned',status='published' where id=${child}`; await metric("manual-owned");
    expect((await getPublishedPostPerformance(org, instance)).posts[0]).toMatchObject({ likes: 7, url: "https://x.com/fixture/status/manual-owned", preview: "Draft body" });
  });
  it.each([[foreignOrg, foreignInstance], [org, otherInstance]])("video draft excludes detached parent from %s/%s", async (parentOrg, parentInstance) => {
    const [parent] = await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook) values (${parentOrg},${parentInstance},'Detached video hook') returning id`;
    await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id,script) values (${org},${videoInstance},${parent!.id},'Scoped script')`;
    expect(await listVideoDrafts(videoInstance)).toEqual([]);
  });
  it("a scoped video draft keeps its idea hook and script", async () => {
    const [parent] = await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook) values (${org},${videoInstance},'Scoped video hook') returning id`;
    await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id,script) values (${org},${videoInstance},${parent!.id},'Scoped script')`;
    expect((await listVideoDrafts(videoInstance))[0]).toMatchObject({ idea_hook: "Scoped video hook", script: "Scoped script" });
  });
});
