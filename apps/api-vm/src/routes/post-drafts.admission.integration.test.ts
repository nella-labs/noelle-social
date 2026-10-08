import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { postDrafts } from "./post-drafts.js";

const settings = vi.hoisted(() => ({ enabled: false }));
vi.mock("../env.js", () => ({ loadEnv: () => ({
  NOELLE_POST_AUTOSCHEDULE: settings.enabled, NOELLE_POST_AUTOSCHEDULE_MIN_SCORE: 70,
  NOELLE_POST_AUTOSCHEDULE_AUTOPUBLISH: false, NOELLE_POST_AUTOSCHEDULE_SPACING_MIN: 180,
  NOELLE_POST_AUTOSCHEDULE_LEAD_MIN: 15,
}) }));
const url = process.env.NOELLE_X_POST_ADMISSION_TEST_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const instance = "00000000-0000-4000-8000-000000000011";

describe.skipIf(!url)("post draft admission (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    sql = postgres(url!, { max: 12, onnotice: () => {} });
    const [row] = await sql`select current_database() as name`;
    if (!row?.name.endsWith("_x_post_admission_test")) throw new Error("refusing to reset a non-dedicated database");
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0045_post_ideas.sql", "0046_post_drafts.sql", "0059_content_crossplatform.sql", "0060_post_draft_fields.sql", "0074_content_schedule_slots.sql", "0100_post_generation_requests.sql"])
      await sql.unsafe(readFileSync(resolve("../../infra/cloudsql/schema", file), "utf8"));
  });
  beforeEach(async () => {
    settings.enabled = false; __setDbClientForTests(sql);
    await sql`drop trigger if exists reject_schedule_fixture on noelle.post_drafts`;
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations (id,slug,name) values (${org},'one','One')`;
    await sql`insert into noelle.agent_instances (id,org_id,role) values (${instance},${org},'x_intern')`;
  });
  afterAll(async () => { resetDbClientForTests(); await sql?.end(); });
  async function idea() {
    const [row] = await sql`insert into noelle.post_ideas (org_id,agent_instance_id,platform,hook,status)
      values (${org},${instance},'x','A useful example','approved') returning id`;
    return row!.id as string;
  }
  async function draft(ideaId: string, platform = "x") {
    const response = await postDrafts.request('/api/post-drafts', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ideaId, platform, body: 'A grounded concrete example', charCount: 27,
        qualityScore: 0.9, qualityPassed: true }),
    });
    expect(response.status).toBe(200);
    return (await response.json() as { draft_id: string }).draft_id;
  }
  it("binds a generated platform variant only to its own compose slot", async () => {
    const id = await idea();
    await sql`insert into noelle.content_schedule_slots (org_id,agent_instance_id,platform,slot_at,status,idea_id)
      values (${org},${instance},'x',now(),'drafting',${id}),(${org},${instance},'linkedin',now(),'drafting',${id})`;
    const draftId = await draft(id, 'linkedin');
    const rows = await sql`select platform,draft_id,status from noelle.content_schedule_slots order by platform`;
    expect(rows).toEqual([
      { platform: 'linkedin', draft_id: draftId, status: 'ready' },
      { platform: 'x', draft_id: null, status: 'drafting' },
    ]);
  });
  it("does not bind a foreign tenant's soft slot reference", async () => {
    const id = await idea(); const otherOrg = '00000000-0000-4000-8000-000000000002';
    const otherInstance = '00000000-0000-4000-8000-000000000012';
    await sql`insert into noelle.organizations (id,slug,name) values (${otherOrg},'two','Two')`;
    await sql`insert into noelle.agent_instances (id,org_id,role) values (${otherInstance},${otherOrg},'x_intern')`;
    await sql`insert into noelle.content_schedule_slots (org_id,agent_instance_id,platform,slot_at,status,idea_id)
      values (${otherOrg},${otherInstance},'x',now(),'drafting',${id})`;
    await draft(id);
    expect((await sql`select draft_id,status from noelle.content_schedule_slots`)[0]).toEqual({ draft_id: null, status: 'drafting' });
  });
  it("paces concurrent qualifying ideas on one instance", async () => {
    settings.enabled = true;
    const ideas = await Promise.all(Array.from({ length: 8 }, idea));
    await Promise.all(ideas.map(id => draft(id)));
    const slots = await sql`select slot_at from noelle.content_schedule_slots order by slot_at`;
    expect(slots).toHaveLength(8);
    for (let i=1; i<slots.length; i++) expect(new Date(slots[i]!.slot_at).getTime()-new Date(slots[i-1]!.slot_at).getTime()).toBeGreaterThanOrEqual(180*60_000);
  });
  it("schedules exactly one winning variant when siblings arrive together", async () => {
    settings.enabled = true; const id = await idea();
    await Promise.all(Array.from({ length: 8 }, () => draft(id)));
    expect(await sql`select * from noelle.content_schedule_slots`).toHaveLength(1);
    const [counts] = await sql`select count(*) filter(where status='ready')::int as ready,
      count(*) filter(where status='dismissed')::int as dismissed from noelle.post_drafts`;
    expect(counts).toEqual({ ready: 1, dismissed: 7 });
  });
  it("preserves a cancelled idea when its generated result arrives", async () => {
    settings.enabled = true; const id = await idea();
    await sql`update noelle.post_ideas set status='dismissed' where id=${id}`;
    await draft(id);
    expect((await sql`select status from noelle.post_ideas where id=${id}`)[0]?.status).toBe('dismissed');
    expect(await sql`select * from noelle.content_schedule_slots`).toHaveLength(0);
  });
  it("binds one of multiple waiting slots without violating the draft's unique slot", async () => {
    const id = await idea();
    await sql`insert into noelle.content_schedule_slots (org_id,agent_instance_id,platform,slot_at,status,idea_id)
      values (${org},${instance},'x',now(),'drafting',${id}),(${org},${instance},'x',now()+interval '1 day','drafting',${id})`;
    const draftId = await draft(id);
    const rows = await sql`select draft_id,status from noelle.content_schedule_slots order by slot_at`;
    expect(rows).toEqual([{ draft_id: draftId, status: 'ready' },{ draft_id: null, status: 'drafting' }]);
  });
  it("rolls automatic scheduling back if its draft transition fails", async () => {
    settings.enabled = true; const id = await idea();
    await sql`create function noelle.reject_schedule_fixture() returns trigger language plpgsql as $$
      begin if new.stage='scheduled' then raise exception 'fixture transition failure'; end if; return new; end $$`;
    await sql`create trigger reject_schedule_fixture before update on noelle.post_drafts
      for each row execute function noelle.reject_schedule_fixture()`;
    const draftId = await draft(id);
    expect(await sql`select * from noelle.content_schedule_slots`).toHaveLength(0);
    expect((await sql`select status,stage from noelle.post_drafts where id=${draftId}`)[0]).toEqual({ status: 'draft', stage: 'draft' });
  });
});
