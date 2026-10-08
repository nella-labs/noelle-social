import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RecordingBriefOutputSchema } from "@noelle/contracts";
import { claimReadyDraftsForBrief, insertRecordingBrief, markBriefDispatched, markBriefClaimOutcome,
  revertBriefClaim, retryRecordingBrief, type ClaimedDraftForBrief } from "./videoRecordingBriefDb.js";

const url = process.env.NOELLE_VIDEO_BRIEF_RECOVERY_TEST_DATABASE_URL;
const output = RecordingBriefOutputSchema.parse({ title: "Saved plan", runtimeTarget: 15, hookCheck: "Clear opening",
  shotList: [], bRoll: [], camAngles: [], props: { inFrame: [], mustNotBeInFrame: [] }, onTheDayNotes: [] });
describe.skipIf(!url)("Retained recording brief attempts (native PostgreSQL)", () => {
  let sql: Sql; let org: string; let other: string; let instance: string; let foreignInstance: string; let migration: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_brief_recovery_test")
      throw new Error("dedicated recording brief recovery database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql",
      "0067_video_intern_studio.sql", "0080_video_recording_briefs.sql", "0123_video_recording_brief_attempts.sql"])
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    migration = await readFile(new URL("../../../infra/cloudsql/schema/0123_video_recording_brief_attempts.sql", import.meta.url), "utf8");
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    org = String((await sql`insert into noelle.organizations(slug,name) values ('brief_recovery_owned','Owned') returning id`)[0]!.id);
    other = String((await sql`insert into noelle.organizations(slug,name) values ('brief_recovery_other','Other') returning id`)[0]!.id);
    instance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${org},'video_intern') returning id`)[0]!.id);
    foreignInstance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${other},'video_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  async function draft(foreign = false) {
    const owner = foreign ? other : org; const parent = foreign ? foreignInstance : instance;
    const idea = String((await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook)
      values (${owner},${parent},'Saved hook') returning id`)[0]!.id);
    return String((await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id,status,script,final_script)
      values (${owner},${parent},${idea},'ready','Generated script','Approved edited script') returning id`)[0]!.id);
  }
  const claims = (limit = 4) => claimReadyDraftsForBrief(sql, instance, limit, org, { sourceEngine: "claude", model: "configured-model" });
  const attempts = () => sql`select id,status,source_snapshot,configured_engine,configured_model,predecessor_id,
    operator_id,dispatched_at from noelle.video_recording_brief_attempts order by created_at,id`;
  const complete = (claim: ClaimedDraftForBrief) => insertRecordingBrief(sql, { claim, brief: output, briefMd: "Saved plan",
    runtimeTarget: 15, forgeFollowups: 0, sourceEngine: "claude", model: "configured-model" });
  const retry = (claim: ClaimedDraftForBrief, expectedClaimUUID = claim.claim_id) => retryRecordingBrief(sql,
    { orgId: org, instanceId: instance, draftId: claim.draft_id, expectedClaimUUID, operatorId: "operator" });
  it("persists captured source/configuration before dispatch and completes the same stable output once", async () => {
    await draft(); const [claim] = await claims();
    expect((await attempts())[0]).toMatchObject({ id: claim!.claim_id, status: "building", configured_engine: "claude",
      configured_model: "configured-model", source_snapshot: claim!.source_snapshot, dispatched_at: null });
    expect(await complete(claim!)).toBeNull(); expect(await markBriefDispatched(sql, claim!)).toBe(true);
    expect(await complete(claim!)).toBe(claim!.brief_id); expect(await complete(claim!)).toBeNull();
    expect(await claims()).toHaveLength(0); expect((await attempts())[0]?.status).toBe("complete");
  });
  it.each(["dispatch", "completion"])("rejects forged refreshed source snapshot at %s", async phase => {
    const id = await draft(); const [claim] = await claims();
    if (phase === "completion") expect(await markBriefDispatched(sql, claim!)).toBe(true);
    await sql`update noelle.video_drafts set final_script='Changed approval' where id=${id}`;
    const [row] = await sql<{ script: string; at: string }[]>`select final_script as script,updated_at::text as at
      from noelle.video_drafts where id=${id}`;
    const forged = { ...claim!, script: row!.script, final_script: row!.script, draft_updated_at: row!.at,
      source_snapshot: { ...claim!.source_snapshot, script: row!.script, final_script: row!.script, draft_updated_at: row!.at } };
    expect(forged.source_snapshot).not.toEqual(claim!.source_snapshot);
    expect(phase === "dispatch" ? await markBriefDispatched(sql, forged) : await complete(forged)).toBe(phase === "dispatch" ? false : null);
    expect((await sql`select status from noelle.video_recording_briefs`)[0]?.status).not.toBe("ready");
  });
  it.each(["script", "hook", "structure"])("rejects caller-only %s mutation before dispatch", async field => {
    await draft(); const [claim] = await claims();
    const forged = { ...claim!, ...(field === "script" ? { script: "Forged body" } : field === "hook" ? { hook: "Forged hook" } : { structure: [{ tEnd: 99 }] }) };
    expect(await markBriefDispatched(sql, forged)).toBe(false);
  });
  it("retains configured provenance after unknown generation without automatic readmission", async () => {
    await draft(); const [claim] = await claims(); await markBriefDispatched(sql, claim!);
    expect(await markBriefClaimOutcome(sql, claim!, "generation_unknown")).toBe(true);
    await sql`update noelle.video_recording_brief_attempts set created_at='2020-01-01'::timestamptz where id=${claim!.claim_id}`;
    expect(await claims()).toHaveLength(0);
    expect((await attempts())[0]).toMatchObject({ status: "unknown", configured_engine: "claude", configured_model: "configured-model" });
    expect((await sql`select source_engine,model,status from noelle.video_recording_briefs`)[0])
      .toEqual({ source_engine: "claude", model: "configured-model", status: "unknown" });
  });
  it("queues one exact attributed successor and rejects old late completion/outcome/release", async () => {
    const id = await draft(); const [old] = await claims(); await markBriefDispatched(sql, old!);
    const queued = await retry(old!); expect(queued).not.toBeNull(); expect(await retry(old!)).toBeNull();
    expect(await complete(old!)).toBeNull(); expect(await markBriefClaimOutcome(sql, old!, "generation_unknown")).toBe(false);
    expect(await revertBriefClaim(sql, old!)).toBe(false);
    expect(await attempts()).toEqual([expect.objectContaining({ id: old!.claim_id, status: "superseded" }),
      expect.objectContaining({ id: queued, status: "queued", predecessor_id: old!.claim_id, operator_id: "operator", source_snapshot: null })]);
    await sql`update noelle.video_drafts set final_script='Current approval' where id=${id}`;
    const [current] = await claims(); expect(current!.claim_id).toBe(queued); expect(current!.brief_id).toBe(old!.brief_id);
    expect(current!.script).toBe("Current approval"); await markBriefDispatched(sql, current!);
    expect(await complete(current!)).toBe(old!.brief_id); expect(await retry(current!)).toBeNull();
  });
  it("allows only one successor when two operators race the same expected identity", async () => {
    await draft(); const [claim] = await claims();
    const results = await Promise.all([retry(claim!), retry(claim!)]);
    expect(results.filter(Boolean)).toHaveLength(1); expect(await attempts()).toHaveLength(2);
  });
  it("serializes completion versus explicit recovery with one acknowledged winner", async () => {
    await draft(); const [claim] = await claims(); await markBriefDispatched(sql, claim!);
    const results = await Promise.all([complete(claim!), retry(claim!)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const current = (await attempts()).filter(row => row.status !== "superseded");
    expect(current).toHaveLength(1); expect(["queued", "complete"]).toContain(current[0]!.status);
  });
  it("releases only proven undispatched preparation and retains its history", async () => {
    await draft(); const [old] = await claims(); expect(await revertBriefClaim(sql, old!)).toBe(true);
    const [current] = await claims(); expect(current!.claim_id).not.toBe(old!.claim_id); expect(current!.brief_id).toBe(old!.brief_id);
    await markBriefDispatched(sql, current!); expect(await revertBriefClaim(sql, current!)).toBe(false);
    expect((await attempts())[0]?.status).toBe("released"); expect(await revertBriefClaim(sql, old!)).toBe(false);
  });
  it.each(["role", "org", "reference", "platform"])("rejects changed %s before dispatch", async field => {
    const id = await draft(); const [claim] = await claims();
    if (field === "role") await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
    if (field === "org") await sql`update noelle.agent_instances set org_id=${other},role='linkedin_intern' where id=${instance}`;
    if (field === "reference") { const foreign = await draft(true); await sql`update noelle.video_drafts
      set idea_id=(select idea_id from noelle.video_drafts where id=${foreign}) where id=${id}`; }
    if (field === "platform") await sql`update noelle.video_drafts set platform='tiktok' where id=${id}`;
    expect(await markBriefDispatched(sql, claim!)).toBe(false); expect(await complete(claim!)).toBeNull();
  });
  it("rechecks a parent changed while its lock was held", async () => {
    await draft(); const [claim] = await claims(); let enter!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; }); const held = new Promise<void>(resolve => { release = resolve; });
    const parent = sql.begin(async tx => { await tx`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`; enter(); await held; });
    await entered; const result = markBriefDispatched(sql, claim!);
    try { await new Promise(resolve => setTimeout(resolve, 30)); } finally { release(); await parent; }
    expect(await result).toBe(false);
  });
  it("imports recorded legacy holds without inventing source or dispatch evidence", async () => {
    const id = await draft();
    const [legacy] = await sql<{ id: string }[]>`insert into noelle.video_recording_briefs(org_id,agent_instance_id,draft_id,idea_id,status,brief)
      select org_id,agent_instance_id,id,idea_id,'unknown','{"failureReason":"generation_unknown"}'::jsonb from noelle.video_drafts where id=${id} returning id`;
    await sql.unsafe(migration);
    expect((await attempts())[0]).toMatchObject({ id: legacy!.id, source_snapshot: null, dispatched_at: null,
      configured_engine: null, configured_model: null, status: "unknown" });
    const queued = await retryRecordingBrief(sql, { orgId: org, instanceId: instance, draftId: id, expectedClaimUUID: legacy!.id, operatorId: "operator" });
    expect(queued).not.toBeNull(); expect(await attempts()).toHaveLength(2);
  });
  it("adopts a coherent late legacy hold only for explicit expected-UUID recovery", async () => {
    const id = await draft(); const [legacy] = await sql<{ id: string }[]>`insert into noelle.video_recording_briefs(org_id,agent_instance_id,draft_id,idea_id,status)
      select org_id,agent_instance_id,id,idea_id,'building' from noelle.video_drafts where id=${id} returning id`;
    expect(await claims()).toHaveLength(0); expect(await attempts()).toHaveLength(0);
    expect(await retryRecordingBrief(sql, { orgId: org, instanceId: instance, draftId: id, expectedClaimUUID: legacy!.id, operatorId: "operator" })).not.toBeNull();
    expect((await attempts())[0]).toMatchObject({ id: legacy!.id, status: "superseded", source_snapshot: null });
  });
  it("keeps application reads/writes while denying deletion and preserves admin organization cascade", async () => {
    await draft(); const [claim] = await claims();
    await sql.begin(async tx => { await tx`set local role noelle_app`; expect(await tx`select id from noelle.video_recording_brief_attempts`).toHaveLength(1);
      expect(await tx`update noelle.video_recording_brief_attempts set configured_model='recorded' where id=${claim!.claim_id} returning id`).toHaveLength(1);
      expect(await tx`insert into noelle.video_recording_brief_attempts(org_id,agent_instance_id,draft_id,idea_id,brief_id,platform,status,reason)
        select org_id,agent_instance_id,draft_id,idea_id,brief_id,platform,'released','preparation_failed'
        from noelle.video_recording_brief_attempts where id=${claim!.claim_id} returning id`).toHaveLength(1); });
    await expect(sql.begin(async tx => { await tx`set local role noelle_app`; await tx`delete from noelle.video_recording_brief_attempts where id=${claim!.claim_id}`; }))
      .rejects.toMatchObject({ code: "42501" });
    await expect(sql`delete from noelle.video_recording_briefs where id=${claim!.brief_id}`).rejects.toMatchObject({ code: "23503" });
    await sql`delete from noelle.organizations where id=${org}`; expect(await attempts()).toHaveLength(0);
  });
});
