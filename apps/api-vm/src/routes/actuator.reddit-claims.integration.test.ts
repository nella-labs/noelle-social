import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { RedditReplyItemSchema, type RedditReplyItem } from "@noelle/contracts";
import { saveApprovalEdit, skipApproval, restoreSkippedApproval } from "@noelle/runtime";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { markApprovalSent, undoManualSent } from "../lib/manual-sent-db.js";
import {
  readRedditReplyUsage,
  reserveRedditBrowserReply,
} from "../lib/reddit-browser-reply-claims-db.js";
import { buildActionableReddit, type RedditJoinedRow } from "../lib/reddit-reply-policy.js";
import { actuator } from "./actuator.js";

const auth = vi.hoisted(() => ({ org: "11111111-1111-4111-8111-111111111111" }));
vi.mock("../middleware/actuator.js", () => ({
  requireActuatorToken: async (
    c: { set(key: string, value: unknown): void },
    next: () => Promise<void>,
  ) => {
    c.set("actuator", { orgId: auth.org });
    await next();
  },
}));
const org = "11111111-1111-4111-8111-111111111111";
const foreign = "22222222-2222-4222-8222-222222222222";
const url = process.env.NOELLE_REDDIT_REPLY_CLAIMS_TEST_DATABASE_URL;
const options = { blockExternalLinks: true, haltOnChallenge: true };
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe.skipIf(!url)("native permanent Reddit reply reservations", () => {
  let sql: ReturnType<typeof postgres>;
  let other: ReturnType<typeof postgres>;
  let instance: string;
  beforeAll(async () => {
    sql = postgres(url!, {
      max: 4,
      onnotice: () => {},
      connection: { application_name: "reddit-claim-native" },
    });
    const [db] = await sql<{ name: string }[]>`select current_database() as name`;
    if (db?.name !== "noelle_reddit_reply_claims_test") {
      await sql.end();
      throw new Error("Exact dedicated Reddit claims database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const file of [
      "0001_noelle_schema.sql",
      "0004_drafts_sent_at.sql",
      "0003_x_watchlist.sql",
      "0005_leads_full_schema.sql",
      "0015_auto_send.sql",
      "0026_auto_defer_dms.sql",
      "0018_x_watchlist_people.sql",
      "0081_reply_send_enabled.sql",
      "0084_reddit_activity.sql",
      "0107_linkedin_reply_claims.sql",
      "0108_x_browser_discovery.sql",
      "0125_reddit_reply_claims.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url),
          "utf8",
        ),
      );
    other = postgres(url!, {
      max: 2,
      onnotice: () => {},
      connection: { application_name: "reddit-claim-other" },
    });
  });
  beforeEach(async () => {
    __setDbClientForTests(sql);
    auth.org = org;
    vi.stubEnv("NOELLE_REDDIT_ACTUATOR_DAILY_WRITE_CAP", "8");
    vi.stubEnv("NOELLE_REDDIT_ACTUATOR_HALT_ON_CHALLENGE", "0");
    await sql`truncate noelle.reddit_activity,noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${org},'one','One'),(${foreign},'two','Two')`;
    const [parent] = await sql<
      { id: string }[]
    >`insert into noelle.agent_instances(org_id,role,status,reply_send_enabled)
      values (${org},'reddit_intern','active',true) returning id`;
    instance = parent!.id;
  });
  afterAll(async () => {
    resetDbClientForTests();
    vi.unstubAllEnvs();
    // Cached bounded owners dispose their separately-owned connections after idle.
    await sleep(1100);
    await other?.end();
    await sql?.end();
  });
  async function seed(
    postId = "abc123",
    body = "Café\r\n測定",
    comment = false,
    externalId = postId,
  ): Promise<RedditReplyItem> {
    const link = `https://www.reddit.com/r/SaaS/comments/${postId}/title/`;
    const leadPayload = { url: link, subreddit: "SaaS", source_text: "Captured factual source" };
    const draftPayload = {
      kind: "reply" as const,
      body,
      ...(comment
        ? {
            reply_target: {
              kind: "comment" as const,
              commentId: "def456",
              permalink: link + "def456/",
              author: "u/member",
            },
          }
        : {}),
    };
    const [lead] = await sql<
      { id: string }[]
    >`insert into noelle.leads(org_id,agent_instance_id,platform,external_id,author_handle,payload)
      values (${org},${instance},'reddit',${externalId},'builder',${sql.json(leadPayload)}) returning id`;
    const [draft] = await sql<{ id: string }[]>`insert into noelle.drafts(org_id,lead_id,payload)
      values (${org},${lead!.id},${sql.json(draftPayload)}) returning id`;
    const [approval] = await sql<
      { id: string }[]
    >`insert into noelle.approvals(org_id,agent_instance_id,lead_id,draft_id,status)
      values (${org},${instance},${lead!.id},${draft!.id},'pending') returning id`;
    const row: RedditJoinedRow = {
      approval_id: approval!.id,
      draft_id: draft!.id,
      lead_id: lead!.id,
      external_id: externalId,
      author_handle: "builder",
      lead_payload: leadPayload,
      draft_payload: draftPayload,
    };
    return RedditReplyItemSchema.parse(buildActionableReddit([row]).replies[0]);
  }
  async function claim(reply: RedditReplyItem) {
    return actuator.request("/api/reddit-reply-claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instance_id: instance, reply }),
    });
  }
  async function count() {
    return (
      await sql<{ n: number }[]>`select count(*)::int as n from noelle.reddit_reply_claims`
    )[0]!.n;
  }
  function scope(reply: RedditReplyItem) {
    return { orgId: org, approvalId: reply.approval_id, operatorId: "operator" };
  }
  function mark(reply: RedditReplyItem, sentVia: "manual" | "extension" = "extension") {
    return markApprovalSent(sql, {
      orgId: org,
      approvalId: reply.approval_id,
      decidedBy: "actuator",
      sentVia,
    });
  }
  function reify<T>(promise: PromiseLike<T>) {
    return Promise.resolve(promise).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }
  async function withHeldRow<T>(
    reply: RedditReplyItem,
    kind: "parent" | "draft" | "source",
    operation: () => Promise<T>,
    whileHeld: (pending: ReturnType<typeof reify<T>>) => Promise<void>,
    mutation: (tx: postgres.TransactionSql) => Promise<unknown> = async () => {},
  ): Promise<T> {
    let release!: () => void;
    let admitted!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const blocker = reify(
      other.begin(async (tx) => {
        if (kind === "parent")
          await tx`select id from noelle.agent_instances where id=${instance} for update`;
        else if (kind === "draft")
          await tx`select id from noelle.drafts where id=${reply.draft_id} for update`;
        else await tx`select id from noelle.leads where id=${reply.lead_id} for update`;
        admitted();
        await gate;
        await mutation(tx);
      }),
    );
    let pending: ReturnType<typeof reify<T>> | undefined;
    let failure: { error: unknown } | undefined;
    try {
      await Promise.race([
        ready,
        blocker.then((result) => {
          throw result.ok ? new Error("Lock transaction ended before admission") : result.error;
        }),
