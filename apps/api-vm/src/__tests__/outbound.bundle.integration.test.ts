import type { Sql } from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { close, counts, foreignOrg, instance, org, payload, post, reset, seedLead, setup, url } from "./outbound.bundle-fixture.js";

describe.skipIf(!url)("outbound atomic tenant bundles (native PostgreSQL)", () => {
  let sql: Sql;
  beforeAll(async () => { sql = await setup(); });
  beforeEach(async () => { await reset(sql); });
  afterAll(async () => { await close(sql); });

  const reviewContext = { version: 1, platform: "x", postText: "Measured original source", knowledgeAnchors: ["Oriole maps Atlas"] };
  it("persists the exact factual snapshot and preserves it on an omitted legacy retry", async () => {
    const input = payload(); Object.assign(input.drafts[0]!, { reviewContext });
    expect((await post(input)).status).toBe(200);
    expect((await sql`select payload from noelle.drafts`)[0]?.payload).toMatchObject({ review_context: reviewContext });
    const retry = payload({ ...input, drafts: [{ ...input.drafts[0]! }] });
    delete (retry.drafts[0] as Record<string, unknown>).reviewContext;
    await sql`update noelle.approvals set status='sent',decided_by='operator'`;
    expect((await post(retry)).status).toBe(200);
    expect((await sql`select payload from noelle.drafts`)[0]?.payload).toMatchObject({ review_context: reviewContext });
    expect((await sql`select status from noelle.approvals`)[0]?.status).toBe("sent");
  });
  it("rolls back contradictory same-ID factual context and its lead enrichment", async () => {
    const input = payload(); Object.assign(input.drafts[0]!, { reviewContext });
    expect((await post(input)).status).toBe(200);
    const [lead] = await sql`select payload from noelle.leads`;
    const changed = structuredClone(input); changed.originalPostText = "Later source";
    Object.assign(changed.drafts[0]!, { reviewContext: { ...reviewContext, knowledgeAnchors: [] } });
    expect((await post(changed)).status).toBe(409);
    expect((await sql`select payload from noelle.leads`)[0]?.payload).toEqual(lead!.payload);
    expect((await sql`select payload from noelle.drafts`)[0]?.payload).toMatchObject({ review_context: reviewContext });
  });
  it("does not invent a factual snapshot for an already-stored legacy draft ID", async () => {
    const input = payload(); expect((await post(input)).status).toBe(200);
    Object.assign(input.drafts[0]!, { reviewContext });
    expect((await post(input)).status).toBe(409);
    expect((await sql`select payload from noelle.drafts`)[0]?.payload).not.toHaveProperty("review_context");
  });
  it("acknowledges concurrent exact snapshot retries without duplicate rows", async () => {
    const input = payload(); Object.assign(input.drafts[0]!, { reviewContext });
    const responses = await Promise.all(Array.from({ length: 4 }, () => post(input)));
    expect(responses.map(response => response.status)).toEqual([200, 200, 200, 200]);
    expect(await counts(sql)).toMatchObject({ leads: 1, drafts: 1, approvals: 1 });
    expect((await sql`select payload from noelle.drafts`)[0]?.payload).toMatchObject({ review_context: reviewContext });
  });

  it.each(["drafts", "approvals"])("rolls back the complete bundle when %s rejects", async table => {
    await sql.unsafe(`create or replace function noelle.fixture_reject() returns trigger language plpgsql as $$
      begin raise exception 'fixture stage rejection'; end $$`);
    await sql.unsafe(`create trigger fixture_reject before insert on noelle.${table}
      for each row execute function noelle.fixture_reject()`);
    expect((await post(payload())).status).toBe(500);
    expect(await counts(sql)).toMatchObject({ leads: 0, drafts: 0, approvals: 0 });
  });

  it.each(["foreign", "other-lead"])("rejects a draft ID bound to a %s parent without exposing its approval", async scope => {
    const lead = await seedLead(sql, scope === "foreign" ? foreignOrg : org, null);
    const input = payload(), id = input.drafts[0]!.id;
    const parentOrg = scope === "foreign" ? foreignOrg : org;
    await sql`insert into noelle.drafts(id,org_id,lead_id,payload) values (${id},${parentOrg},${lead},'{}')`;
    expect((await post(input)).status).toBe(409);
    expect(await counts(sql)).toMatchObject({ leads: 1, drafts: 1, approvals: 0 });
  });

  it.each(["org", "lead", "instance"])("rejects an existing approval with a contradictory %s reference", async field => {
    const input = payload(); expect((await post(input)).status).toBe(200);
    const anotherLead = await seedLead(sql, org, instance, "other-parent");
    const [another] = await sql`insert into noelle.agent_instances(org_id,role) values (${org},'linkedin_intern') returning id`;
    if (field === "org") await sql`update noelle.approvals set org_id=${foreignOrg}`;
    if (field === "lead") await sql`update noelle.approvals set lead_id=${anotherLead}`;
    if (field === "instance") await sql`update noelle.approvals set agent_instance_id=${another!.id}`;
    const response = await post(input);
    expect(response.status).toBe(409);
    expect(await response.json()).not.toHaveProperty("approval_id");
  });

  it.each(["body", "kind", "angle", "replyTarget"])("rejects changed immutable %s for a reused draft ID", async field => {
    const input = payload(); expect((await post(input)).status).toBe(200);
    const changed = structuredClone(input);
    Object.assign(changed.drafts[0]!, field === "body" ? { body: "different supplied body" }
      : field === "kind" ? { kind: "repost" } : field === "angle" ? { angle: "empathetic" }
        : { replyTarget: { kind: "comment", commentId: "other" } });
    expect((await post(changed)).status).toBe(409);
    const [draft] = await sql`select payload from noelle.drafts`;
    expect(draft!.payload.body).toBe(input.drafts[0]!.body);
  });

  it("rejects duplicate IDs within one bundle before creating any rows", async () => {
    const input = payload(); input.drafts.push({ ...input.drafts[0]!, body: "second body" });
    expect((await post(input)).status).toBe(400);
    expect(await counts(sql)).toMatchObject({ leads: 0, drafts: 0, approvals: 0 });
  });

  it("accepts a first uppercase UUID and its exact lowercase retry", async () => {
    const input = payload(); input.drafts[0]!.id = "AAAAAAAA-BBBB-4000-8DDD-EEEEEEEEEEEE";
    const first = await post(input); expect(first.status).toBe(200);
    const receipt = await first.json() as { approval_id: string };
    input.drafts[0]!.id = input.drafts[0]!.id.toLowerCase();
    const retry = await post(input); expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ approval_id: receipt.approval_id });
    expect(await counts(sql)).toMatchObject({ leads: 1, drafts: 1, approvals: 1 });
  });

  it("rejects case-equivalent duplicate UUIDs before SQL dispatch", async () => {
    const input = payload(); input.drafts[0]!.id = "AAAAAAAA-BBBB-4000-8DDD-EEEEEEEEEEEE";
    input.drafts.push({ ...input.drafts[0]!, id: input.drafts[0]!.id.toLowerCase() });
    const begin = vi.spyOn(sql, "begin");
    try { expect((await post(input)).status).toBe(400); expect(begin).not.toHaveBeenCalled(); }
    finally { begin.mockRestore(); }
    expect(await counts(sql)).toMatchObject({ leads: 0, drafts: 0, approvals: 0 });
  });

  it("refuses ambiguous legacy owner selection across active and paused tenants", async () => {
    await sql`insert into noelle.agent_instances(org_id,role,status) values (${foreignOrg},'x_intern','paused')`;
    const input = payload(); delete input.owner;
    expect((await post(input)).status).toBe(409);
    expect(await counts(sql)).toMatchObject({ leads: 0, drafts: 0, approvals: 0 });
  });

  it.each(["role", "org", "status"])("rechecks the committed current instance %s before writing", async field => {
    let request: Promise<Response> | undefined;
    await sql.begin(async tx => {
      if (field === "role") await tx`update noelle.agent_instances set role='linkedin_intern' where id=${instance}`;
      if (field === "org") await tx`update noelle.agent_instances set org_id=${foreignOrg} where id=${instance}`;
      if (field === "status") await tx`update noelle.agent_instances set status='archived' where id=${instance}`;
      request = post(payload());
      await Promise.race([request, new Promise(resolve => setTimeout(resolve, 100))]);
    });
    expect((await request!).status).toBe(500);
    expect(await counts(sql)).toMatchObject({ leads: 0, drafts: 0, approvals: 0 });
  });

  it("binds a legitimate legacy NULL lead owner without replacing source fields", async () => {
    await seedLead(sql, org, null, "source-post");
    await sql`update noelle.leads set payload='{"text":"source evidence","posted_at":"2026-10-01T12:34:56.000Z"}'`;
    expect((await post(payload())).status).toBe(200);
    const [lead] = await sql`select agent_instance_id,payload from noelle.leads`;
    expect(lead).toMatchObject({ agent_instance_id: instance, payload: { text: "source evidence", posted_at: "2026-10-01T12:34:56.000Z" } });
  });

  it("refuses a lead already bound to another same-org instance", async () => {
    const [other] = await sql`insert into noelle.agent_instances(org_id,role) values (${org},'linkedin_intern') returning id`;
    await seedLead(sql, org, other!.id, "source-post");
    expect((await post(payload())).status).toBe(409);
    expect(await counts(sql)).toMatchObject({ leads: 1, drafts: 0, approvals: 0 });
  });

  it.each(["sent", "skipped", "expired", "errored", "deferred"])("keeps an exact retry's %s approval decision intact", async status => {
    const input = payload(), first = await (await post(input)).json() as { approval_id: string };
    await sql`update noelle.approvals set status=${status},decided_by='operator',skip_reason='saved decision'`;
    const retry = await post(input); expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ approval_id: first.approval_id });
    const [approval] = await sql`select status,decided_by,skip_reason from noelle.approvals`;
    expect(approval).toMatchObject({ status, decided_by: "operator", skip_reason: "saved decision" });
    expect(await counts(sql)).toMatchObject({ leads: 1, drafts: 1, approvals: 1 });
  });

  it("uses the stored review when repairing a missing approval", async () => {
    const input = payload(); expect((await post(input)).status).toBe(200);
    await sql`delete from noelle.approvals`;
    await sql`update noelle.drafts set payload=jsonb_set(payload,'{verifier_meta,pass}','false')`;
    expect((await post(input)).status).toBe(200);
    const [approval] = await sql`select status,skip_reason from noelle.approvals`;
    expect(approval).toMatchObject({ status: "skipped", skip_reason: "automatic-review-failed" });
  });

  it("preserves operator-edited text and a sent decision when a stale body retries", async () => {
    const input = payload(); expect((await post(input)).status).toBe(200);
    await sql`update noelle.drafts set payload=jsonb_set(payload,'{body}','"operator-edited body"')`;
    await sql`update noelle.approvals set status='sent',decided_by='operator'`;
    expect((await post(input)).status).toBe(409);
    const [draft] = await sql`select payload from noelle.drafts`;
    const [approval] = await sql`select status,decided_by from noelle.approvals`;
    expect(draft!.payload.body).toBe("operator-edited body");
    expect(approval).toMatchObject({ status: "sent", decided_by: "operator" });
  });

  it("refuses to acknowledge a different operator request using the same draft ID", async () => {
    const input = payload({ replyRequestKey: "first-request" });
    expect((await post(input)).status).toBe(200);
    expect((await post({ ...input, replyRequestKey: "second-request" })).status).toBe(409);
  });

  it("rolls back an existing lead's payload enrichment after a later stage rejects", async () => {
    await seedLead(sql, org, instance, "source-post");
    await sql`update noelle.leads set payload='{"text":"saved evidence"}'`;
    await sql.unsafe(`create or replace function noelle.fixture_reject() returns trigger language plpgsql as $$
      begin raise exception 'fixture stage rejection'; end $$`);
    await sql`create trigger fixture_reject before insert on noelle.approvals
      for each row execute function noelle.fixture_reject()`;
    expect((await post(payload())).status).toBe(500);
    const [lead] = await sql`select payload from noelle.leads`;
    expect(lead!.payload).toEqual({ text: "saved evidence" });
    expect(await counts(sql)).toMatchObject({ leads: 1, drafts: 0, approvals: 0 });
  });

  it("allows a legacy owner only when exactly one paused instance is eligible", async () => {
    await sql`update noelle.agent_instances set status='paused'`;
    const input = payload(); delete input.owner;
    expect((await post(input)).status).toBe(200);
  });

  it("keeps a paused explicit owner eligible and an exact parallel retry idempotent", async () => {
    await sql`update noelle.agent_instances set status='paused'`;
    const input = payload();
    const responses = await Promise.all(Array.from({ length: 6 }, () => post(input)));
    expect(responses.map(r => r.status)).toEqual(Array(6).fill(200));
    const ids = await Promise.all(responses.map(async r => (await r.json() as { approval_id: string }).approval_id));
    expect(new Set(ids).size).toBe(1);
    expect(await counts(sql)).toMatchObject({ leads: 1, drafts: 1, approvals: 1 });
  });
});
