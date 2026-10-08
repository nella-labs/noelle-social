import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getRecentRepliesToAuthor, getRecentReplyPhrasings, getVoiceExemplars } from "./priorReplies.js";

const url = process.env.NOELLE_PRIOR_REPLIES_TEST_DATABASE_URL;

describe.skipIf(!url)("reply memory isolation (PostgreSQL)", () => {
  let sql: Sql;
  let org: string, otherOrg: string, instance: string, otherInstance: string, siblingInstance: string;
  let redditInstance: string, otherRedditInstance: string;
  let lead: string, foreignLead: string, otherAuthorLead: string;

  beforeAll(async () => {
    sql = postgres(url!, { max: 3, onnotice: () => {} });
    const [current] = await sql`select current_database() as db`;
    if (!String(current?.db).includes("prior_replies_test")) throw Error("dedicated reply memory test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0005_leads_full_schema.sql"]) {
      const migration = new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url);
      await sql.unsafe(await readFile(migration, "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    const organizations = await sql`insert into noelle.organizations(slug,name) values ('reply_a','A'),('reply_b','B') returning id`;
    [org, otherOrg] = organizations.map((row) => row.id);
    const instances = await sql`insert into noelle.agent_instances(org_id,role) values
      (${org},'x_intern'),(${otherOrg},'x_intern'),(${org},'linkedin_intern'),
      (${org},'reddit_intern'),(${otherOrg},'reddit_intern') returning id`;
    [instance, otherInstance, siblingInstance, redditInstance, otherRedditInstance] = instances.map((row) => row.id);
    lead = await addLead(org, instance, "target", "post target");
    foreignLead = await addLead(otherOrg, otherInstance, "target", "post foreign");
    otherAuthorLead = await addLead(org, instance, "another", "post another");
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });

  async function addLead(orgId: string, instanceId: string | null, author: string, text: string, platform = "x") {
    const [saved] = await sql`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,author_handle,payload)
      values (${orgId},${instanceId},${crypto.randomUUID()},${platform},${author},${sql.json({ text })}) returning id`;
    return saved!.id as string;
  }

  async function save(overrides: {
    draftOrg?: string; approvalOrg?: string; agent?: string; draftLead?: string; approvalLead?: string;
    body?: string; edited?: string | null; status?: "sent" | "pending"; via?: string; kind?: string; at?: string;
    replyTarget?: { kind: string; author?: string | number | boolean | null | { handle: string } };
  } = {}) {
    const payload = {
      kind: overrides.kind ?? "reply", body: overrides.body ?? "valid reply", sent_via: overrides.via ?? "manual",
      ...(Object.hasOwn(overrides, "edited") ? { edited_body: overrides.edited } : {}),
      ...(overrides.replyTarget ? { reply_target: overrides.replyTarget } : {}),
    };
    const [draft] = await sql`insert into noelle.drafts(org_id,lead_id,payload)
      values (${overrides.draftOrg ?? org},${overrides.draftLead ?? lead},${sql.json(payload)}) returning id`;
    await sql`insert into noelle.approvals(org_id,agent_instance_id,draft_id,lead_id,status,decided_at,created_at)
      values (${overrides.approvalOrg ?? org},${overrides.agent ?? instance},${draft!.id},${overrides.approvalLead ?? lead},
        ${overrides.status ?? "sent"},${overrides.status === "pending" ? null : overrides.at ?? "2026-10-05T12:00:00Z"},
        ${overrides.at ?? "2026-10-05T12:00:00Z"})`;
  }

  async function memory(agentInstanceId = instance, limit = 10) {
    const args = { agentInstanceId, authorHandle: "target", limit };
    return {
      perAuthor: await getRecentRepliesToAuthor(sql, args),
      feed: await getRecentReplyPhrasings(sql, args),
      voice: await getVoiceExemplars(sql, { ...args, humanOnly: true }),
    };
  }
  const empty = { perAuthor: [], feed: [], voice: [] };

  const commentArgs = () => ({ agentInstanceId: redditInstance, authorHandle: "post_author", authorId: "post-author-id",
    replyTarget: { kind: "comment" as const, author: "comment_author" }, limit: 10 });
  async function commentLead(orgId = org, agent = redditInstance, platform = "reddit") {
    return addLead(orgId, agent, "post_author", "the original thread post", platform);
  }

  it("attributes Reddit comment history to its commenter instead of the original post author", async () => {
    const source = await commentLead();
    await save({ agent: redditInstance, draftLead: source, approvalLead: source, body: "comment reply",
      replyTarget: { kind: "comment", author: "comment_author" } });
    await save({ agent: redditInstance, draftLead: source, approvalLead: source, body: "post reply" });
    expect(await getRecentRepliesToAuthor(sql, commentArgs())).toEqual(["comment reply"]);
    expect(await getRecentRepliesToAuthor(sql, { agentInstanceId: redditInstance, authorHandle: "post_author", limit: 10 }))
      .toEqual(["post reply"]);
  });

  it("uses the existing bare-handle prefix normalization for comment recipients", async () => {
    const source = await commentLead();
    await save({ agent: redditInstance, draftLead: source, approvalLead: source, body: "normalized commenter reply",
      replyTarget: { kind: "comment", author: " /U/Comment_Author " } });
    expect(await getRecentRepliesToAuthor(sql, { ...commentArgs(), replyTarget: { kind: "comment", author: " u/Comment_Author " } }))
      .toEqual(["normalized commenter reply"]);
  });

  it("matches the same Reddit commenter across username capitalization", async () => {
    const source = await commentLead();
    await save({ agent: redditInstance, draftLead: source, approvalLead: source, body: "same commenter reply",
      replyTarget: { kind: "comment", author: " /U/CoMmEnT_AuThOr " } });
    expect(await getRecentRepliesToAuthor(sql, commentArgs())).toEqual(["same commenter reply"]);
  });

  it("excludes Reddit comment replies from post voice pairs before limiting", async () => {
    const source = await commentLead();
    await save({ agent: redditInstance, draftLead: source, approvalLead: source, body: "reply to the post",
      at: "2026-10-04T12:00:00Z", replyTarget: { kind: "post" } });
    await save({ agent: redditInstance, draftLead: source, approvalLead: source, body: "reply to a comment",
      replyTarget: { kind: "comment", author: "comment_author" } });
    expect(await getVoiceExemplars(sql, { agentInstanceId: redditInstance, limit: 1 }))
      .toEqual([{ post: "the original thread post", reply: "reply to the post" }]);
    expect(await getRecentRepliesToAuthor(sql, commentArgs())).toEqual(["reply to a comment"]);
  });

  it.each(["x", "linkedin"])("preserves %s post voice pairs when comment-target metadata is irrelevant", async (platform) => {
    const agent = platform === "x" ? instance : siblingInstance;
    const source = await addLead(org, agent, "target", "source post", platform);
    await save({ agent, draftLead: source, approvalLead: source, body: "post reply",
      replyTarget: { kind: "comment", author: "irrelevant" } });
    expect(await getVoiceExemplars(sql, { agentInstanceId: agent, limit: 1 }))
      .toEqual([{ post: "source post", reply: "post reply" }]);
  });

  it.each(["", "  ", null, 42, true, { handle: "comment_author" }])(
    "does not coerce malformed or blank saved commenter author %j into post history", async (author) => {
      const source = await commentLead();
      await save({ agent: redditInstance, draftLead: source, approvalLead: source,
        replyTarget: { kind: "comment", author } });
      expect(await getRecentRepliesToAuthor(sql, commentArgs())).toEqual([]);
      expect(await getRecentRepliesToAuthor(sql, { agentInstanceId: redditInstance, authorHandle: "post_author", limit: 10 }))
        .toEqual([]);
    });

  it.each(["foreign draft", "foreign approval", "foreign lead", "mismatched lead", "foreign instance"])(
    "excludes %s from commenter history under native independent foreign keys", async (name) => {
      const source = await commentLead();
      const foreign = await commentLead(otherOrg, otherRedditInstance);
      const unrelated = await commentLead();
      const overrides: Parameters<typeof save>[0] = { agent: redditInstance, draftLead: source, approvalLead: source,
        replyTarget: { kind: "comment", author: "comment_author" } };
      if (name === "foreign draft") overrides.draftOrg = otherOrg;
      if (name === "foreign approval") overrides.approvalOrg = otherOrg;
      if (name === "foreign lead") overrides.draftLead = overrides.approvalLead = foreign;
      if (name === "mismatched lead") overrides.draftLead = unrelated;
      if (name === "foreign instance") overrides.agent = otherRedditInstance;
      await save(overrides);
      expect(await getRecentRepliesToAuthor(sql, { ...commentArgs(),
        agentInstanceId: name === "foreign instance" ? otherRedditInstance : redditInstance })).toEqual([]);
    });

  it("does not apply a Reddit comment recipient to another platform", async () => {
    const source = await commentLead(org, redditInstance, "x");
    await save({ agent: redditInstance, draftLead: source, approvalLead: source,
      replyTarget: { kind: "comment", author: "comment_author" } });
    expect(await getRecentRepliesToAuthor(sql, commentArgs())).toEqual([]);
  });

  it("keeps sent priority, authoritative edits, source exclusion and limits for a commenter", async () => {
    const source = await commentLead();
    const options = { agent: redditInstance, draftLead: source, approvalLead: source,
      replyTarget: { kind: "comment", author: "comment_author" } };
    await save({ ...options, body: "old sent", edited: "  accepted edit  ", at: "2026-10-03T12:00:00Z" });
    await save({ ...options, body: "new pending", status: "pending" });
    await save({ ...options, body: "cleared reply", edited: "\u00a0\n" });
    expect(await getRecentRepliesToAuthor(sql, { ...commentArgs(), limit: 1 })).toEqual(["accepted edit"]);
    expect(await getRecentRepliesToAuthor(sql, { ...commentArgs(), excludeLeadId: source })).toEqual([]);
  });

  it("retains the correctly scoped reply and its source post", async () => {
    await save();
    expect(await memory()).toEqual({ perAuthor: ["valid reply"], feed: ["valid reply"], voice: [{ post: "post target", reply: "valid reply" }] });
  });

  it.each(["foreign draft", "foreign lead", "mismatched lead", "foreign instance", "sibling instance"])("excludes %s with valid independent foreign keys", async (name) => {
    if (name === "foreign draft") await save({ draftOrg: otherOrg, draftLead: foreignLead });
    if (name === "foreign lead") await save({ draftLead: foreignLead, approvalLead: foreignLead });
    if (name === "mismatched lead") await save({ draftLead: otherAuthorLead });
    if (name === "foreign instance") await save({ agent: otherInstance });
    if (name === "sibling instance") {
      await sql`update noelle.leads set agent_instance_id=${siblingInstance} where id=${lead}`;
      await save();
    }
    expect(await memory(name === "foreign instance" ? otherInstance : instance)).toEqual(empty);
  });

  it("retains a legacy nullable lead instance only within its consistent tenant", async () => {
    await sql`update noelle.leads set agent_instance_id=null where id=${lead}`;
    await save();
    expect((await memory()).perAuthor).toEqual(["valid reply"]);
    await sql`update noelle.leads set org_id=${otherOrg} where id=${lead}`;
    expect(await memory()).toEqual(empty);
  });

  it.each(["", null, " \t\n\r", "\u00a0\u2003\ufeff"])("treats cleared edit %j as authoritative", async (edited) => {
    await save({ body: "removed reply", edited });
    expect(await memory()).toEqual(empty);
  });

  it("uses the trimmed replacement edit", async () => {
    await save({ body: "old reply", edited: "  new reply  " });
    expect(await memory()).toEqual({ perAuthor: ["new reply"], feed: ["new reply"], voice: [{ post: "post target", reply: "new reply" }] });
  });

  it("filters cleared edits before limiting so they cannot starve older replies", async () => {
    await save({ body: "older reply", at: "2026-10-04T12:00:00Z" });
    await save({ edited: "\n\u00a0", at: "2026-10-05T12:00:00Z" });
    expect(await memory(instance, 1)).toEqual({ perAuthor: ["older reply"], feed: ["older reply"], voice: [{ post: "post target", reply: "older reply" }] });
  });

  it("filters empty source posts before the voice limit", async () => {
    await save({ body: "older reply", at: "2026-10-04T12:00:00Z" });
    const blankPost = await addLead(org, instance, "target", "\n\u00a0");
    await save({ draftLead: blankPost, approvalLead: blankPost, body: "no source" });
    expect(await getVoiceExemplars(sql, { agentInstanceId: instance, limit: 1 })).toEqual([{ post: "post target", reply: "older reply" }]);
  });

  it("preserves sent priority for a person and pure recency for the feed", async () => {
    await save({ body: "sent reply", at: "2026-10-04T12:00:00Z" });
    await save({ body: "pending reply", status: "pending", at: "2026-10-05T12:00:00Z" });
    expect((await memory(instance, 1)).perAuthor).toEqual(["sent reply"]);
    expect((await memory(instance, 1)).feed).toEqual(["pending reply"]);
    expect((await memory(instance, 1)).voice).toEqual([{ post: "post target", reply: "sent reply" }]);
  });

  it("preserves kind, human review, author, and excluded lead selection", async () => {
    await save({ body: "dm reply", kind: "dm" });
    await save({ body: "auto reply", via: "api" });
    await save({ body: "edited reply", via: "api", edited: "human edit" });
    await save({ draftLead: otherAuthorLead, approvalLead: otherAuthorLead, body: "another reply" });
    expect((await memory()).perAuthor).toEqual(expect.arrayContaining(["auto reply", "human edit"]));
    expect((await memory()).perAuthor).not.toContain("another reply");
    expect((await memory()).feed).not.toContain("dm reply");
    expect((await memory()).voice.map((row) => row.reply)).not.toContain("auto reply");
    expect((await memory()).voice.map((row) => row.reply)).toContain("human edit");
    expect(await getRecentRepliesToAuthor(sql, { agentInstanceId: instance, authorHandle: "target", excludeLeadId: lead, limit: 10 })).toEqual([]);
  });
});
