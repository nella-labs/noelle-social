import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { VideoTeardownSchema } from "@noelle/contracts";
import { claimClipsForTeardown, completeTeardownClaim, markTeardownDispatched, markTeardownClaimOutcome,
  retryVideoTeardown } from "./videoTeardownClaimsDb.js";
import { teardownSnapshotSql } from "./videoTeardownDb.js";

const url = process.env.NOELLE_VIDEO_TEARDOWN_CLAIMS_DB_TEST_DATABASE_URL;
const output = VideoTeardownSchema.parse({ hook: { text: "Saved hook", type: "question" },
  pacing: { cutsPerSec: 0.1, avgBeatSec: 1, wordsPerSec: 1 }, cta: { present: false }, sound: {}, whyItWorked: "Observed structure" });

describe.skipIf(!url)("Retained Video teardown attempts (native PostgreSQL)", () => {
  let sql: Sql; let org: string; let otherOrg: string; let instance: string; let otherInstance: string; let serial: number;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_video_teardown_claims_db_test")
      throw new Error("dedicated Video teardown claim owner database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0065_video_intern_watchlist.sql", "0066_video_intern_corpus.sql",
      "0067_video_intern_studio.sql", "0073_video_self_tracking.sql", "0120_video_metrics_nullable.sql", "0122_video_teardown_attempts.sql",
      "0124_video_teardown_preparation_failed.sql"])
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`; serial = 0;
    org = String((await sql`insert into noelle.organizations(slug,name) values ('claims_owned','Owned') returning id`)[0]!.id);
    otherOrg = String((await sql`insert into noelle.organizations(slug,name) values ('claims_other','Other') returning id`)[0]!.id);
    instance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${org},'video_intern') returning id`)[0]!.id);
    otherInstance = String((await sql`insert into noelle.agent_instances(org_id,role) values (${otherOrg},'video_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const clip = async (foreign = false) => String((await sql`insert into noelle.video_clips
    (org_id,agent_instance_id,external_id,author_handle,caption,url) values
    (${foreign ? otherOrg : org},${instance},${String(++serial)},'example','Saved caption','https://example.test/reel/saved') returning id`)[0]!.id);
  const admit = (limit = 4, dailyCap = 200) => claimClipsForTeardown(sql, { instanceId: instance, orgId: org, limit, dailyCap });
  const attempts = () => sql`select id,status,reason,predecessor_id,operator_id,teardown_id from noelle.video_teardown_attempts order by created_at,id`;
  const complete = (claim: Awaited<ReturnType<typeof admit>>[number]) => completeTeardownClaim(sql,
    { claim, teardown: output, transcript: null, tier: "bulk", model: "saved-model" });
  const retry = (claim: Awaited<ReturnType<typeof admit>>[number]) => retryVideoTeardown(sql,
    { orgId: org, instanceId: instance, clipId: claim.id, expectedClaimUUID: claim.claim_id, operatorId: "operator" });
  const currentSnapshot = async (id: string) => (await sql<{ snapshot: Record<string, unknown> }[]>`
    select ${teardownSnapshotSql(sql)} as snapshot from noelle.video_clips c where c.id=${id}`)[0]!.snapshot;

  it("commits one stable attempt before dispatch and completes an acknowledged receipt once", async () => {
    await clip(); const [claim] = await admit(); expect(claim).toBeDefined();
    expect((await attempts())[0]).toMatchObject({ id: claim!.claim_id, status: "building" });
    expect(await admit()).toHaveLength(0); expect(await markTeardownDispatched(sql, claim!)).toBe(true);
    expect(await complete(claim!)).toBe(true); expect(await complete(claim!)).toBe(false);
    expect((await attempts())[0]).toMatchObject({ status: "complete" });
    expect(await sql`select id from noelle.video_teardowns`).toHaveLength(1); expect(await retry(claim!)).toBeNull();
  });
  it("serializes concurrent admissions across distinct clips under the daily reservation", async () => {
    await clip(); await clip(); const results = await Promise.all([admit(4, 1), admit(4, 1)]);
    expect(results.flat()).toHaveLength(1); expect(await attempts()).toHaveLength(1);
  });
  it("retains unknown predecessor history, queues one explicit retry and admits that same UUID", async () => {
    await clip(); const [claim] = await admit(); await markTeardownDispatched(sql, claim!);
    expect(await markTeardownClaimOutcome(sql, claim!, "unknown", "generation_unknown")).toBe(true);
    const retries = await Promise.all([retry(claim!), retry(claim!)]); const queued = retries.find(Boolean);
    expect(retries.filter(Boolean)).toHaveLength(1);
    expect(await attempts()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: claim!.claim_id, status: "superseded" }),
      expect.objectContaining({ id: queued, status: "queued", predecessor_id: claim!.claim_id, operator_id: "operator" }),
    ]));
    expect(await admit(4, 1)).toHaveLength(0);
    const [second] = await admit(4, 2); expect(second?.claim_id).toBe(queued);
    expect(await complete(claim!)).toBe(false); expect(await markTeardownClaimOutcome(sql, claim!, "released", "extraction_failed")).toBe(false);
  });
  it.each(["extraction_failed", "preparation_failed"] as const)("releases a proven %s and preserves its history", async reason => {
    await clip(); const [claim] = await admit(4, 1);
    expect(await markTeardownClaimOutcome(sql, claim!, "released", reason)).toBe(true);
    expect((await attempts())[0]).toMatchObject({ status: "released", reason });
    expect((await admit(4, 1))[0]?.claim_id).not.toBe(claim!.claim_id); expect(await attempts()).toHaveLength(2);
  });
  it.each(["extraction_failed", "preparation_failed"] as const)("never releases dispatched work as %s", async reason => {
    await clip(); const [claim] = await admit(); await markTeardownDispatched(sql, claim!);
    expect(await markTeardownClaimOutcome(sql, claim!, "released", reason)).toBe(false);
    expect((await attempts())[0]?.status).toBe("dispatched");
  });
  it("does not release a foreign, superseded or already-held preparation identity", async () => {
    await clip(); const [claim] = await admit();
    expect(await markTeardownClaimOutcome(sql, { ...claim!, org_id: otherOrg }, "released", "preparation_failed")).toBe(false);
    await markTeardownClaimOutcome(sql, claim!, "unknown", "dispatch_uncertain");
    expect(await markTeardownClaimOutcome(sql, claim!, "released", "preparation_failed")).toBe(false);
    expect(await retry(claim!)).not.toBeNull();
    expect(await markTeardownClaimOutcome(sql, claim!, "released", "preparation_failed")).toBe(false);
    expect((await attempts())[0]?.status).toBe("superseded");
  });
  it("excludes foreign soft references and changed current roles before admission", async () => {
    await clip(true); expect(await admit()).toHaveLength(0);
    await clip(); await sql`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
    expect(await admit()).toHaveLength(0); expect(await attempts()).toHaveLength(0);
  });
  it("rejects a changed captured source both before dispatch and after a response", async () => {
    const id = await clip(); const [claim] = await admit();
    await sql`update noelle.video_clips set caption='Changed' where id=${id}`;
    expect(await markTeardownDispatched(sql, claim!)).toBe(false);
    await sql`update noelle.video_clips set caption='Saved caption' where id=${id}`;
    expect(await markTeardownDispatched(sql, claim!)).toBe(true);
    await sql`update noelle.video_clips set views=0 where id=${id}`;
    expect(await complete(claim!)).toBe(false); expect(await sql`select id from noelle.video_teardowns`).toHaveLength(0);
    expect(await markTeardownClaimOutcome(sql, claim!, "failed", "source_changed")).toBe(true);
  });
  it("rejects a refreshed caller snapshot for an old admitted identity before dispatch", async () => {
    const id = await clip(); const [claim] = await admit();
    await sql`update noelle.video_clips set caption='Changed after admission' where id=${id}`;
    const refreshed = { ...claim!, source_snapshot: await currentSnapshot(id) };
    expect(await markTeardownDispatched(sql, refreshed)).toBe(false);
    expect((await attempts())[0]?.status).toBe("building");
  });
  it("rejects a refreshed caller snapshot for a dispatched identity before writing output", async () => {
    const id = await clip(); const [claim] = await admit(); await markTeardownDispatched(sql, claim!);
    await sql`update noelle.video_clips set caption='Changed after dispatch' where id=${id}`;
    const refreshed = { ...claim!, source_snapshot: await currentSnapshot(id) };
    expect(await complete(refreshed)).toBe(false);
    expect(await sql`select id from noelle.video_teardowns`).toHaveLength(0);
    expect((await attempts())[0]?.status).toBe("dispatched");
  });
  it("excludes legacy and independently foreign completed receipts before claim admission", async () => {
    const id = await clip(); await sql`insert into noelle.video_teardowns(org_id,agent_instance_id,clip_id,platform,teardown)
      values (${otherOrg},${otherInstance},${id},'instagram',${sql.json(output as never)})`;
    expect(await admit()).toHaveLength(0); expect(await attempts()).toHaveLength(0);
  });
  it("caps high batch admission at ten and rejects invalid budgets before SQL", async () => {
    for (let n = 0; n < 11; n++) await clip(); expect(await admit(100)).toHaveLength(10);
    for (const invalid of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => admit(invalid)).toThrow(RangeError);
      expect(() => admit(4, invalid)).toThrow(RangeError);
    }
  });
  it("retains attempt history under application credentials while preserving read and update access", async () => {
    await clip(); const [claim] = await admit();
    const [permissions] = await sql`select has_table_privilege('noelle_app','noelle.video_teardown_attempts','DELETE') as delete_allowed,
      has_table_privilege('noelle_app','noelle.video_teardown_attempts','SELECT') as select_allowed,
      has_table_privilege('noelle_app','noelle.video_teardown_attempts','INSERT') as insert_allowed,
      has_table_privilege('noelle_app','noelle.video_teardown_attempts','UPDATE') as update_allowed`;
    expect(permissions).toEqual({ delete_allowed: false, select_allowed: true, insert_allowed: true, update_allowed: true });
    await sql.begin(async tx => {
      await tx.unsafe("set local role noelle_app");
      expect(await tx`select id from noelle.video_teardown_attempts where id=${claim!.claim_id}`).toHaveLength(1);
      expect(await tx`update noelle.video_teardown_attempts set reason='generation_in_progress'
        where id=${claim!.claim_id} returning id`).toHaveLength(1);
    });
    await expect(sql.begin(async tx => {
      await tx.unsafe("set local role noelle_app");
      await tx`delete from noelle.video_teardown_attempts where id=${claim!.claim_id}`;
    })).rejects.toMatchObject({ code: "42501" });
    expect(await attempts()).toHaveLength(1);
  });
  it("preserves administrative organization cascade and migration rerun", async () => {
    await sql.unsafe(await readFile(new URL("../../../infra/cloudsql/schema/0124_video_teardown_preparation_failed.sql", import.meta.url), "utf8"));
    await clip(); const [claim] = await admit(); await markTeardownDispatched(sql, claim!); await complete(claim!);
    await sql`delete from noelle.organizations where id=${org}`;
    expect(await attempts()).toHaveLength(0); expect(await sql`select id from noelle.video_teardowns`).toHaveLength(0);
  });
  it("counts a completed admitted attempt once alongside legacy completed outputs", async () => {
    await clip(); const [claim] = await admit(); await markTeardownDispatched(sql, claim!); await complete(claim!);
    await clip(); expect(await admit(4, 1)).toHaveLength(0); expect(await admit(4, 2)).toHaveLength(1);
  });
  it("does not admit an already spent identity merely because its status was changed to queued", async () => {
    await clip(); const [claim] = await admit();
    await sql`update noelle.video_teardown_attempts set status='queued' where id=${claim!.claim_id}`;
    expect(await admit()).toHaveLength(0); expect(await attempts()).toHaveLength(1);
  });
  it("rechecks a changed current parent after its row lock before reserving work", async () => {
    await clip(); let release!: () => void; let enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const locked = new Promise<void>(resolve => { enter = resolve; });
    const mutation = sql.begin(async tx => {
      await tx`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`; enter(); await held;
    });
    await locked; let settled = false; const pending = admit().then(value => { settled = true; return value; });
    try { await new Promise(resolve => setTimeout(resolve, 40)); expect(settled).toBe(false); }
    finally { release(); await mutation; }
    expect(await pending).toHaveLength(0); expect(await attempts()).toHaveLength(0);
  });
  it("rechecks a changed source snapshot after its row lock before dispatch", async () => {
    const id = await clip(); const [claim] = await admit(); let release!: () => void; let enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const locked = new Promise<void>(resolve => { enter = resolve; });
    const mutation = sql.begin(async tx => { await tx`update noelle.video_clips set caption='Changed while held' where id=${id}`; enter(); await held; });
    await locked; let settled = false; const pending = markTeardownDispatched(sql, claim!).then(value => { settled = true; return value; });
    try { await new Promise(resolve => setTimeout(resolve, 40)); expect(settled).toBe(false); }
    finally { release(); await mutation; }
    expect(await pending).toBe(false); expect((await attempts())[0]?.status).toBe("building");
  });
  it("times out a held parent without a late dispatch marker after the lock is released", async () => {
    await clip(); const [claim] = await admit(); let release!: () => void; let enter!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); const locked = new Promise<void>(resolve => { enter = resolve; });
    const mutation = sql.begin(async tx => { await tx`select id from noelle.agent_instances where id=${instance} for update`; enter(); await held; });
    await locked;
    try { await expect(markTeardownDispatched(sql, claim!)).rejects.toMatchObject({ category: "deadline" }); }
    finally { release(); await mutation; }
    expect((await attempts())[0]?.status).toBe("building");
  }, 10000);
});
