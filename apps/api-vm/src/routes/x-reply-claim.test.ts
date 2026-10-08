import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import { actuator } from "./actuator.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const approvalId = "22222222-2222-4222-8222-222222222222";
const review = {
  pass: true, judgeOk: true,
  scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 0.9 },
};

function fakeDb() {
  const claims = new Set<string>();
  let authorWrites = 0;
  let todayReplies = 0;
  const queries: string[] = [];
  const row = {
    approval_id: approvalId, draft_id: "33333333-3333-4333-8333-333333333333",
    lead_id: "44444444-4444-4444-8444-444444444444",
    draft_payload: { kind: "reply", body: "Specific, useful reply", verifier_meta: review },
    lead_payload: { source: "extension_observed", classifier: { judge: "jev" }, posted_at: null as string | null },
    external_id: "1837123456789012345", author_handle: "ada",
    auto_send_target_at: null, status: "pending",
    reply_send_enabled: true, auto_send_enabled: false,
    actuator_daily_reply_cap: null as number | null,
    actuator_daily_reply_cap_min: null as number | null,
    sampled_day: null as string | null,
    actuator_daily_reply_cap_effective: null as number | null,
    today: "2026-10-07",
    cap_instance_id: "55555555-5555-4555-8555-555555555555",
  };
  const sql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?").toLowerCase();
    queries.push(query);
    if (query.includes("from noelle.organizations") && query.includes("for update")) return [{ id: orgId }];
    if (query.includes("from noelle.agent_instances")) {
      return [row];
    }
    if (query.includes("select a.id as approval_id")) return [row];
    if (query.includes("from noelle.drafts") && query.includes("for update")) return [{ id: row.draft_id }];
    if (query.includes("with author as")) return [{ n: authorWrites + claims.size }];
    if (query.includes("insert into noelle.x_reply_claims")) {
      if (claims.has(row.external_id)) return [];
      claims.add(row.external_id);
      return [{ approval_id: approvalId }];
    }
    if (query.includes("join noelle.leads l2")) return [{ n: authorWrites }];
    if (query.includes("select count(*)")) return [{ n: todayReplies }];
    if (query.includes("select distinct tweet_id")) return [];
    return [];
  }) as unknown as { (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>; json(v: unknown): unknown; begin(fn: (tx: unknown) => Promise<unknown>): Promise<unknown> };
  sql.json = (v) => v;
  sql.begin = async (fn) => {
    const before = new Set(claims);
    try { return await fn(sql); }
    catch (error) { claims.clear(); for (const id of before) claims.add(id); throw error; }
  };
  return { sql: sql as never, row, claims,
    queries,
    setAuthorWrites: (n: number) => { authorWrites = n; },
    setTodayReplies: (n: number) => { todayReplies = n; } };
}

describe("X browser pre-send claim", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = "postgres://test:test@127.0.0.1:5432/test";
    process.env.NOELLE_HMAC_SECRET = "h".repeat(48);
    process.env.NOELLE_ACTUATOR_TOKEN = "actor-test";
    process.env.NOELLE_ACTUATOR_ORG_ID = orgId;
    delete process.env.NOELLE_X_ACTUATOR_PER_AUTHOR_DAILY_CAP;
    delete process.env.X_REPLY_MAX_AGE_HOURS;
    resetEnvForTests(); resetDbClientForTests();
  });
  const claim = () => new Hono().route("/", actuator).request(`/api/x-actuator/claim-reply/${approvalId}`, {
    method: "POST", headers: { authorization: "Bearer actor-test" },
  });

  it("permanently claims a tweet once before the actor submits", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const first = await claim();
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ claimed: true, tweetId: db.row.external_id });
    const second = await claim();
    expect(second.status).toBe(409);
    expect(db.claims.size).toBe(1);
  });

  it("withholds absent review, autosend ownership, or disabled consent", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    db.row.draft_payload = { ...db.row.draft_payload, verifier_meta: { ...review, judgeOk: false } };
    expect((await claim()).status).toBe(409);
    db.row.draft_payload.verifier_meta = review;
    db.row.auto_send_target_at = "2026-09-19T10:00:00Z" as never;
    expect((await claim()).status).toBe(409);
    db.row.auto_send_target_at = null;
    db.row.reply_send_enabled = false;
    expect((await claim()).status).toBe(409);
    expect(db.claims.size).toBe(0);
  });

  it("rechecks the configured per-author send cap before reserving", async () => {
    process.env.NOELLE_X_ACTUATOR_PER_AUTHOR_DAILY_CAP = "1";
    const db = fakeDb(); db.setAuthorWrites(1); __setDbClientForTests(db.sql);
    const response = await claim();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ claimed: false, reason: "per-author-cap" });
    expect(db.claims.size).toBe(0);
  });

  it("uses a live cap override at the pre-submit claim", async () => {
    const db = fakeDb(); db.row.actuator_daily_reply_cap = 80; db.setTodayReplies(80);
    __setDbClientForTests(db.sql);
    const response = await claim();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ claimed: false, reason: "daily-cap" });
    expect(db.claims.size).toBe(0);
    expect(db.queries.some((q) => q.includes("from noelle.organizations") && q.includes("for update"))).toBe(true);
    expect(db.queries.some((q) => q.includes("from noelle.x_reply_claims") && q.includes("count(*)"))).toBe(true);
  });

  it("cap two permits the second reply and rejects a third", async () => {
    process.env.NOELLE_X_ACTUATOR_PER_AUTHOR_DAILY_CAP = "2";
    const second = fakeDb(); second.setAuthorWrites(1); __setDbClientForTests(second.sql);
    expect((await claim()).status).toBe(200);
    const third = fakeDb(); third.setAuthorWrites(2); __setDbClientForTests(third.sql);
    const response = await claim();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ claimed: false, reason: "per-author-cap" });
    expect(third.claims.size).toBe(0);
  });

  it("allows an older Jev observation while retaining the legacy X age ceiling", async () => {
    process.env.X_REPLY_MAX_AGE_HOURS = "1";
    const observed = fakeDb(); __setDbClientForTests(observed.sql);
    observed.row.lead_payload.posted_at = "2026-09-15T12:00:00Z";
    expect((await claim()).status).toBe(200);
    const legacy = fakeDb(); __setDbClientForTests(legacy.sql);
    legacy.row.lead_payload.source = "apify";
    legacy.row.lead_payload.posted_at = "2026-09-15T12:00:00Z";
    const response = await claim();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ claimed: false, reason: "stale" });
  });
  it.each(["", " ", "\t"])("does not disable the stale-target claim guard for blank configuration %j", async raw => {
    process.env.X_REPLY_MAX_AGE_HOURS = raw;
    const db = fakeDb(); __setDbClientForTests(db.sql);
    db.row.lead_payload.source = "apify";
    db.row.lead_payload.posted_at = new Date(Date.now() - 48 * 3600_000).toISOString();
    const response = await claim();
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ claimed: false, reason: "stale" });
    expect(db.claims.size).toBe(0);
  });
  it("preserves an explicit zero age ceiling", async () => {
    process.env.X_REPLY_MAX_AGE_HOURS = "0";
    const db = fakeDb(); __setDbClientForTests(db.sql);
    db.row.lead_payload.source = "apify";
    db.row.lead_payload.posted_at = new Date(Date.now() - 48 * 3600_000).toISOString();
    expect((await claim()).status).toBe(200);
    expect(db.claims.size).toBe(1);
  });
});
