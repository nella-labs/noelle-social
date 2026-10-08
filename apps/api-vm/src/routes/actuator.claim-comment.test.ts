import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import { actuator, type JoinedRow } from "./actuator.js";

vi.mock("./drafts.js", () => ({
  markApprovalSent: vi.fn(async () => ({
    ok: true, result: { approval_id: approvalId, status: "sent" },
  })),
}));

const orgId = "11111111-1111-4111-8111-111111111111";
const approvalId = "22222222-2222-4222-8222-222222222222";
const postUrn = "urn:li:activity:7481524546924343296";
const goodRow: JoinedRow = {
  approval_id: approvalId,
  draft_id: "33333333-3333-4333-8333-333333333333",
  lead_id: "44444444-4444-4444-8444-444444444444",
  draft_payload: {
    kind: "reply", body: "A grounded comment",
    verifier_meta: {
      pass: true, judgeOk: true, judgeProvider: "jev",
      scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 0.9 },
    },
  },
  lead_payload: {
    original_post_url: "https://www.linkedin.com/posts/ada_activity-7481524546924343296-abc",
  },
  lead_external_id: "urn:li:comment:9999999999999999999",
  author_handle: "ada", author_id: "ada", wp_name: "Ada",
};

function fakeDb(opts: {
  row?: JoinedRow | null;
  status?: string;
  consent?: boolean;
  insertResult?: boolean;
  failInsert?: boolean;
  cap?: number;
  sentToday?: number;
} = {}) {
  const inserts: unknown[][] = [];
  const sentClaims: string[] = [];
  const queries: string[] = [];
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").toLowerCase();
    if (query === "d.payload" || query.startsWith("(") && query.includes("human_review_required")) return [];
    return (async () => {
      queries.push(query);
      if (query.includes("set local")) return [];
      if (query.includes("from noelle.leads") && query.includes("for no key update")) return [{ id: "locked" }];
      if (query.includes("for update") && (query.includes("from noelle.drafts") || query.includes("from noelle.approvals"))) return [{ id: "locked" }];
      if (query.includes("from noelle.organizations") && query.includes("for update")) return [{ id: orgId }];
      if (query.includes("from noelle.agent_instances") && query.includes("for update")) {
        return [{ actuator_daily_reply_cap: opts.cap ?? null }];
      }
      if (query.includes("from noelle.approvals a") && !query.includes("insert into")) {
        if (opts.row === null) return [];
        return [{ ...goodRow, ...opts.row, status: opts.status ?? "pending",
          reply_send_enabled: opts.consent ?? true, auto_send_enabled: false,
          actuator_daily_reply_cap: opts.cap ?? null, cap_instance_id: "55555555-5555-4555-8555-555555555555" }];
      }
      if (query.includes("count(*)") && (query.includes("from noelle.linkedin_activity") ||
          query.includes("from noelle.linkedin_reply_claims"))) {
        return [{ n: opts.sentToday ?? 0 }];
      }
      if (query.includes("insert into noelle.linkedin_reply_claims")) {
        if (opts.failInsert) throw new Error("database unavailable");
        inserts.push(values);
        return opts.insertResult === false ? [] : [{ activity_urn: postUrn }];
      }
      if (query.includes("update noelle.linkedin_reply_claims")) {
        sentClaims.push(values[1] as string);
        return [];
      }
      throw new Error(`unexpected query: ${query}`);
    })();
  }) as unknown as { (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>; begin: (fn: (tx: unknown) => Promise<unknown>) => Promise<unknown> };
  sql.begin = async (fn) => fn(sql);
  Object.assign(sql, { json: (value: unknown) => value, unsafe: (fragment: string) => fragment });
  return { sql: sql as never, inserts, sentClaims, queries };
}

describe("POST /api/actuator/claim-comment/:id", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = "postgres://test:test@127.0.0.1:5432/test";
    process.env.NOELLE_HMAC_SECRET = "h".repeat(48);
    process.env.NOELLE_ACTUATOR_TOKEN = "actor-test";
    process.env.NOELLE_ACTUATOR_ORG_ID = orgId;
    delete process.env.NOELLE_LINKEDIN_DAILY_WRITE_CAP;
    resetEnvForTests();
    resetDbClientForTests();
  });
  afterEach(() => resetDbClientForTests());

  const request = (body?: unknown, token = "actor-test") =>
    new Hono().route("/", actuator).request(`/api/actuator/claim-comment/${approvalId}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body ?? { activity_urn: "urn:li:activity:0000000000000000000" }),
    });

  it("requires the actuator token before reaching the database", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    expect((await request({}, "wrong-token")).status).toBe(401);
    expect(db.inserts).toHaveLength(0);
  });

  it("claims the canonical post URN from the saved lead URL, ignoring client and comment IDs", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const response = await request({ activity_urn: "urn:li:activity:0000000000000000000" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claimed: true });
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]).toContain(postUrn);
    expect(db.inserts[0]).not.toContain("urn:li:activity:0000000000000000000");
  });

  it.each([
    ["other tenant", { row: null }, "not-eligible"],
    ["decided approval", { status: "sent" }, "not-eligible"],
    ["consent off", { consent: false }, "not-eligible"],
    ["failed review", { row: { draft_payload: { ...goodRow.draft_payload, verifier_meta: { ...goodRow.draft_payload!.verifier_meta!, pass: false } } } }, "not-eligible"],
    ["missing post id", { row: { lead_payload: { url: "https://www.linkedin.com/feed/" } } }, "not-eligible"],
    ["duplicate claim", { insertResult: false }, "already-claimed"],
  ] as const)("withholds %s", async (_name, opts, reason) => {
    const db = fakeDb(opts as Parameters<typeof fakeDb>[0]); __setDbClientForTests(db.sql);
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ claimed: false, reason });
    if (reason === "not-eligible") expect(db.inserts).toHaveLength(0);
  });

  it("fails closed when the durable insert errors", async () => {
    const db = fakeDb({ failInsert: true }); __setDbClientForTests(db.sql);
    const response = await request();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ claimed: false, reason: "claim-unavailable" });
  });

  it("rechecks the live reply cap immediately before a browser comment", async () => {
    const db = fakeDb({ cap: 20, sentToday: 20 }); __setDbClientForTests(db.sql);
    const response = await request();
    expect(await response.json()).toEqual({ claimed: false, reason: "daily-cap" });
    expect(db.inserts).toHaveLength(0);
    expect(db.queries.some((q) => q.includes("from noelle.organizations") && q.includes("for update"))).toBe(true);
    expect(db.queries.some((q) => q.includes("from noelle.linkedin_reply_claims") && q.includes("count(*)"))).toBe(true);
  });

  it("also rechecks the older combined comment and DM write cap", async () => {
    process.env.NOELLE_LINKEDIN_DAILY_WRITE_CAP = "20";
    const db = fakeDb({ sentToday: 20 }); __setDbClientForTests(db.sql);
    const response = await request();
    expect(await response.json()).toEqual({ claimed: false, reason: "daily-cap" });
    expect(db.inserts).toHaveLength(0);
  });

  it("marks a claimed comment sent after mark-sent succeeds", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const response = await new Hono().route("/", actuator).request(`/api/actuator/mark-sent/${approvalId}`, {
      method: "POST", headers: { authorization: "Bearer actor-test" },
    });
    expect(response.status).toBe(200);
    expect(db.sentClaims).toEqual([approvalId]);
  });
});
