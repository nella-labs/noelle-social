import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RecordingBriefOutputSchema } from "@noelle/contracts";
import { createLogger } from "../lib/logger.js";
import { claimReadyDraftsForBrief, insertRecordingBrief, listHeldBriefClaims, revertBriefClaim, markBriefDispatched } from "../lib/recording-briefs-db.js";
import { runBrieferTick } from "./briefer-tick.js";
import { retryRecordingBrief } from "@noelle/runtime/video-recording-brief-db";
import type { VideoBriefer } from "../lib/brief-generate.js";
import { ModelNotDispatchedError } from "@noelle/runtime";

const url = process.env.NOELLE_VIDEO_PROVENANCE_TEST_DATABASE_URL;
const output = RecordingBriefOutputSchema.parse({ title: "Saved shoot plan", runtimeTarget: 15,
  hookCheck: "Opening is clear", shotList: [], bRoll: [], camAngles: [],
  props: { inFrame: [], mustNotBeInFrame: [] }, onTheDayNotes: [] });
function heldBriefer() {
  let enter!: () => void; let release!: () => void; let calls = 0;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  const briefer: VideoBriefer = { async brief() { calls++; enter(); await released; return output; } };
  return { briefer, entered, release: () => release(), calls: () => calls };
}

describe.skipIf(!url)("Durable recording brief claims (native PostgreSQL)", () => {
  let sql: Sql; let org: string; let other: string; let instance: string; let otherInstance: string;
  const log = createLogger({ kind: "brief-native", workerId: "native" }); log.level = "silent";
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_provenance_test")
      throw new Error("dedicated Video provenance test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql",
      "0067_video_intern_studio.sql", "0073_video_self_tracking.sql", "0080_video_recording_briefs.sql", "0122_video_teardown_attempts.sql", "0123_video_recording_brief_attempts.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    org = String((await sql`insert into noelle.organizations(slug,name) values ('brief_owned','Owned') returning id`)[0]!.id);
    other = String((await sql`insert into noelle.organizations(slug,name) values ('brief_other','Other') returning id`)[0]!.id);
    instance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${org},'video_intern') returning id`)[0]!.id);
    otherInstance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${other},'video_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  async function readyDraft(foreignIdea = false) {
    const idea = String((await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook)
      values (${foreignIdea ? other : org},${foreignIdea ? otherInstance : instance},'Saved hook') returning id`)[0]!.id);
    return String((await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id,script,final_script,status)
      values (${org},${instance},${idea},'Generated script','Approved edited script','ready') returning id`)[0]!.id);
  }
  const tick = (briefer: VideoBriefer, batchLimit = 1) => runBrieferTick({ sql, log,
    instance: { id: instance, org_id: org, status: "active", objective: null, video_feeder_config: null, budget_cap_cents: null },
    briefer: { brief: async input => {
      if (await input.operation!.beforeDispatch(performance.now() + 1000) !== "dispatch") throw new ModelNotDispatchedError();
      return briefer.brief(input);
    } }, batchLimit, model: "saved-model", sourceEngine: "claude", kb: null });
  const claims = (limit = 1) => claimReadyDraftsForBrief(sql, instance, limit, org);
  const rows = () => sql`select id,status,brief,model,source_engine from noelle.video_recording_briefs order by created_at,id`;

  it("stores the approved edited body once with retained provenance", async () => {
    await readyDraft(); let body = ""; let calls = 0;
    const briefer = { brief: async (input: { script: string }) => { body = input.script; calls++; return output; } };
    expect(await tick(briefer)).toBe(1); expect(await tick(briefer)).toBe(0);
    expect(body).toBe("Approved edited script"); expect(calls).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "ready", brief: output, model: "saved-model", source_engine: "claude" });
  });
  it("commits a building claim before dispatch and blocks concurrent generation", async () => {
    await readyDraft(); const held = heldBriefer(); const first = tick(held.briefer);
    await held.entered;
    try {
      expect((await rows())[0]?.status).toBe("dispatched");
      await expect(tick(held.briefer)).rejects.toMatchObject({ reason: "generation_in_progress", rowsProcessed: 0 });
    } finally { held.release(); await first; }
    expect(held.calls()).toBe(1); expect((await rows())[0]?.status).toBe("ready");
  });
  it("keeps opaque null generation unknown and never redispatches it", async () => {
    await readyDraft(); let calls = 0;
    const briefer = { brief: async () => { calls++; return null; } };
    await expect(tick(briefer)).rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 0 });
    await expect(tick(briefer)).rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 0 });
    expect(calls).toBe(1);
    expect((await rows())[0]).toMatchObject({ status: "unknown", brief: { failureReason: "generation_unknown" },
      source_engine: "claude", model: "saved-model" });
  });
  it("keeps thrown dispatch failed without storing provider error text", async () => {
    await readyDraft();
    await expect(tick({ brief: async () => { throw new Error("private provider body"); } }))
      .rejects.toMatchObject({ reason: "generation_failed", rowsProcessed: 0 });
    expect((await rows())[0]).toMatchObject({ status: "failed", brief: { failureReason: "generation_failed" } });
  });
  it("preserves an earlier acknowledged member when a later dispatch fails", async () => {
    await readyDraft(); await readyDraft(); let calls = 0;
    await expect(tick({ brief: async () => ++calls === 1 ? output : null }, 2))
      .rejects.toMatchObject({ reason: "generation_unknown", rowsProcessed: 1 });
    expect((await rows()).map(row => row.status).sort()).toEqual(["ready", "unknown"]);
  });
  it("excludes a foreign idea before dispatch", async () => {
    await readyDraft(true); let calls = 0;
    expect(await tick({ brief: async () => { calls++; return output; } })).toBe(0);
    expect(calls).toBe(0); expect(await rows()).toHaveLength(0);
  });
  it.each(["org", "role", "platform"])("rejects current %s mismatch before dispatch", async field => {
    const draft = await readyDraft();
    if (field === "org") await sql`update noelle.agent_instances set org_id=${other},role='linkedin_intern' where id=${instance}`;
    if (field === "role") await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
    if (field === "platform") await sql`update noelle.video_drafts set platform='tiktok' where id=${draft}`;
    let calls = 0;
    expect(await tick({ brief: async () => { calls++; return output; } })).toBe(0);
    expect(calls).toBe(0); expect(await rows()).toHaveLength(0);
  });
  it.each(["script", "idea", "role", "org", "reference", "platform"])("does not finalize after %s changes during generation", async field => {
    const draft = await readyDraft(); const held = heldBriefer();
    const finished = tick(held.briefer).then(n => ({ n }), error => ({ error }));
    await held.entered;
    try {
      if (field === "script") await sql`update noelle.video_drafts set final_script='New approved edit' where id=${draft}`;
      if (field === "idea") await sql`update noelle.video_ideas set hook='New hook' where id=(select idea_id from noelle.video_drafts where id=${draft})`;
      if (field === "role") await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
      if (field === "org") await sql`update noelle.agent_instances set org_id=${other},role='linkedin_intern' where id=${instance}`;
      if (field === "reference") {
        const foreign = await readyDraft(true);
        await sql`update noelle.video_drafts set idea_id=(select idea_id from noelle.video_drafts where id=${foreign}) where id=${draft}`;
      }
      if (field === "platform") await sql`update noelle.video_drafts set platform='tiktok' where id=${draft}`;
    } finally { held.release(); }
    expect(await finished).toMatchObject({ error: { reason: "source_changed", rowsProcessed: 0 } });
    expect((await rows())[0]?.status).not.toBe("ready");
  });
  it("rejects changed approval after real awaited brand context before generator dispatch", async () => {
    const draft = await readyDraft(); let calls = 0;
    await expect(runBrieferTick({ sql, log,
      instance: { id: instance, org_id: org, status: "active", objective: null, video_feeder_config: null, budget_cap_cents: null },
      briefer: { brief: async input => {
        if (await input.operation!.beforeDispatch(performance.now() + 1000) !== "dispatch") throw new ModelNotDispatchedError();
        calls++; return output;
      } }, batchLimit: 4, model: "saved-model", sourceEngine: "claude",
      kb: { search: async () => { await sql`update noelle.video_drafts set final_script='Changed approval' where id=${draft}`; return []; } },
    })).rejects.toMatchObject({ reason: "source_changed", rowsProcessed: 0 });
    expect(calls).toBe(0); expect((await rows())[0]?.status).toBe("failed");
  });
  it("excludes independently foreign legacy holds from the actual worker before its eight-row status bound", async () => {
    const owned = await readyDraft(); const [claim] = await claims(); expect(claim?.draft_id).toBe(owned);
    for (let n = 0; n < 8; n++) {
      const foreignIdea = String((await sql`insert into noelle.video_ideas(org_id,agent_instance_id,hook)
        values (${other},${otherInstance},'Foreign hook') returning id`)[0]!.id);
      const foreignDraft = String((await sql`insert into noelle.video_drafts(org_id,agent_instance_id,idea_id)
        values (${other},${otherInstance},${foreignIdea}) returning id`)[0]!.id);
      await sql`insert into noelle.video_recording_briefs(org_id,agent_instance_id,draft_id,idea_id,status,created_at)
        values (${org},${instance},${foreignDraft},${foreignIdea},'unknown','2020-01-01'::timestamptz)`;
    }
    expect((await listHeldBriefClaims(sql, instance, org)).map(row => row.id)).toEqual([claim!.claim_id]);
    let calls = 0; await expect(tick({ brief: async () => { calls++; return output; } }))
      .rejects.toMatchObject({ reason: "generation_in_progress", rowsProcessed: 0 });
    expect(calls).toBe(0); await markBriefDispatched(sql, claim!);
    expect(await insertRecordingBrief(sql, { claim: claim!, brief: output, briefMd: "Saved plan", runtimeTarget: 15,
      forgeFollowups: 0, sourceEngine: "claude", model: "saved-model" })).toBe(claim!.brief_id);
    expect(await tick({ brief: async () => { calls++; return output; } })).toBe(0); expect(calls).toBe(0);
  });
  it("explicit recovery queues only and a later tick captures the current approved body", async () => {
    const draft = await readyDraft(); let calls = 0;
    await expect(tick({ brief: async () => { calls++; return null; } })).rejects.toMatchObject({ reason: "generation_unknown" });
    const [old] = await sql<{ id: string; brief_id: string }[]>`select id,brief_id from noelle.video_recording_brief_attempts`;
    await sql`update noelle.video_drafts set final_script='Current approved body' where id=${draft}`;
    const queued = await retryRecordingBrief(sql, { orgId: org, instanceId: instance, draftId: draft,
      expectedClaimUUID: old!.id, operatorId: "operator" });
    expect(queued).not.toBeNull(); expect(calls).toBe(1); let body = "";
    expect(await tick({ brief: async input => { calls++; body = input.script; return output; } })).toBe(1);
    expect(body).toBe("Current approved body"); expect(calls).toBe(2);
    expect((await rows())[0]).toMatchObject({ id: old!.brief_id, status: "ready" });
    expect(await sql`select id,status from noelle.video_recording_brief_attempts where status='complete'`).toEqual([{ id: queued, status: "complete" }]);
    expect(await tick({ brief: async () => { calls++; return output; } })).toBe(0); expect(calls).toBe(2);
  });
  it("stale cleanup cannot delete a ready receipt", async () => {
    await readyDraft(); const [claim] = await claims(); expect(claim).toBeDefined();
    expect(await markBriefDispatched(sql, claim!)).toBe(true);
    expect(await insertRecordingBrief(sql, { claim: claim!, brief: output, briefMd: "Saved plan", runtimeTarget: 15,
      forgeFollowups: 0, sourceEngine: "claude", model: "saved-model" })).toBe(claim!.brief_id);
    expect(await revertBriefClaim(sql, claim!)).toBe(false);
    expect((await rows())[0]).toMatchObject({ id: claim!.brief_id, status: "ready" });
  });
  it("a stale UUID cannot release a different provisional claim for the same draft", async () => {
    await readyDraft(); const [old] = await claims(); expect(old).toBeDefined();
    expect(await revertBriefClaim(sql, old!)).toBe(true);
    const [current] = await claims(); expect(current).toBeDefined();
    expect(current!.claim_id).not.toBe(old!.claim_id); expect(current!.brief_id).toBe(old!.brief_id); expect(await revertBriefClaim(sql, old!)).toBe(false);
    expect((await rows())[0]).toMatchObject({ id: current!.brief_id, status: "building" });
  });
  it("admits at most ten claims even when a caller requests a very large batch", async () => {
    for (let n = 0; n < 11; n++) await readyDraft();
    expect(await claims(1000000)).toHaveLength(10);
    expect(await rows()).toHaveLength(10);
  });
  it("keeps the existing default four-member admission", async () => {
    for (let n = 0; n < 11; n++) await readyDraft();
    expect(await claims(4)).toHaveLength(4);
    expect(await rows()).toHaveLength(4);
  });
  it("bounds held status rows independently of the configured dispatch batch", async () => {
    for (let n = 0; n < 9; n++) await readyDraft();
    expect(await claims(9)).toHaveLength(9);
    expect(await listHeldBriefClaims(sql, instance, org)).toHaveLength(8);
  });
  it("revalidates a freshly changed parent after its row lock is released", async () => {
    await readyDraft(); let release!: () => void; let enter!: () => void;
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { enter = resolve; });
    const parent = sql.begin(async tx => {
      await tx`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
      enter(); await unlocked;
    });
    await locked; let settled = false; let calls = 0;
    const result = tick({ brief: async () => { calls++; return output; } }).then(n => { settled = true; return n; });
    try { await new Promise(resolve => setTimeout(resolve, 40)); expect(settled).toBe(false); }
    finally { release(); await parent; }
    expect(await result).toBe(0); expect(calls).toBe(0); expect(await rows()).toHaveLength(0);
  });
  it("a held parent times out without a claim appearing after the lock is released", async () => {
    await readyDraft(); let release!: () => void; let enter!: () => void;
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const locked = new Promise<void>(resolve => { enter = resolve; });
    const parent = sql.begin(async tx => { await tx`select id from noelle.agent_instances where id=${instance} for update`; enter(); await unlocked; });
    await locked;
    try { await expect(claims()).rejects.toMatchObject({ category: "deadline" }); }
    finally { release(); await parent; }
    expect(await rows()).toHaveLength(0);
  }, 10000);
});
