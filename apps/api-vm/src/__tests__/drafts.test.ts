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
