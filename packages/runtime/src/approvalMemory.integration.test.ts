import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { countSentDmsToAuthor, getRecentDmsToAuthor } from "./dmLadderDb.js";
import { getRepliedPostSources } from "./ideationSources.js";
import { relationshipEvidence } from "./relationshipDmEvidenceDb.js";

const url = process.env.NOELLE_APPROVAL_MEMORY_TEST_DATABASE_URL;
type BodyValue = string | null | number | boolean | { text: string } | string[];

describe.skipIf(!url)("approval memory consistency (PostgreSQL)", () => {
  let sql: Sql;
  let org: string, foreignOrg: string, instance: string, foreignInstance: string, sibling: string;
  let lead: string, foreignLead: string, otherLead: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 3, onnotice: () => {} });
    const [current] = await sql`select current_database() as db`;
    if (!String(current?.db).includes("approval_memory_test")) throw Error("dedicated approval memory test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0005_leads_full_schema.sql", "0018_x_watchlist_people.sql",
      "0020_x_watchlist_profiles.sql", "0023_persons_crm.sql", "0028_linkedin_watchlist_profiles.sql",
      "0044_linkedin_discovered_people.sql", "0090_x_discovered_people.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    [org, foreignOrg] = (await sql`insert into noelle.organizations(slug,name)
      values ('memory_a','A'),('memory_b','B') returning id`).map((r) => r.id);
    [instance, foreignInstance, sibling] = (await sql`insert into noelle.agent_instances(org_id,role)
      values (${org},'x_intern'),(${foreignOrg},'x_intern'),(${org},'linkedin_intern') returning id`).map((r) => r.id);
    lead = await addLead(org, instance, "target", "source post target");
    foreignLead = await addLead(foreignOrg, foreignInstance, "target", "source post foreign");
    otherLead = await addLead(org, instance, "other", "source post other");
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });

  async function addLead(orgId: string, agent: string | null, author: string, text: string) {
    const [row] = await sql`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,author_handle,payload)
      values (${orgId},${agent},${crypto.randomUUID()},'x',${author},${sql.json({ text })}) returning id`;
    return row!.id as string;
  }
  async function save(options: {
    draftOrg?: string; approvalOrg?: string; agent?: string; draftLead?: string; approvalLead?: string;
    body?: BodyValue; edited?: BodyValue; at?: string; kind?: "reply" | "dm"; status?: "sent" | "pending";
  } = {}) {
    const payload = { kind: options.kind ?? "reply", body: Object.hasOwn(options, "body") ? options.body : "accepted reply",
      ...(Object.hasOwn(options, "edited") ? { edited_body: options.edited } : {}) };
    const [draft] = await sql`insert into noelle.drafts(org_id,lead_id,payload)
      values (${options.draftOrg ?? org},${options.draftLead ?? lead},${sql.json(payload)}) returning id`;
    await sql`insert into noelle.approvals(org_id,agent_instance_id,draft_id,lead_id,status,decided_at,created_at)
      values (${options.approvalOrg ?? org},${options.agent ?? instance},${draft!.id},${options.approvalLead ?? lead},
        ${options.status ?? "sent"},${options.status === "pending" ? null : options.at ?? "2026-10-05T12:00:00Z"},
        ${options.at ?? "2026-10-05T12:00:00Z"})`;
  }
  async function memory(agent = instance, limit = 10) {
    return {
      count: await countSentDmsToAuthor(sql, { agentInstanceId: agent, authorHandle: "target" }),
      dms: await getRecentDmsToAuthor(sql, { agentInstanceId: agent, authorHandle: "target", limit }),
      replies: (await getRepliedPostSources(sql, { orgId: org, platform: "x", limit })).map((r) => [r.post, r.reply]),
      evidence: (await relationshipEvidence(sql, { orgId: org, platform: "x", authorHandle: "target", authorId: null }))
        .filter((r) => r.kind === "sent_reply").map((r) => r.text),
    };
  }
  const empty = { count: 0, dms: [], replies: [], evidence: [] };
  it("keeps coherent sent DM and public reply history", async () => {
    await save();
    await save({ kind: "dm", body: "accepted direct message" });
    expect(await memory()).toEqual({ count: 1, dms: ["accepted direct message"],
      replies: [["source post target", "accepted reply"]], evidence: ["accepted reply"] });
  });
  it.each(["foreign draft", "foreign lead", "mismatched lead", "foreign instance", "sibling mismatch"])(
    "excludes %s despite valid independent foreign keys", async (name) => {
      const overrides: Parameters<typeof save>[0] = {};
      if (name === "foreign draft") overrides.draftOrg = foreignOrg;
      if (name === "foreign lead") overrides.draftLead = overrides.approvalLead = foreignLead;
      if (name === "mismatched lead") overrides.draftLead = otherLead;
      if (name === "foreign instance") overrides.agent = foreignInstance;
      if (name === "sibling mismatch") await sql`update noelle.leads set agent_instance_id=${sibling} where id=${lead}`;
      await save(overrides);
      await save({ ...overrides, kind: "dm" });
      expect(await memory(name === "foreign instance" ? foreignInstance : instance)).toEqual(empty);
    });
  it("keeps org-wide sources from a coherent sibling instance but scopes DM memory", async () => {
    const siblingLead = await addLead(org, sibling, "target", "source post sibling");
    await save({ agent: sibling, draftLead: siblingLead, approvalLead: siblingLead });
    await save({ agent: sibling, draftLead: siblingLead, approvalLead: siblingLead, kind: "dm" });
    expect(await memory()).toEqual({ count: 0, dms: [],
      replies: [["source post sibling", "accepted reply"]], evidence: ["accepted reply"] });
  });
  it("keeps a legacy nullable lead instance within the same tenant", async () => {
    await sql`update noelle.leads set agent_instance_id=null where id=${lead}`;
    await save();
    await save({ kind: "dm" });
    expect((await memory()).count).toBe(1);
    expect((await memory()).replies).toEqual([["source post target", "accepted reply"]]);
  });
  it.each(["", null, " \t\n\r", "\u00a0\u2003\ufeff"])("cleared edit %j is authoritative", async (edited) => {
    await save({ edited });
    await save({ kind: "dm", edited });
    const observed = await memory();
    expect(observed.dms).toEqual([]);
    expect(observed.replies).toEqual([]);
    expect(observed.evidence).toEqual([]);
    expect(observed.count).toBe(1); // Sent state is separate from usable text.
  });
  it.each([42, true, { text: "invalid structured edit" }, ["invalid array edit"]])(
    "invalid edit type %j cannot revive or coerce text", async (edited) => {
      await save({ edited });
      await save({ kind: "dm", edited });
      const observed = await memory();
      expect(observed.dms).toEqual([]);
      expect(observed.replies).toEqual([]);
      expect(observed.evidence).toEqual([]);
    });
  it.each([42, true, { text: "invalid structured body" }, ["invalid array body"]])(
    "invalid original body type %j is not memory text", async (body) => {
      await save({ body });
      await save({ kind: "dm", body });
      const observed = await memory();
      expect(observed.dms).toEqual([]);
      expect(observed.replies).toEqual([]);
      expect(observed.evidence).toEqual([]);
    });
  it("filters blank edits and source posts before the query limit", async () => {
    await save({ body: "older accepted reply", at: "2026-10-04T12:00:00Z" });
    await save({ kind: "dm", body: "older accepted DM", at: "2026-10-04T12:00:00Z" });
    await save({ edited: "\u00a0\n" });
    await save({ kind: "dm", edited: "\u00a0\n" });
    const blankPost = await addLead(org, instance, "target", "\u00a0\n");
    await save({ draftLead: blankPost, approvalLead: blankPost, body: "missing source text" });
    const observed = await memory(instance, 1);
    expect(observed.dms).toEqual(["older accepted DM"]);
    expect(observed.replies).toEqual([["source post target", "older accepted reply"]]);
  });
  it("keeps a trimmed replacement and sent priority over newer pending DMs", async () => {
    await save({ edited: "  accepted human replacement  " });
    await save({ kind: "dm", body: "sent DM", at: "2026-10-04T12:00:00Z" });
    await save({ kind: "dm", body: "pending DM", status: "pending" });
    const observed = await memory(instance, 1);
    expect(observed.dms).toEqual(["sent DM"]);
    expect(observed.count).toBe(1);
    expect(observed.replies).toEqual([["source post target", "accepted human replacement"]]);
    expect(observed.evidence).toEqual(["accepted human replacement"]);
  });
  it("does not link aliases through a person from another tenant", async () => {
    const [person] = await sql`insert into noelle.persons(org_id,notes) values (${foreignOrg},'foreign note') returning id`;
    await sql`insert into noelle.person_social_accounts(org_id,person_id,platform,handle) values
      (${org},${person!.id},'x','target'),(${org},${person!.id},'linkedin','foreign-alias')`;
    await sql`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,author_handle,payload)
      values (${org},${instance},'alias','linkedin','foreign-alias',${sql.json({ text: "unrelated alias source text" })})`;
    expect((await relationshipEvidence(sql, { orgId: org, platform: "x", authorHandle: "target", authorId: null }))
      .some((r) => r.text.includes("unrelated alias"))).toBe(false);
  });
  it.each(["post", "profile", "discovered"])("excludes %s evidence with an instance from another tenant", async (kind) => {
    if (kind === "post") await sql`update noelle.leads set agent_instance_id=${foreignInstance},
      payload=${sql.json({ text: "foreign instance evidence" })} where id=${lead}`;
    if (kind === "profile") await sql`insert into noelle.x_watchlist_profiles(org_id,agent_instance_id,handle,summary)
      values (${org},${foreignInstance},'target','foreign instance evidence')`;
    if (kind === "discovered") await sql`insert into noelle.x_discovered_people(org_id,agent_instance_id,handle,bio)
      values (${org},${foreignInstance},'target','foreign instance evidence')`;
    expect((await relationshipEvidence(sql, { orgId: org, platform: "x", authorHandle: "target", authorId: null }))
      .some((r) => r.text.includes("foreign instance evidence"))).toBe(false);
  });
});
