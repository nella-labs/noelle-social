import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { discoveryReplyCapacity } from "./discovery-capacity.js";

const url = process.env.NOELLE_TEST_DATABASE_URL;
const orgId = "org-1";
const instanceId = "actor-1";

describe.skipIf(!url)("browser discovery capacity (Postgres)", () => {
  let sql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [row] = await sql<{ name: string }[]>`select current_database() as name`;
    if (!row?.name.includes("test")) throw new Error("Discovery capacity requires a test database");
  });
  beforeEach(async () => {
    await sql`begin`;
    // The local test DB may carry an old Noelle schema. DDL rolls back with the fixture.
    await sql`drop schema if exists noelle cascade`;
    await sql`create schema noelle`;
    await sql`create table noelle.leads (
      id text primary key, org_id text, agent_instance_id text, platform text,
      status text, payload jsonb not null
    )`;
    await sql`create table noelle.drafts (id text primary key, org_id text, lead_id text, payload jsonb not null)`;
    await sql`create table noelle.approvals (
      id text primary key, lead_id text, draft_id text, org_id text,
      agent_instance_id text, status text
    )`;
  });
  afterEach(async () => { await sql`rollback`; });
  afterAll(async () => { await sql?.end(); });

  async function addLead(id: string, source: string, status = "drafted", platform = "linkedin") {
    await sql`insert into noelle.leads (id, org_id, agent_instance_id, platform, status, payload)
      values (${id}, ${orgId}, ${instanceId}, ${platform}, ${status}, ${sql.json({ source })})`;
  }
  async function addApproval(
    id: string,
    kind: string,
    review: { pass: boolean; judgeOk?: boolean; scores: { voice: number } },
  ) {
    await sql`insert into noelle.drafts (id, org_id, lead_id, payload)
      values (${`draft-${id}`}, ${orgId}, ${id}, ${sql.json({ kind, verifier_meta: review })})`;
    await sql`insert into noelle.approvals (id, lead_id, draft_id, org_id, agent_instance_id, status)
      values (${`approval-${id}`}, ${id}, ${`draft-${id}`}, ${orgId}, ${instanceId}, 'pending')`;
  }

  it("fills slots from drafting and genuinely reviewed replies, not failed or DM approvals", async () => {
    const pass = { pass: true, judgeOk: true, scores: { voice: 0.8 } };
    await addLead("drafting", "extension_observed", "drafting");
    await addLead("ready", "extension_observed");
    await addApproval("ready", "reply", pass);
    await addLead("failed", "extension_observed");
    await addApproval("failed", "reply", { ...pass, pass: false });
    await addLead("fail-open", "extension_observed");
    await addApproval("fail-open", "reply", { pass: true, scores: { voice: 1 } });
    await addLead("low-voice", "extension_observed");
    await addApproval("low-voice", "reply", { ...pass, scores: { voice: 0.6 } });
    await addLead("dm-only", "extension_observed");
    await addApproval("dm-only", "dm", pass);
    await addLead("other-source", "apify");
    await addApproval("other-source", "reply", pass);

    expect(await discoveryReplyCapacity(sql, { orgId, instanceId, platform: "linkedin" }))
      .toEqual({ limit: 5, occupied: 2, available: 3 });
  });
});
