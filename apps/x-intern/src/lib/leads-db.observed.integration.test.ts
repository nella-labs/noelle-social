import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { claimObservedLeadsForDrafting } from "./leads-db.js";

const url = process.env.NOELLE_TEST_DATABASE_URL;
const instanceId = "00000000-0000-4000-8000-000000000001";
const orgId = "00000000-0000-4000-8000-000000000002";

describe.skipIf(!url)("X browser reply capacity (integration)", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const [row] = await sql<{ db: string }[]>`select current_database() as db`;
    if (!row?.db.includes("test")) throw new Error("Reply capacity tests require a test database");
  });
  beforeEach(async () => {
    await sql`drop schema if exists noelle cascade`;
    await sql`create schema noelle`;
    await sql`create table noelle.leads (
      id uuid primary key, org_id uuid not null, agent_instance_id uuid not null, platform text not null,
      status text not null, payload jsonb not null, author_handle text,
      external_id text, author_id text, tier text, classifier_label text,
      classifier_score numeric, priority boolean, created_at timestamptz default now(),
      updated_at timestamptz default now()
    )`;
    await sql`create table noelle.drafts (id uuid primary key, lead_id uuid, payload jsonb not null, sent_at timestamptz)`;
    await sql`create table noelle.approvals (id uuid primary key, org_id uuid, lead_id uuid,
      draft_id uuid, status text not null, decided_at timestamptz, created_at timestamptz default now())`;
    await sql`create table noelle.agent_instances (id uuid primary key, org_id uuid not null)`;
    await sql`insert into noelle.agent_instances values (${instanceId}, ${orgId})`;
    await sql`create table noelle.x_activity (org_id uuid, tweet_id text, type text, reason text)`;
    await sql`create table noelle.x_reply_claims (org_id uuid, tweet_id text)`;
  });
  afterAll(async () => { await sql?.end(); });

  async function insertObserved(n: number, options: {
    author?: string; likes?: number; replies?: number; hoursAgo?: number;
    status?: string; judge?: string; score?: number; payload?: Record<string, unknown>;
  } = {}): Promise<string> {
    const id = `00000000-0000-4000-8010-${String(n).padStart(12, "0")}`;
    const payload = {
      source: "extension_observed",
      classifier: { judge: options.judge ?? "jev" },
      likeCount: options.likes ?? 0,
      replyCount: options.replies ?? 0,
      posted_at: new Date(Date.now() - (options.hoursAgo ?? 1) * 3_600_000).toISOString(),
      ...options.payload,
    };
    await sql`insert into noelle.leads
      (id, org_id, agent_instance_id, platform, status, payload, author_handle, classifier_score, external_id)
      values (${id}, ${orgId}, ${instanceId}, 'x', ${options.status ?? "classified"},
              ${sql.json(payload)}, ${options.author ?? `author-${n}`}, ${options.score ?? null}, ${String(n)})`;
    return id;
  }

  async function makeEligible(n: number, leadId: string): Promise<void> {
    const draftId = `00000000-0000-4000-8020-${String(n).padStart(12, "0")}`;
    const approvalId = `00000000-0000-4000-8021-${String(n).padStart(12, "0")}`;
    await sql`insert into noelle.drafts (id, lead_id, payload)
      values (${draftId}, ${leadId},
        '{"kind":"reply","verifier_meta":{"pass":true,"judgeOk":true}}')`;
    await sql`insert into noelle.approvals (id, org_id, lead_id, draft_id, status)
      values (${approvalId}, ${orgId}, ${leadId}, ${draftId}, 'pending')`;
  }

  it("reserves seven of twelve available browser slots for fresh high-momentum on-brand posts", async () => {
    const wantedTrending: string[] = [];
    for (let n = 1; n <= 6; n++) {
      wantedTrending.push(await insertObserved(n, { likes: 150, hoursAgo: 1 }));
    }
    wantedTrending.push(await insertObserved(7, { likes: 12, hoursAgo: 1 }));
    const slowerTrending = await insertObserved(8, { likes: 80, hoursAgo: 20 });
    const wantedNormal: string[] = [];
    for (let n = 9; n <= 14; n++) {
      const id = await insertObserved(n, { likes: 4, hoursAgo: n - 8 });
      if (n < 14) wantedNormal.push(id);
    }
    await insertObserved(15, { likes: 10_000, status: "observed" });
    await insertObserved(16, { likes: 10_000, judge: "other" });
    await insertObserved(17, { likes: 10_000, hoursAgo: 30 });

    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 });

    expect(claimed.map((lead) => lead.id).sort()).toEqual([...wantedTrending, ...wantedNormal].sort());
    expect(claimed).toHaveLength(12);
    expect(claimed.some((lead) => lead.id === slowerTrending)).toBe(false);
  });

  it("backfills normal posts when trending supply is smaller than the reserve", async () => {
    const trending = [
      await insertObserved(1, { likes: 80 }),
      await insertObserved(2, { replies: 14 }),
    ];
    const normal: string[] = [];
    for (let n = 3; n <= 13; n++) {
      const id = await insertObserved(n, { likes: 2, hoursAgo: n - 2 });
      if (n < 13) normal.push(id);
    }

    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 });

    expect(claimed.map((lead) => lead.id).sort()).toEqual([...trending, ...normal].sort());
  });

  it("claims the higher Jev score before a fresher normal post", async () => {
    const better = await insertObserved(1, { score: 0.74, hoursAgo: 3, likes: 2 });
    await insertObserved(2, { score: 0.36, hoursAgo: 1, likes: 4 });

    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 1 });

    expect(claimed.map((lead) => lead.id)).toEqual([better]);
  });

  it("returns claimed posts in draft-processing priority order", async () => {
    const weaker = await insertObserved(1, { score: 0.36, hoursAgo: 1, likes: 4 });
    const stronger = await insertObserved(2, { score: 0.74, hoursAgo: 3, likes: 2 });

    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 2 });

    expect(claimed.map((lead) => lead.id)).toEqual([stronger, weaker]);
  });

  it("keeps the trending reserve and favors Jev score over momentum inside it", async () => {
    const betterTrend = await insertObserved(1, { score: 0.74, hoursAgo: 3, likes: 50 });
    await insertObserved(2, { score: 0.36, hoursAgo: 1, likes: 500 });
    await insertObserved(3, { score: 0.95, hoursAgo: 1, likes: 2 });

    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 1 });

    expect(claimed.map((lead) => lead.id)).toEqual([betterTrend]);
  });

  it("counts eligible replies already occupying slots and blocks another reply to their authors", async () => {
    for (let n = 1; n <= 8; n++) {
      const leadId = await insertObserved(n, {
        author: `active-${n}`, status: n <= 2 ? "drafting" : "drafted",
        likes: n <= 6 ? 80 : 2,
      });
      if (n > 2) await makeEligible(n, leadId);
    }
    const expectedTrending = await insertObserved(9, { likes: 100, hoursAgo: 1 });
    await insertObserved(10, { likes: 90, hoursAgo: 4 });
    const expectedNormal: string[] = [];
    for (let n = 11; n <= 15; n++) {
      const id = await insertObserved(n, { likes: 2, hoursAgo: n - 10 });
      if (n <= 13) expectedNormal.push(id);
    }
    await insertObserved(16, { author: "ACTIVE-3", likes: 10_000 });

    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 });

    expect(claimed.map((lead) => lead.id).sort()).toEqual([expectedTrending, ...expectedNormal].sort());
    expect(claimed).toHaveLength(4);
  });

  it("does not let five failed pending reviews block a new post from the same author", async () => {
    for (let n = 1; n <= 5; n++) {
      const id = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
      const draftId = `00000000-0000-4000-8001-${String(n).padStart(12, "0")}`;
      const approvalId = `00000000-0000-4000-8002-${String(n).padStart(12, "0")}`;
      await sql`insert into noelle.leads (id, org_id, agent_instance_id, platform, status, payload, author_handle)
        values (${id}, ${orgId}, ${instanceId}, 'x', 'drafted', '{"source":"extension_observed"}', ${`author-${n}`})`;
      await sql`insert into noelle.drafts (id, lead_id, payload)
        values (${draftId}, ${id}, '{"kind":"reply","verifier_meta":{"pass":false,"judgeOk":true}}')`;
      await sql`insert into noelle.approvals (id, lead_id, draft_id, status)
        values (${approvalId}, ${id}, ${draftId}, 'pending')`;
    }
    const candidateId = "00000000-0000-4000-8003-000000000001";
    await sql`insert into noelle.leads (id, org_id, agent_instance_id, platform, status, payload, author_handle)
      values (${candidateId}, ${orgId}, ${instanceId}, 'x', 'classified',
        '{"source":"extension_observed","classifier":{"judge":"jev"}}', 'author-1')`;

    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 5 });
    expect(claimed.map((lead) => lead.id)).toEqual([candidateId]);
  });

  it("does not crash on malformed observations and persists score components", async () => {
    const id = await insertObserved(1, { score: 0.9, payload: {
      posted_at: "2026-19-99", likeCount: "not-a-count", replyCount: { unknown: true },
    } });
    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 1 });
    expect(claimed[0]?.id).toBe(id);
    expect(claimed[0]?.payload.opportunity).toMatchObject({ version: 1, quality: 0.9,
      age_hours: null, momentum: null, trending: false });
    expect(claimed[0]?.classifier_score).toBe("0.9");
  });

  it("blocks exact sent targets, ambiguous submits, reservations and known conversations", async () => {
    const sent = await insertObserved(1, { status: "drafted", payload: { conversation_id: "900" } });
    await makeEligible(1, sent);
    await sql`update noelle.approvals set status = 'sent', decided_at = now() where lead_id = ${sent}`;
    await insertObserved(2, { payload: { conversation_id: "900" } });
    await insertObserved(3);
    await sql`insert into noelle.x_activity values (${orgId}, '3', 'skip', 'reply-failed:ambiguous-dropped')`;
    await insertObserved(4);
    await sql`insert into noelle.x_reply_claims values (${orgId}, '4')`;
    const duplicate = await insertObserved(6);
    await sql`update noelle.leads set external_id = '1' where id = ${duplicate}`;
    const safe = await insertObserved(5);
    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 });
    expect(claimed.map((lead) => lead.id)).toEqual([safe]);
  });

  it("claims only one known conversation and favors a fresh author over recent repeated replies", async () => {
    const sent = await insertObserved(1, { status: "drafted", author: "frequent" });
    await makeEligible(1, sent);
    await sql`update noelle.approvals set status = 'sent', decided_at = now() where lead_id = ${sent}`;
    await insertObserved(2, { author: "frequent", score: 0.9 });
    const fresh = await insertObserved(3, { author: "new-author", score: 0.9, payload: { conversation_id: "900" } });
    await insertObserved(4, { score: 0.9, hoursAgo: 2, payload: { conversation_id: "900" } });
    const claimed = await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 1 });
    expect(claimed.map((lead) => lead.id)).toEqual([fresh]);
  });

  it("preserves explicit manual requests for their separate claim lane", async () => {
    await insertObserved(1, { payload: { reply_requested: true, reply_request: { request_key: "manual-1" } } });
    const safe = await insertObserved(2);
    expect((await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 }))
      .map((lead) => lead.id)).toEqual([safe]);
  });

  it("bounds reads per author so a prolific author cannot fill the candidate pool", async () => {
    const newest = await insertObserved(1, { author: "prolific", score: 0.95 });
    for (let n = 2; n <= 205; n++) await insertObserved(n, { author: "prolific", score: 0.95, hoursAgo: 3 });
    const other = await insertObserved(206, { author: "other", score: 0.9 });
    expect((await claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 }))
      .map((lead) => lead.id).sort()).toEqual([newest, other].sort());
  });

  it("counts newly committed capacity after waiting for the instance lock", async () => {
    for (let n = 1; n <= 13; n++) await insertObserved(n, { score: 0.9 });
    let unlock!: () => void;
    let locked!: () => void;
    const gate = new Promise<void>((resolve) => { unlock = resolve; });
    const acquired = new Promise<void>((resolve) => { locked = resolve; });
    const writer = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${'x-observed:' + instanceId}, 0))`;
      await tx`update noelle.leads set status = 'drafting' where external_id <> '13'`;
      locked();
      await gate;
    });
    await acquired;
    const claim = claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    unlock();
    await writer;
    expect(await claim).toEqual([]);
  });

  it("serializes concurrent claims so they cannot exceed twelve active slots", async () => {
    for (let n = 1; n <= 20; n++) await insertObserved(n, { score: 0.9 });
    const results = await Promise.all([
      claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 }),
      claimObservedLeadsForDrafting(sql, { agentInstanceId: instanceId, cap: 12 }),
    ]);
    const ids = results.flatMap((rows) => rows.map((lead) => lead.id));
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });
});
