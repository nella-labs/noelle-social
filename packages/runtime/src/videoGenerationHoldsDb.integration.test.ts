import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listVideoGenerationHolds } from "./videoGenerationHoldsDb.js";
import { claimReadyDraftsForBrief, markBriefClaimOutcome, retryRecordingBrief } from "./videoRecordingBriefDb.js";

const url = process.env.NOELLE_VIDEO_GENERATION_HOLDS_TEST_DATABASE_URL;
describe.skipIf(!url)("Scoped Video generation hold pages (native PostgreSQL)", () => {
  let sql: Sql; let org: string; let other: string; let instance: string; let foreignInstance: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_generation_holds_test")
      throw new Error("dedicated Video generation holds database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql",
      "0067_video_intern_studio.sql", "0080_video_recording_briefs.sql", "0122_video_teardown_attempts.sql", "0123_video_recording_brief_attempts.sql"])
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    org = String((await sql`insert into noelle.organizations(slug,name) values ('holds_owned','Owned') returning id`)[0]!.id);
    other = String((await sql`insert into noelle.organizations(slug,name) values ('holds_other','Other') returning id`)[0]!.id);
    instance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${org},'video_intern') returning id`)[0]!.id);
    foreignInstance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${other},'video_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const page = (limit = 20, cursor?: string) => listVideoGenerationHolds(sql,
    { orgId: org, instanceId: instance, limit, ...(cursor ? { cursor } : {}) });
  async function hold(id: string, foreign = false, at = "2026-10-06 00:00:00.123456+00") {
    const clip = String((await sql`insert into noelle.video_clips(org_id,agent_instance_id,external_id,author_handle)
      values (${org},${foreign ? foreignInstance : instance},${id},'example') returning id`)[0]!.id);
    await sql`insert into noelle.video_teardown_attempts(id,org_id,agent_instance_id,clip_id,platform,status,reason,created_at)
      values (${id},${org},${instance},${clip},'instagram','unknown','generation_unknown',(${at}::text)::timestamptz)`;
  }
  it("filters independently foreign sources before limit and preserves exact microsecond cursor ties", async () => {
    await hold("00000000-0000-4000-8000-000000000001", true);
    await hold("00000000-0000-4000-8000-000000000002");
    await hold("00000000-0000-4000-8000-000000000003");
    await hold("00000000-0000-4000-8000-000000000004", false, "2026-10-06 00:00:00.123457+00");
    const first = await page(1); const second = await page(1, first.nextCursor!); const third = await page(1, second.nextCursor!);
    expect([first, second, third].flatMap(p => p.holds.map(h => h.id))).toEqual([
      "00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003", "00000000-0000-4000-8000-000000000004"]);
    expect(first.holds[0]?.createdAt).toContain(".123456"); expect(third.nextCursor).toBeNull();
    expect(first.returnedCount).toBe(1); expect(first.holds[0]?.providerExecutionMayBeUnresolved).toBe(true);
    await expect(listVideoGenerationHolds(sql, { orgId: other, instanceId: instance, limit: 1, cursor: first.nextCursor! })).rejects.toThrow(RangeError);
  });
  it("excludes completed, queued, superseded and released attempts from recovery holds", async () => {
    await hold("00000000-0000-4000-8000-000000000001");
    for (const status of ["complete", "queued", "superseded", "released"]) {
      await sql`update noelle.video_teardown_attempts set status=${status}`; expect((await page()).holds).toHaveLength(0);
    }
  });
  it("rejects malformed cursors and invalid output limits before SQL", async () => {
    for (const limit of [0, 51, 0.5, NaN, Infinity]) expect(() => page(limit)).toThrow(RangeError);
    await expect(page(1, "not-a-cursor")).rejects.toThrow(RangeError);
  });
  it("pages mixed teardown and coherent brief holds and excludes foreign draft references before limit", async () => {
    await hold("00000000-0000-4000-8000-000000000002");
    const idea = String((await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook)
      values (${org},${instance},'Saved hook') returning id`)[0]!.id);
    for (const foreign of [false, true]) {
      const draft = String((await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id)
        values (${org},${foreign ? foreignInstance : instance},${idea}) returning id`)[0]!.id);
      await sql`insert into noelle.video_recording_briefs(id,org_id,agent_instance_id,draft_id,idea_id,status,created_at)
        values (${foreign ? '00000000-0000-4000-8000-000000000001' : '00000000-0000-4000-8000-000000000003'},
          ${org},${instance},${draft},${idea},'building',('2026-10-06 00:00:00.123456+00'::text)::timestamptz)`;
    }
    const first = await page(1); const second = await page(1, first.nextCursor!);
    expect([first.holds[0]?.kind, second.holds[0]?.kind]).toEqual(["teardown", "recording_brief"]);
    expect(second.nextCursor).toBeNull();
    await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
    expect((await page()).holds).toHaveLength(0);
  });
  it("lists the current brief attempt rather than the stable projection and excludes queued history", async () => {
    const idea = String((await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook)
      values (${org},${instance},'Saved hook') returning id`)[0]!.id);
    await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id,status,script)
      values (${org},${instance},${idea},'ready','Saved body')`;
    const [old] = await claimReadyDraftsForBrief(sql, instance, 1, org);
    await markBriefClaimOutcome(sql, old!, "generation_unknown");
    expect((await page(1)).holds).toEqual([expect.objectContaining({ id: old!.claim_id, sourceId: old!.draft_id })]);
    const queued = await retryRecordingBrief(sql, { orgId: org, instanceId: instance, draftId: old!.draft_id,
      expectedClaimUUID: old!.claim_id, operatorId: "operator" });
    expect((await page(1)).holds).toHaveLength(0);
    const [current] = await claimReadyDraftsForBrief(sql, instance, 1, org);
    await markBriefClaimOutcome(sql, current!, "generation_unknown");
    expect((await page(1)).holds).toEqual([expect.objectContaining({ id: queued, status: "unknown" })]);
    expect(current!.brief_id).toBe(old!.brief_id);
    await sql`update noelle.video_recording_brief_attempts set org_id=${other} where id=${queued!}`;
    expect((await page(1)).holds).toHaveLength(0);
  });
});
