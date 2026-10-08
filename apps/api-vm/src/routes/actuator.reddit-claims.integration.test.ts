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
      ]);
      pending = reify(Promise.resolve().then(operation));
      await whileHeld(pending);
    } catch (error) {
      failure = { error };
    } finally {
      release();
      await Promise.all([blocker, pending]);
    }
    if (failure) throw failure.error;
    const lockResult = await blocker;
    if (!lockResult.ok) throw lockResult.error;
    const result = await pending;
    if (!result) throw new Error("Operation was not admitted");
    if (!result.ok) throw result.error;
    return result.value;
  }
  async function locked(
    reply: RedditReplyItem,
    kind: "parent" | "draft" | "source",
    operation: () => Promise<unknown>,
    mutation: (tx: postgres.TransactionSql) => Promise<unknown>,
  ) {
    return withHeldRow(
      reply,
      kind,
      operation,
      async () => {
        const until = Date.now() + 700;
        let waits = 0;
        while (Date.now() < until && !waits) {
          const [row] = await other<{ n: number }[]>`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'`;
          waits = row!.n;
          if (!waits) await sleep(10);
        }
        expect(waits).toBeGreaterThan(0);
      },
      mutation,
    );
  }
  it("admits one exact captured Unicode reply and withholds its queued thread", async () => {
    const reply = await seed();
    expect((await claim(reply)).status).toBe(200);
    const response = await actuator.request(`/api/actionable-reddit?instanceId=${instance}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ replies: [] });
    expect(await count()).toBe(1);
  });
  it("allows the coherent selected comment without changing its thread grain", async () => {
    const reply = await seed("abc123", "Exact body", true);
    expect((await claim(reply)).status).toBe(200);
    expect((await claim(await seed("abc123", "Second angle", false, "t3_abc123"))).status).toBe(
      409,
    );
    expect(await count()).toBe(1);
  });
  it("does not admit a second thread after a claimed approval's source is rewritten", async () => {
    const reply = await seed();
    expect((await claim(reply)).status).toBe(200);
    const target = {
      ...reply.target,
      post_id: "other9",
      url: "https://www.reddit.com/r/SaaS/comments/other9/title/",
    };
    await sql`update noelle.leads set external_id='other9',payload=payload||${sql.json({ url: target.url })} where id=${reply.lead_id}`;
    expect((await claim({ ...reply, target })).status).toBe(409);
    expect(await count()).toBe(1);
  });
  it("admits the same thread independently for a second current organization", async () => {
    const first = await seed();
    expect((await claim(first)).status).toBe(200);
    const [parent] = await sql<
      { id: string }[]
    >`insert into noelle.agent_instances(org_id,role,status,reply_send_enabled)
      values (${foreign},'reddit_intern','active',true) returning id`;
    const second = await seed("abc123", "Second organization", false, "t3_abc123");
    await sql`update noelle.leads set org_id=${foreign},agent_instance_id=${parent!.id} where id=${second.lead_id}`;
    await sql`update noelle.drafts set org_id=${foreign} where id=${second.draft_id}`;
    await sql`update noelle.approvals set org_id=${foreign},agent_instance_id=${parent!.id} where id=${second.approval_id}`;
    auth.org = foreign;
    instance = parent!.id;
    expect((await claim(second)).status).toBe(200);
    expect(await count()).toBe(2);
  });
  it.each(["draft", "source"] as const)(
    "rechecks waited %s drift before claim admission",
    async (kind) => {
      const reply = await seed();
      const result = await locked(
        reply,
        kind,
        () => claim(reply),
        async (tx) => {
          if (kind === "draft")
            await tx`update noelle.drafts set payload=payload||'{"body":"Changed"}' where id=${reply.draft_id}`;
          else
            await tx`update noelle.leads set payload=payload||'{"url":"https://redd.it/other9"}' where id=${reply.lead_id}`;
        },
      );
      expect((result as Response).status).toBe(409);
      expect(await count()).toBe(0);
    },
  );
  it("allows one winner across independent SQL owners", async () => {
    const reply = await seed();
    const request = { instance_id: instance, reply };
    const results = await Promise.all([
      reserveRedditBrowserReply(sql, org, request, options),
      reserveRedditBrowserReply(other, org, request, options),
    ]);
    expect(results.sort()).toEqual(["already-claimed", "claimed"]);
    expect(await count()).toBe(1);
  });
  it.each([
    "body",
    "target",
    "human-review",
    "source",
    "source-org",
    "parent-org",
    "parent-role",
    "parent-status",
    "consent",
  ])("holds a changed %s before reservation", async (change) => {
    const reply = await seed();
    if (change === "body")
      await sql`update noelle.drafts set payload=payload||'{"edited_body":"Changed"}' where id=${reply.draft_id}`;
    else if (change === "target")
      await sql`update noelle.leads set external_id='other9' where id=${reply.lead_id}`;
    else if (change === "human-review")
      await sql`update noelle.drafts set payload=payload||'{"human_review_required":true}' where id=${reply.draft_id}`;
    else if (change === "source")
      await sql`update noelle.leads set payload=payload||'{"url":"https://redd.it/other9"}' where id=${reply.lead_id}`;
    else if (change === "source-org")
      await sql`update noelle.leads set org_id=${foreign} where id=${reply.lead_id}`;
    else if (change === "parent-org")
      await sql`update noelle.agent_instances set org_id=${foreign} where id=${instance}`;
    else if (change === "parent-role")
      await sql`update noelle.agent_instances set role='x_intern' where id=${instance}`;
    else if (change === "parent-status")
      await sql`update noelle.agent_instances set status='paused' where id=${instance}`;
    else
      await sql`update noelle.agent_instances set reply_send_enabled=false,auto_send_enabled=false where id=${instance}`;
    expect((await claim(reply)).status).toBe(409);
    expect(await count()).toBe(0);
  });
  it("denies a foreign authenticated organization", async () => {
    const reply = await seed();
    auth.org = foreign;
    expect((await claim(reply)).status).toBe(409);
    expect(await count()).toBe(0);
  });
  it("preserves explicit link and recent challenge policies", async () => {
    expect((await claim(await seed("abc123", "https://example.test"))).status).toBe(409);
    vi.stubEnv("NOELLE_REDDIT_ACTUATOR_HALT_ON_CHALLENGE", "1");
    const reply = await seed("other9");
    await sql`insert into noelle.reddit_activity(organization_id,session_id,type,reason) values (${org},gen_random_uuid(),'skip','challenge')`;
    expect((await claim(reply)).status).toBe(409);
    expect(await count()).toBe(0);
  });
  it("counts admitted attempts without double-counting their successful activity", async () => {
    const first = await seed();
    expect((await claim(first)).status).toBe(200);
    await sql`insert into noelle.reddit_activity(organization_id,session_id,type,approval_id,post_id)
      values (${org},gen_random_uuid(),'reply',${first.approval_id},'abc123')`;
    expect(await readRedditReplyUsage(sql, org)).toBe(1);
    await sql`update noelle.reddit_reply_claims set claimed_at=now()-interval '1 day'`;
    expect(await readRedditReplyUsage(sql, org)).toBe(1);
    vi.stubEnv("NOELLE_REDDIT_ACTUATOR_DAILY_WRITE_CAP", "1");
    expect((await claim(await seed("other9"))).status).toBe(409);
  });
  it.each(["0", "off"])("preserves the explicit daily cap %s", async (cap) => {
    vi.stubEnv("NOELLE_REDDIT_ACTUATOR_DAILY_WRITE_CAP", cap);
    expect((await claim(await seed())).status).toBe(cap === "0" ? 409 : 200);
  });
  it.each(["edit", "skip", "restore"])(
    "blocks the canonical %s mutation after a claim",
    async (action) => {
      const reply = await seed();
      expect((await claim(reply)).status).toBe(200);
      if (action === "restore")
        await sql`update noelle.approvals set status='skipped' where id=${reply.approval_id}`;
      const operation =
        action === "edit"
          ? saveApprovalEdit(sql, scope(reply), "Changed")
          : action === "skip"
            ? skipApproval(sql, scope(reply))
            : restoreSkippedApproval(sql, scope(reply));
      await expect(operation).rejects.toMatchObject({ category: "send_already_claimed" });
    },
  );
  it("preserves the browser skip endpoint's pending-only contract", async () => {
    const reply = await seed();
    await sql`update noelle.approvals set status='errored' where id=${reply.approval_id}`;
    const response = await actuator.request(`/api/actuator/mark-skipped/${reply.approval_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "removed" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ skipped: false });
    expect(
      (await sql`select status from noelle.approvals where id=${reply.approval_id}`)[0]!.status,
    ).toBe("errored");
  });
  async function companionAngles(reply: RedditReplyItem) {
    const rows: { id: string; status: string }[] = [];
    for (const status of ["pending", "deferred", "errored"]) {
      const [draft] = await sql<{ id: string }[]>`insert into noelle.drafts(org_id,lead_id,payload)
        select org_id,lead_id,payload from noelle.drafts where id=${reply.draft_id} returning id`;
      const [approval] = await sql<
        { id: string }[]
      >`insert into noelle.approvals(org_id,agent_instance_id,lead_id,draft_id,status)
        values (${org},${instance},${reply.lead_id},${draft!.id},${status}) returning id`;
      rows.push({ id: approval!.id, status });
    }
    return rows;
  }
  it.each(["reddit", "x", "linkedin"])(
    "skips only the selected pending %s approval through the browser endpoint",
    async (platform) => {
      const reply = await seed();
      await sql`update noelle.agent_instances set role=${platform + "_intern"} where id=${instance}`;
      await sql`update noelle.leads set platform=${platform} where id=${reply.lead_id}`;
      const companions = await companionAngles(reply);
      const response = await actuator.request(`/api/actuator/mark-skipped/${reply.approval_id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "removed" }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ skipped: true });
      expect(
        (await sql`select status from noelle.approvals where id=${reply.approval_id}`)[0]!.status,
      ).toBe("skipped");
      for (const companion of companions)
        expect(
          (await sql`select status from noelle.approvals where id=${companion.id}`)[0]!.status,
        ).toBe(companion.status);
    },
  );
  it("preserves grouped operator skip across pending, deferred and errored angles", async () => {
    const reply = await seed();
    const companions = await companionAngles(reply);
    expect(await skipApproval(sql, scope(reply))).toMatchObject({ count: 4 });
    for (const id of [reply.approval_id, ...companions.map((row) => row.id)])
      expect((await sql`select status from noelle.approvals where id=${id}`)[0]!.status).toBe(
        "skipped",
      );
  });
  it("blocks the actual browser skip entry after reservation", async () => {
    const reply = await seed();
    expect((await claim(reply)).status).toBe(200);
    const response = await actuator.request(`/api/actuator/mark-skipped/${reply.approval_id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "removed" }),
    });
    expect(response.status).toBe(409);
    expect(
      (await sql`select status from noelle.approvals where id=${reply.approval_id}`)[0]!.status,
    ).toBe("pending");
  });
  it("denies an extension receipt without a reservation and preserves explicit manual recording", async () => {
    const reply = await seed();
    expect(await mark(reply)).toMatchObject({ ok: false, error: "reddit_claim_required" });
    expect(await mark(reply, "manual")).toMatchObject({ ok: true });
  });
  it("preserves a claimed angle when a sibling is manually recorded", async () => {
    const reply = await seed();
    expect((await claim(reply)).status).toBe(200);
    const [draft] = await sql<{ id: string }[]>`insert into noelle.drafts(org_id,lead_id,payload)
      values (${org},${reply.lead_id},'{"kind":"reply","body":"Manual alternate angle"}') returning id`;
    const [approval] = await sql<
      { id: string }[]
    >`insert into noelle.approvals(org_id,agent_instance_id,lead_id,draft_id,status)
      values (${org},${instance},${reply.lead_id},${draft!.id},'pending') returning id`;
    expect(
      await markApprovalSent(sql, {
        orgId: org,
        approvalId: approval!.id,
        decidedBy: "operator",
        sentVia: "manual",
      }),
    ).toMatchObject({ ok: true });
    expect(
      (await sql`select status from noelle.approvals where id=${reply.approval_id}`)[0]!.status,
    ).toBe("pending");
    expect(await mark(reply)).toMatchObject({ ok: true });
  });
  it("keeps original digests and confirmation timestamps stable across receipt retries", async () => {
    const reply = await seed();
    expect((await claim(reply)).status).toBe(200);
    const [before] = await sql`select * from noelle.reddit_reply_claims`;
    expect(await mark(reply, "manual")).toMatchObject({ ok: false, error: "send_already_claimed" });
    const first = await mark(reply);
    expect(first).toMatchObject({ ok: true });
    const again = await mark(reply);
    expect(again).toEqual(first);
    const [after] = await sql`select * from noelle.reddit_reply_claims`;
    expect(after).toMatchObject({
      status: "sent",
      source_sha256: before!.source_sha256,
      draft_sha256: before!.draft_sha256,
      body_sha256: before!.body_sha256,
      target_sha256: before!.target_sha256,
    });
    expect(after!.receipt_draft_sha256).not.toBe(after!.draft_sha256);
    expect(await undoManualSent(sql, { orgId: org, approvalId: reply.approval_id })).toMatchObject({
      ok: false,
    });
  });
  it.each(["body", "source", "parent"])(
    "rejects waited %s drift before confirmation",
    async (kind) => {
      const reply = await seed();
      expect((await claim(reply)).status).toBe(200);
      const result = await locked(
        reply,
        kind === "body" ? "draft" : kind === "source" ? "source" : "parent",
        () => mark(reply),
        async (tx) => {
          if (kind === "body")
            await tx`update noelle.drafts set payload=payload||'{"body":"Changed"}' where id=${reply.draft_id}`;
          else if (kind === "source")
            await tx`update noelle.leads set payload=payload||'{"source_text":"Changed"}' where id=${reply.lead_id}`;
          else await tx`update noelle.agent_instances set org_id=${foreign} where id=${instance}`;
        },
      );
      expect(result).toMatchObject({ ok: false, error: "reddit_claim_changed" });
      expect(
        (await sql`select status from noelle.approvals where id=${reply.approval_id}`)[0]!.status,
      ).toBe("pending");
    },
  );
  it("rechecks a waited parent rebind before admission", async () => {
    const reply = await seed();
    const result = await locked(
      reply,
      "parent",
      () => claim(reply),
      async (tx) => {
        await tx`update noelle.agent_instances set org_id=${foreign} where id=${instance}`;
      },
    );
    expect((result as Response).status).toBe(409);
    expect(await count()).toBe(0);
  });
  it("times out a held parent without any late claim and recovers", async () => {
    const reply = await seed();
    const response = await withHeldRow(
      reply,
      "parent",
      () => claim(reply),
      async (pending) => {
        await pending;
      },
    );
    expect(response.status).toBe(503);
    await sleep(30);
    expect(await count()).toBe(0);
    expect((await claim(reply)).status).toBe(200);
  });
  it("bounds the entire held-parent queued batch with no late claims and recovery", async () => {
    vi.stubEnv("NOELLE_REDDIT_ACTUATOR_DAILY_WRITE_CAP", "off");
    const replies: RedditReplyItem[] = [];
    for (let i = 0; i < 36; i++) replies.push(await seed(`post${i}`));
    const results = await withHeldRow(
      replies[0]!,
      "parent",
      () => Promise.allSettled(replies.map((reply) => claim(reply))),
      async (pending) => {
        await pending;
      },
    );
    expect(
      results.every((result) => result.status === "fulfilled" && result.value.status === 503),
    ).toBe(true);
    expect(await count()).toBe(0);
    await sleep(100);
    expect(await count()).toBe(0);
    expect((await claim(replies[0]!)).status).toBe(200);
  }, 10000);
  it("admits a large unselected source while withholding an oversized selected frame", async () => {
    const reply = await seed();
    await sql`update noelle.leads set payload=payload||${sql.json({ unrelated: "x".repeat(200000) })}
      where id=${reply.lead_id}`;
    expect((await claim(reply)).status).toBe(200);
    const next = await seed("other9");
    await sql`update noelle.leads set author_handle=${"x".repeat(131073)} where id=${next.lead_id}`;
    expect((await claim(next)).status).toBe(409);
    expect(await count()).toBe(1);
  });
  it("does not grant DELETE of permanent claims to noelle_app", async () => {
    expect(
      (
        await sql<
          { allowed: boolean }[]
        >`select has_table_privilege('noelle_app','noelle.reddit_reply_claims','DELETE') as allowed`
      )[0]!.allowed,
    ).toBe(false);
  });
});
