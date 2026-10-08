import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import {
  __setDbClientForTests,
  resetDbClientForTests,
} from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import type { AuthContext } from "../middleware/jwt.js";
import {
  XAuthError,
  XError,
  XRateLimitError,
  XWriteUncertainError,
  type XClient,
} from "@noelle/x-client";
import { SecretAccessError, type SecretsClient } from "@noelle/secrets";

beforeAll(() => {
  process.env.PORT = "18791";
  process.env.NODE_ENV = "test";
  // Required by Zod for loadEnv(), never dialled (db is stubbed via
  // __setDbClientForTests below).
  process.env.NOELLE_DATABASE_URL =
    "postgres://noelle_app:test@127.0.0.1:5432/noelle?sslmode=require";
  process.env.NOELLE_SUPABASE_JWT_SECRET = "test-jwt-secret";
  process.env.NOELLE_HMAC_SECRET = "y".repeat(48);
  process.env.GCP_PROJECT = "noelle-agents-test";
  delete process.env.NOELLE_SUPABASE_URL;
  delete process.env.NOELLE_SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.OPENCLAW_SUPABASE_URL;
  delete process.env.OPENCLAW_SUPABASE_SERVICE_ROLE_KEY;
  resetEnvForTests();
});

// ---------------------------------------------------------------------------
// Fake `sql` mirroring the route's surface: an approval+lead join SELECT,
// a sql.begin transaction with UPDATEs on drafts/approvals + the sibling-skip
// UPDATE…RETURNING, and the shared isOrgMember tenancy probe.
// ---------------------------------------------------------------------------

interface SqlCall {
  text: string;
  values: unknown[];
}

interface ApprovalJoinedRow {
  id: string;
  org_id: string;
  draft_id: string;
  agent_instance_id?: string;
  lead_id: string | null;
  status: string;
  decided_at: string | null;
  decided_by?: string | null;
  /** Real X tweet id the reply will quote-attach to. */
  lead_external_id: string | null;
  /** Draft kind ('reply' | 'dm' | ...); a DM is manual-send and never posted. */
  draft_kind?: string | null;
}

function makeFakeSql(opts: {
  approval: ApprovalJoinedRow | null;
  siblingIds: string[];
  /** When set, saving a dispatched reply receipt throws this message. */
  txError?: string | null;
  /** ids the bulk-skip `update … returning id` reports as flipped. */
  bulkSkipIds?: string[];
  apiWrite?: boolean;
  budgetError?: boolean;
  manualReceipt?: string;
}) {
  const calls: SqlCall[] = [];
  let claimed = false;

  const renderText = (strings: TemplateStringsArray, values: unknown[]) => {
    let text = "";
    for (let i = 0; i < strings.length; i++) {
      text += strings[i];
      if (i < values.length) text += `<<v${i}>>`;
    }
    return text;
  };

  function handle(text: string, _values: unknown[]): unknown[] {
    const lower = text.toLowerCase();
    const mutationRecord = (leadId?: string) => opts.approval
      ? { agent_instance_id: "vega-1", kind: opts.approval.draft_kind ?? "reply", receipt: null,
          sent_at: null, posted_at: null, ...opts.approval }
      : { id: `approval-${leadId}`, draft_id: `draft-${leadId}`, lead_id: leadId,
          agent_instance_id: "vega-1", kind: "reply", status: "pending", receipt: null, sent_at: null, posted_at: null };
    if (lower.includes("select distinct on (a.agent_instance_id,a.lead_id)"))
      return [...new Set(opts.bulkSkipIds ?? [])].map(mutationRecord);
    if (lower.includes("from noelle.agent_instances") && lower.includes("for no key update")) return [{ id: "vega-1" }];
    if (lower.trimStart().startsWith("select") && lower.includes("from noelle.approvals") &&
        (lower.includes(" as kind") || lower.includes("a.status,a.decided_by"))) {
      if (opts.approval) return [mutationRecord()];
      const id = String(_values[0] ?? "");
      const lead = [...new Set(opts.bulkSkipIds ?? [])].find(value => id === `approval-${value}`) ?? opts.bulkSkipIds?.[0];
      return lead ? [mutationRecord(lead)] : [];
    }
    if (lower.includes("update noelle.approvals a") && lower.includes("a.id=any(") && lower.includes("returning a.id"))
      return [{ id: opts.approval?.id ?? "bulk-approval" }];
    if (opts.txError && lower.includes("update noelle.drafts") && /set\s+sent_external_id/.test(lower)) throw new Error(opts.txError);
    if (lower.includes("select id from noelle.drafts where") && lower.includes("for update"))
      return opts.approval ? [{ id: opts.approval.draft_id }] : [];
    if (lower.includes("select now() as at")) return [{ at: new Date("2026-01-15T10:30:00Z") }];
    if (lower.includes("from noelle.drafts d join noelle.approvals") && lower.includes("for update"))
      return opts.approval ? [{ id: opts.approval.draft_id }] : [];
    if (lower.includes("insert into noelle.x_api_write_budget")) {
      if (opts.budgetError) throw new Error("budget reservation response lost");
      return [{ used: 1 }];
    }
    if (lower.includes("from noelle.x_api_tokens")) {
      return [{ auth_kind: "oauth1a", access_token: "fixture", refresh_token: null, access_token_expires_at: null,
        consumer_key: "fixture", consumer_secret: "fixture", access_token_secret: "fixture", x_handle: "fixture" }];
    }
    if (lower.includes("insert into noelle.x_reply_claims")) {
      if (claimed || !opts.approval) return [];
      claimed = true;
      return [{ approval_id: opts.approval.id }];
    }
    if (lower.includes("release_x_reply_claim")) {
      const released = claimed;
      claimed = false;
      return [{ released }];
    }
    // bulk-skip (whole-lead): `update … from drafts … lead_id in (select … any(…)) returning a.lead_id`
    if (
      lower.includes("update noelle.approvals") &&
      lower.includes("returning") &&
      lower.includes("lead_id") &&
      lower.includes("any(")
    ) {
      return (opts.bulkSkipIds ?? []).map((lead_id) => ({ lead_id }));
    }
    if (lower.includes("update noelle.approvals") && lower.includes("sibling-angle-sent")) {
      return opts.siblingIds.map((id) => ({ id }));
    }
    // A top-level approval SELECT — NOT an UPDATE (the whole-lead skip/bulk-skip
    // UPDATEs embed a `select … from noelle.approvals` subselect we must not match here).
    if (lower.trimStart().startsWith("select") && lower.includes("from noelle.approvals")) {
      return opts.approval ? [{ agent_instance_id: "vega-1", receipt: opts.manualReceipt ?? null, sent_at: null, posted_at: null, stored_sent_via: null, stored_sent_url: null, claimed: false, ...opts.approval }] : [];
    }
    // The /send draft-only gate: look up the org's x_intern (Vega). Return one
    // with the API-write flag OFF so the send falls through to the (mocked) bird
    // client, exactly as before the X-API routing was added.
    if (lower.includes("from noelle.agent_instances") && lower.includes("x_intern")) {
      return [{ id: "vega-1", x_api_write_enabled: opts.apiWrite === true }];
    }
    if (lower.includes("from noelle.org_members")) {
      return [{ user_id: "user-1" }];
    }
    return [];
  }

  type TxHandler = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ) => Promise<unknown[]>;

  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = renderText(strings, values);
    calls.push({ text, values });
    return Promise.resolve(handle(text, values));
  }) as unknown as {
    (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>;
    json(v: unknown): unknown;
    begin(fn: (tx: TxHandler & { json(v: unknown): unknown }) => Promise<void>): Promise<void>;
    unsafe(query: string, params: unknown[]): Promise<unknown[]>;
    __calls: SqlCall[];
  };

  sql.json = (v: unknown) => ({ __json: v });
  sql.unsafe = (query: string, params: unknown[]) => {
    calls.push({ text: query, values: params });
    const lower = query.toLowerCase();
    if (lower.includes("org_members")) {
      return Promise.resolve([{ user_id: "user-1" }]);
    }
    return Promise.resolve([]);
  };
  sql.begin = async (fn) => {
    const tx = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = renderText(strings, values);
      calls.push({ text, values });
      return Promise.resolve(handle(text, values));
    }) as TxHandler & { json(v: unknown): unknown };
    tx.json = (v: unknown) => ({ __json: v });
    (tx as unknown as {unsafe: typeof sql.unsafe}).unsafe = sql.unsafe;
    return await fn(tx);
  };
  sql.__calls = calls;

  return sql as never;
}

// ---------------------------------------------------------------------------
// Stub XClient: returns a canned tweet by default; the per-test setup can
// swap in an error-throwing variant to exercise the failure branches.
// ---------------------------------------------------------------------------

interface XClientStubOpts {
  reply?: (text: string, replyTo: string) => Promise<{ id: string; url: string }>;
  /** When set, every createTweet call throws this error. */
  throws?: Error;
}

function makeXClientStub(opts: XClientStubOpts = {}): XClient {
  const fail = opts.throws;
  return {
    async verifyCredentials() {
      return { screen_name: "stub", id_str: "stub" };
    },
    async userTweets() { return []; },
    async searchTimeline() { return []; },
    async createTweet({ inReplyToId, text }) {
      if (fail) throw fail;
      if (opts.reply) return opts.reply(text, inReplyToId);
      return {
        id: "tweet-fake",
        url: `https://x.com/stub/status/tweet-fake`,
      };
    },
    async likeTweet() {
      return true;
    },
  };
}

// Stub SecretsClient: every getForOrg call returns canned strings.
function makeSecretsStub(opts: {
  notFound?: boolean;
} = {}): SecretsClient {
  return {
    async get(name) {
      return `secret-${name}`;
    },
    async getForOrg(_orgId, fragment) {
      if (opts.notFound) {
        throw new SecretAccessError(`NOT_FOUND reading ${fragment}`);
      }
      return `${fragment}-value`;
    },
    async warm() { /* noop */ },
    bust() { /* noop */ },
  };
}

async function buildApp(setup: {
  sql: ReturnType<typeof makeFakeSql>;
  xClient?: XClient;
  secrets?: SecretsClient;
}) {
  const { drafts, __setSendDepsForTests, __resetSendDepsForTests } =
    await import("../routes/drafts.js");
  __resetSendDepsForTests();
  __setSendDepsForTests({
    secrets: setup.secrets ?? makeSecretsStub(),
    xClientFactory: () => setup.xClient ?? makeXClientStub(),
  });
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", {
      userId: "user-1",
      raw: { sub: "user-1" } as never,
    });
    await next();
  });
  app.route("/", drafts);
  __setDbClientForTests(setup.sql);
  return app;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetDbClientForTests();
});

describe("POST /api/drafts/:id/send", () => {
  it("posts to X synchronously and returns sent_url + sibling_skipped", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-A",
        org_id: "org-1",
        draft_id: "draft-A",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: "1234567890",
      },
      siblingIds: ["appr-B", "appr-C"],
    });
    const xClient = makeXClientStub({
      reply: async () => ({
        id: "9876543210",
        url: "https://x.com/me/status/9876543210",
      }),
    });
    const app = await buildApp({ sql: fakeSql, xClient });

    const res = await app.request("/api/drafts/appr-A/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hello world", edited: false }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      approval_id: string;
      status: string;
      sibling_skipped: number;
      sent_external_id: string;
      sent_url: string;
    };
    expect(json.approval_id).toBe("appr-A");
    expect(json.status).toBe("sent");
    expect(json.sibling_skipped).toBe(2);
    expect(json.sent_external_id).toBe("9876543210");
    expect(json.sent_url).toBe("https://x.com/me/status/9876543210");

    const hasSiblingFlip = (fakeSql as unknown as { __calls: SqlCall[] }).__calls.some(
      (c) => /sibling-angle-sent/.test(c.text),
    );
    expect(hasSiblingFlip).toBe(true);
    const hasSentExternalIdWrite = (fakeSql as unknown as { __calls: SqlCall[] }).__calls.some(
      (c) => /update noelle\.drafts/i.test(c.text) && /sent_external_id/i.test(c.text),
    );
    expect(hasSentExternalIdWrite).toBe(true);
  });

  it("marks a DM 'sent' WITHOUT posting to X or skipping reply siblings", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-dm",
        org_id: "org-1",
        draft_id: "draft-dm",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: "1234567890",
        draft_kind: "dm",
      },
      // Present on purpose: a DM send must NOT skip these reply siblings.
      siblingIds: ["appr-B", "appr-C"],
    });
    let tweeted = false;
    const xClient = makeXClientStub({
      reply: async () => {
        tweeted = true;
        return { id: "should-not-happen", url: "https://x.com/x/status/0" };
      },
    });
    const app = await buildApp({ sql: fakeSql, xClient });

    const res = await app.request("/api/drafts/appr-dm/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hellooo\n\nsaw your post", edited: false }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      status: string;
      sent_url?: string;
      sent_external_id?: string;
    };
    expect(json.status).toBe("sent");
    // The X reply API was never touched.
    expect(tweeted).toBe(false);
    // A DM carries no posted-tweet fields.
    expect(json.sent_url).toBeUndefined();
    expect(json.sent_external_id).toBeUndefined();
    // And it never ran the reply sibling-skip.
    const calls = (fakeSql as unknown as { __calls: SqlCall[] }).__calls;
    expect(calls.some((c) => /sibling-angle-sent/.test(c.text))).toBe(false);
    expect(calls.some((c) => /sent_external_id/i.test(c.text))).toBe(false);
  });

  it("returns 503 x_auth_failed when X cookies are stale", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-A",
        org_id: "org-1",
        draft_id: "draft-A",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: "1234567890",
      },
      siblingIds: [],
    });
    const xClient = makeXClientStub({ throws: new XAuthError() });
    const app = await buildApp({ sql: fakeSql, xClient });

    const res = await app.request("/api/drafts/appr-A/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("x_auth_failed");
  });

  it("returns 503 x_rate_limited when X says slow down", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-A",
        org_id: "org-1",
        draft_id: "draft-A",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: "1234567890",
      },
      siblingIds: [],
    });
    const xClient = makeXClientStub({ throws: new XRateLimitError() });
    const app = await buildApp({ sql: fakeSql, xClient });

    const res = await app.request("/api/drafts/appr-A/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(503);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("x_rate_limited");
  });

  it("returns 502 x_post_failed on permanent X error", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-A",
        org_id: "org-1",
        draft_id: "draft-A",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: "1234567890",
      },
      siblingIds: [],
    });
    const xClient = makeXClientStub({ throws: new XError("404 deleted", 404) });
    const app = await buildApp({ sql: fakeSql, xClient });

    const res = await app.request("/api/drafts/appr-A/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(502);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("x_post_failed");
  });

  it("returns 409 x_cookies_missing when Secret Manager NOT_FOUND", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-A",
        org_id: "org-1",
        draft_id: "draft-A",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: "1234567890",
      },
      siblingIds: [],
    });
    const secrets = makeSecretsStub({ notFound: true });
    const app = await buildApp({ sql: fakeSql, secrets });

    const res = await app.request("/api/drafts/appr-A/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("x_cookies_missing");
  });

  it("returns 422 missing_in_reply_to when lead has no external_id", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-A",
        org_id: "org-1",
        draft_id: "draft-A",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: null,
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-A/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(422);
  });

  it("returns sibling_skipped=0 when the lead has only one approval", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-solo",
        org_id: "org-1",
        draft_id: "draft-solo",
        lead_id: "lead-solo",
        status: "pending",
        decided_at: null,
        lead_external_id: "111",
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-solo/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sibling_skipped: number };
    expect(json.sibling_skipped).toBe(0);
  });

  it("returns 404 when the approval id is unknown", async () => {
    const fakeSql = makeFakeSql({
      approval: null,
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/unknown/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(404);
  });

  it("returns the existing sent_at when called against an already-sent approval", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-already",
        org_id: "org-1",
        draft_id: "draft-already",
        lead_id: "lead-already",
        status: "sent",
        decided_at: "2026-01-15T10:30:00.000Z",
        lead_external_id: "111",
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-already/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sent_at: string };
    expect(json.sent_at).toBe("2026-01-15T10:30:00.000Z");
  });

  it("returns 500 db_write_failed_after_post when DB writes throw after a successful X post", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-A",
        org_id: "org-1",
        draft_id: "draft-A",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: "1234567890",
      },
      siblingIds: [],
      txError: "connection reset",
    });
    const xClient = makeXClientStub({
      reply: async () => ({ id: "999", url: "https://x.com/me/status/999" }),
    });
    const app = await buildApp({ sql: fakeSql, xClient });

    const res = await app.request("/api/drafts/appr-A/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "hi", edited: false }),
    });
    expect(res.status).toBe(500);
    const json = (await res.json()) as {
      error: string;
      sent_external_id: string;
      sent_url: string;
    };
    expect(json.error).toBe("db_write_failed_after_post");
    expect(json.sent_external_id).toBe("999");
  });
});

describe("POST /api/drafts/:id/mark-sent", () => {
  it("flips to sent, writes a sentinel, skips siblings — and never posts to X", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-A",
        org_id: "org-1",
        draft_id: "draft-A",
        lead_id: "lead-1",
        status: "pending",
        decided_at: null,
        lead_external_id: "synthetic-nella-fit-123",
      },
      siblingIds: ["appr-B", "appr-C"],
    });
    // An X client that throws on any post — if the route called X, the
    // request would error. A 200 proves the manual path never touched X.
    const xClient = makeXClientStub({ throws: new XError("must not be called", 500) });
    const app = await buildApp({ sql: fakeSql, xClient });

    const res = await app.request("/api/drafts/appr-A/mark-sent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      approval_id: string;
      draft_id: string;
      status: string;
      sent_via: string;
      sibling_skipped: number;
    };
    expect(json.approval_id).toBe("appr-A");
    expect(json.status).toBe("sent");
    expect(json.sent_via).toBe("manual");
    expect(json.sibling_skipped).toBe(2);

    // makeFakeSql returns `as never`; reach the recorded calls via a cast.
    const calls = (fakeSql as unknown as { __calls: SqlCall[] }).__calls;

    // The send-worker-safety sentinel must be written into drafts.sent_external_id.
    const wroteSentinel = calls.some(
      (c) => /update noelle\.drafts/i.test(c.text) && /manual:/.test(c.text),
    );
    expect(wroteSentinel).toBe(true);

    // ...and guarded by `sent_external_id is null` so a concurrent /send that
    // already wrote a real tweet id is never clobbered with the sentinel.
    const guardedDraftWrite = calls.some(
      (c) =>
        /update noelle\.drafts/i.test(c.text) &&
        /sent_external_id is null/i.test(c.text),
    );
    expect(guardedDraftWrite).toBe(true);

    // The approval was flipped to sent (not via the sibling-skip update).
    const flippedSent = calls.some(
      (c) =>
        /update noelle\.approvals/i.test(c.text) &&
        /status\s*=\s*'sent'/i.test(c.text),
    );
    expect(flippedSent).toBe(true);
  });

  it("returns sibling_skipped=0 when the lead has a single angle", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-solo",
        org_id: "org-1",
        draft_id: "draft-solo",
        lead_id: "lead-solo",
        status: "pending",
        decided_at: null,
        lead_external_id: "111",
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-solo/mark-sent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sibling_skipped: number };
    expect(json.sibling_skipped).toBe(0);
  });

  it("is idempotent: echoes the existing sent_at for an already-sent approval", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-already",
        org_id: "org-1",
        draft_id: "draft-already",
        lead_id: "lead-already",
        status: "sent",
        decided_at: "2026-01-15T10:30:00.000Z",
        lead_external_id: "111",
      },
      siblingIds: [],
      manualReceipt: "manual:draft-already",
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-already/mark-sent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { sent_at: string; sent_via: string };
    expect(json.sent_at).toBe("2026-01-15T10:30:00.000Z");
    expect(json.sent_via).toBe("manual");
  });

  it("returns 409 already_actioned when the approval was skipped", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-skipped",
        org_id: "org-1",
        draft_id: "draft-skipped",
        lead_id: "lead-skipped",
        status: "skipped",
        decided_at: "2026-01-15T10:30:00.000Z",
        lead_external_id: "111",
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-skipped/mark-sent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    const json = (await res.json()) as { error: string };
    expect(json.error).toBe("already_actioned");
  });

  it("returns 404 when the approval id is unknown", async () => {
    const fakeSql = makeFakeSql({ approval: null, siblingIds: [] });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/unknown/mark-sent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/drafts/:id/save-edit", () => {
  it("persists edited_body (+ edited=true) without touching approval status", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-edit",
        org_id: "org-1",
        draft_id: "draft-edit",
        lead_id: "lead-edit",
        status: "pending",
        decided_at: null,
        lead_external_id: null,
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-edit/save-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "my edited reply" }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      approval_id: string;
      draft_id: string;
      saved: boolean;
    };
    expect(json.approval_id).toBe("appr-edit");
    expect(json.draft_id).toBe("draft-edit");
    expect(json.saved).toBe(true);

    const calls = (fakeSql as unknown as { __calls: SqlCall[] }).__calls;
    // It writes edited_body into the draft payload...
    const wroteEdit = calls.some(
      (c) =>
        /update noelle\.drafts/i.test(c.text) &&
        /edited_body/i.test(JSON.stringify(c.values)),
    );
    expect(wroteEdit).toBe(true);
    const editCall = calls.find((c) => /update noelle\.drafts/i.test(c.text));
    // A semantic verdict for the old body must never authorize the edited text.
    expect(editCall?.text).toContain("-'verifier_meta'");
    expect(editCall?.text).toContain("-'reply_recheck'");
    // ...and never flips the approval to sent/skipped (it's not a decision).
    const flippedStatus = calls.some(
      (c) =>
        /update noelle\.approvals/i.test(c.text) &&
        /status = '(sent|skipped|deferred)'/i.test(c.text),
    );
    expect(flippedStatus).toBe(false);
  });

  it("400s on an empty body", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-edit",
        org_id: "org-1",
        draft_id: "draft-edit",
        lead_id: "lead-edit",
        status: "pending",
        decided_at: null,
        lead_external_id: null,
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-edit/save-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "" }),
    });
    expect(res.status).toBe(400);
  });

  it("409s when the draft was already actioned (sent/skipped)", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-sent",
        org_id: "org-1",
        draft_id: "draft-sent",
        lead_id: "lead-sent",
        status: "sent",
        decided_at: "2026-01-15T10:30:00.000Z",
        lead_external_id: null,
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-sent/save-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "too late" }),
    });
    expect(res.status).toBe(409);
  });

  it("404s when the approval id is unknown", async () => {
    const fakeSql = makeFakeSql({ approval: null, siblingIds: [] });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/unknown/save-edit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "anything" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/drafts/:id/skip", () => {
  it("skips a standalone DM approval directly", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "dm-approval",
        org_id: "org-1",
        draft_id: "dm-draft",
        lead_id: "dm-lead",
        status: "pending",
        decided_at: null,
        lead_external_id: null,
        draft_kind: "dm",
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/dm-approval/skip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "not sending this DM" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({approval_id:"dm-approval",status:"skipped"});
  });
});

describe("POST /api/drafts/bulk-skip", () => {
  it("skips the selected leads' reply angles and returns the distinct lead count", async () => {
    // bulkSkipIds = the lead_ids the whole-lead UPDATE reports back (one per
    // skipped reply angle); the route dedupes to distinct leads. Two leads here,
    // with a repeat to prove the dedupe (3 angle-rows → 2 leads).
    const fakeSql = makeFakeSql({
      approval: null,
      siblingIds: [],
      bulkSkipIds: ["lead-A", "lead-A", "lead-B"],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/bulk-skip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        org_id: "00000000-0000-0000-0000-0000000000a1",
        approval_ids: [
          "00000000-0000-0000-0000-0000000000b1",
          "00000000-0000-0000-0000-0000000000b2",
        ],
      }),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { skipped_count: number };
    expect(json.skipped_count).toBe(2); // distinct leads, not the 3 angle-rows
  });

  it("400s on a malformed body (no approval_ids)", async () => {
    const fakeSql = makeFakeSql({ approval: null, siblingIds: [] });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/bulk-skip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ org_id: "00000000-0000-0000-0000-0000000000a1" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/drafts/:id/unskip", () => {
  it("returns a skipped approval to pending", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-skipped",
        org_id: "org-1",
        draft_id: "draft-x",
        lead_id: "lead-x",
        status: "skipped",
        decided_at: "2026-06-10T00:00:00.000Z",
        lead_external_id: null,
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-skipped/unskip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const json = (await res.json()) as { approval_id: string; status: string };
    expect(json.status).toBe("pending");

    const unskipUpdate = (fakeSql as unknown as { __calls: SqlCall[] }).__calls.find(
      (call) => /update noelle\.approvals a/i.test(call.text),
    );
    expect(unskipUpdate?.text).toMatch(/decided_by\s+is\s+distinct\s+from/i);
    expect(unskipUpdate?.text).toMatch(/a\.org_id\s*=/i);
    expect(unskipUpdate?.values).toContain("org-1");
  });

  it("does not restore a reply rejected by automatic review", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-auto-rejected",
        org_id: "org-1",
        draft_id: "draft-auto-rejected",
        lead_id: "lead-x",
        status: "skipped",
        decided_at: "2026-09-20T00:00:00.000Z",
        decided_by: "automatic-review",
        lead_external_id: null,
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-auto-rejected/unskip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "automatic_review_rejected" });
    const updateCalls = (fakeSql as unknown as { __calls: SqlCall[] }).__calls.filter((call) =>
      /update noelle\.approvals/i.test(call.text),
    );
    expect(updateCalls).toHaveLength(0);
  });

  it("still restores a manually skipped DM", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-dm-skipped",
        org_id: "org-1",
        draft_id: "draft-dm",
        lead_id: null,
        status: "skipped",
        decided_at: "2026-09-20T00:00:00.000Z",
        decided_by: "user-1",
        lead_external_id: null,
        draft_kind: "dm",
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-dm-skipped/unskip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "pending" });
  });

  it("409s when the approval was already sent (not reversible)", async () => {
    const fakeSql = makeFakeSql({
      approval: {
        id: "appr-sent",
        org_id: "org-1",
        draft_id: "draft-y",
        lead_id: "lead-y",
        status: "sent",
        decided_at: "2026-06-10T00:00:00.000Z",
        lead_external_id: null,
      },
      siblingIds: [],
    });
    const app = await buildApp({ sql: fakeSql });

    const res = await app.request("/api/drafts/appr-sent/unskip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
  });
});


describe("manual X reply reservations", () => {
  const approval = { id: "appr-A", org_id: "org-1", draft_id: "draft-A", lead_id: "lead-1",
    agent_instance_id: "owning-vega", status: "pending", decided_at: null, lead_external_id: "123" };
  const sendRequest = { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ body: "a useful reply", edited: false }) };

  it("dispatches only one of two concurrent Send requests", async () => {
    const sql = makeFakeSql({ approval, siblingIds: [] });
    let attempts = 0;
    const app = await buildApp({ sql, xClient: makeXClientStub({ reply: async () => {
      attempts++;
      await Promise.resolve();
      return { id: "456", url: "https://x.com/me/status/456" };
    } }) });
    const responses = await Promise.all([
      app.request("/api/drafts/appr-A/send", sendRequest),
      app.request("/api/drafts/appr-A/send", sendRequest),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(attempts).toBe(1);
  });

  it.each([new XWriteUncertainError("response lost"), new Error("socket reset")])(
    "retains an uncertain target reservation for %s", async (failure) => {
      const sql = makeFakeSql({ approval, siblingIds: [] });
      let attempts = 0;
      const app = await buildApp({ sql, xClient: makeXClientStub({ reply: async () => {
        attempts++;
        throw failure;
      } }) });
      const first = await app.request("/api/drafts/appr-A/send", sendRequest);
      expect(first.status).toBe(502);
      expect(await first.json()).toMatchObject({ error: "x_write_uncertain" });
      expect((await app.request("/api/drafts/appr-A/send", sendRequest)).status).toBe(409);
      expect(attempts).toBe(1);
    });

  it("keeps a confirmed target reserved when receipt persistence fails", async () => {
    const sql = makeFakeSql({ approval, siblingIds: [], txError: "database write failed" });
    let attempts = 0;
    const app = await buildApp({ sql, xClient: makeXClientStub({ reply: async () => {
      attempts++;
      return { id: "456", url: "https://x.com/me/status/456" };
    } }) });
    expect((await app.request("/api/drafts/appr-A/send", sendRequest)).status).toBe(500);
    expect((await app.request("/api/drafts/appr-A/send", sendRequest)).status).toBe(409);
    expect(attempts).toBe(1);
  });

  it("releases a definite rejection so the operator can retry", async () => {
    const sql = makeFakeSql({ approval, siblingIds: [] });
    let attempts = 0;
    const app = await buildApp({ sql, xClient: makeXClientStub({ reply: async () => {
      if (++attempts === 1) throw new XAuthError();
      return { id: "456", url: "https://x.com/me/status/456" };
    } }) });
    expect((await app.request("/api/drafts/appr-A/send", sendRequest)).status).toBe(503);
    expect((await app.request("/api/drafts/appr-A/send", sendRequest)).status).toBe(200);
    expect(attempts).toBe(2);
  });

  it("looks up credentials only for the approval's owning X instance", async () => {
    const sql = makeFakeSql({ approval, siblingIds: [] });
    const app = await buildApp({ sql });
    expect((await app.request("/api/drafts/appr-A/send", sendRequest)).status).toBe(200);
    const lookup = (sql as unknown as { __calls: SqlCall[] }).__calls.find((call) =>
      call.text.includes("select id, x_api_write_enabled"));
    expect(lookup?.text).toMatch(/where id =/);
    expect(lookup?.values).toContain("owning-vega");
  });
});


describe("manual official API write accounting", () => {
  const approval = { id: "appr-A", org_id: "org-1", draft_id: "draft-A", lead_id: "lead-1",
    status: "pending", decided_at: null, lead_external_id: "123" };
  const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "reply", edited: false }) };

  it("counts a human-authorized API write against the shared counter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { id: "456" } }), { status: 201 }));
    const sql = makeFakeSql({ approval, siblingIds: [], apiWrite: true });
    const app = await buildApp({ sql });
    expect((await app.request("/api/drafts/appr-A/send", request)).status).toBe(200);
    const reservation = (sql as unknown as { __calls: SqlCall[] }).__calls.find((call) => call.text.includes("insert into noelle.x_api_write_budget"));
    expect(reservation?.values).toContain(true);
    expect(reservation?.values).toContain("org-1");
  });

  it("refunds known rejection budget but keeps an ambiguous dispatched write charged", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    const rejectedSql = makeFakeSql({ approval, siblingIds: [], apiWrite: true });
    const rejectedApp = await buildApp({ sql: rejectedSql });
    expect((await rejectedApp.request("/api/drafts/appr-A/send", request)).status).toBe(503);
    expect((rejectedSql as unknown as { __calls: SqlCall[] }).__calls.some((call) => call.text.includes("update noelle.x_api_write_budget"))).toBe(true);
    fetch.mockRejectedValue(new Error("response lost"));
    const uncertainSql = makeFakeSql({ approval, siblingIds: [], apiWrite: true });
    const uncertainApp = await buildApp({ sql: uncertainSql });
    expect((await uncertainApp.request("/api/drafts/appr-A/send", request)).status).toBe(502);
    expect((uncertainSql as unknown as { __calls: SqlCall[] }).__calls.some((call) => call.text.includes("update noelle.x_api_write_budget"))).toBe(false);
  });

  it("releases the undispatched target but retains unknown budget after reservation response loss", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected network call"));
    const sql = makeFakeSql({ approval, siblingIds: [], apiWrite: true, budgetError: true });
    const app = await buildApp({ sql });
    const response = await app.request("/api/drafts/appr-A/send", request);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: "x_write_budget_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    const calls = (sql as unknown as { __calls: SqlCall[] }).__calls;
    expect(calls.some((call) => call.text.includes("release_x_reply_claim"))).toBe(true);
    expect(calls.some((call) => call.text.includes("update noelle.x_api_write_budget"))).toBe(false);
  });
});
