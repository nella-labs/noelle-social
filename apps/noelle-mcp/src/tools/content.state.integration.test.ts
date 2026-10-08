import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NoelleContext } from "../context.js";
import { contentModule } from "./content.js";

const url = process.env.NOELLE_CONTENT_POST_MCP_TEST_DATABASE_URL;
const orgId = "00000000-0000-4000-8000-000000000001";
const instanceId = "00000000-0000-4000-8000-000000000011";
describe.skipIf(!url)("content tool mutation authority (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>, ctx: NoelleContext;
  beforeAll(async () => {
    sql = postgres(url!, { max: 10, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    if (!db?.name.endsWith("_content_post_mcp_test")) {
      await sql.end(); throw new Error("Dedicated MCP content test database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql", "0045_post_ideas.sql", "0046_post_drafts.sql", "0047_drafter_notes.sql",
      "0050_ideation_requests.sql", "0056_content_edits_ledger.sql", "0059_content_crossplatform.sql", "0060_post_draft_fields.sql",
      "0061_ideation_polish.sql", "0072_ideation_request_target_platforms.sql", "0074_content_schedule_slots.sql",
      "0079_x_self_tracking.sql", "0100_post_generation_requests.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"));
    ctx = { sql, assertWritable: () => {}, resolveOrg: async () => ({ orgId, slug: "one", name: "One" }) } as unknown as NoelleContext;
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${orgId},'one','One')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,status) values (${instanceId},${orgId},'x_intern','active')`;
  });
  afterAll(async () => { await sql?.end(); });
  async function seed(status = "draft", ideaStatus = "drafted") {
    const [idea] = await sql`insert into noelle.post_ideas(org_id,agent_instance_id,platform,target_platforms,hook,status)
      values (${orgId},${instanceId},'x',array['x','linkedin'],'Concrete finding',${ideaStatus}) returning id`;
    const [draft] = await sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,final_body,status,stage)
      values (${orgId},${instanceId},${idea!.id},'linkedin','Original','Saved edit',${status},${status === 'published' ? 'posted' : 'draft'}) returning id`;
    return { ideaId: idea!.id as string, draftId: draft!.id as string };
  }
  const call = (name: string, args: Record<string, unknown>) => contentModule.handle(name, args, ctx);
  it.each(["noelle_mark_post_ready", "noelle_dismiss_post"])("keeps published records terminal for %s", async name => {
    const row = await seed("published");
    expect(await call(name, { draftId: row.draftId, id: row.draftId, target: "draft" })).toMatchObject({ isError: true });
    expect((await sql`select status,final_body from noelle.post_drafts where id=${row.draftId}`)[0])
      .toEqual({ status: "published", final_body: "Saved edit" });
  });
  it("preserves saved operator text when ready omits an edit", async () => {
    const row = await seed(); expect(await call("noelle_mark_post_ready", { draftId: row.draftId })).not.toMatchObject({ isError: true });
    expect((await sql`select status,final_body from noelle.post_drafts where id=${row.draftId}`)[0])
      .toEqual({ status: "ready", final_body: "Saved edit" });
  });
  it("refuses a draft on a contradictory current home role", async () => {
    const row = await seed(); await sql`update noelle.agent_instances set role='reddit_intern' where id=${instanceId}`;
    expect(await call("noelle_mark_post_ready", { draftId: row.draftId })).toMatchObject({ isError: true });
    expect((await sql`select status from noelle.post_drafts where id=${row.draftId}`)[0]?.status).toBe("draft");
  });
  it("returns the same durable generation identity to eight simultaneous identical requests", async () => {
    const row = await seed();
    const results = await Promise.all(Array.from({ length: 8 }, () => call("noelle_generate_post", { ideaId: row.ideaId, waitSeconds: 0 })));
    expect(results.every(result => !result?.isError)).toBe(true);
    const requests = await sql`select id,review_required,status from noelle.post_generation_requests`;
    expect(requests).toHaveLength(1); expect(requests[0]).toMatchObject({ review_required: true, status: "queued" });
    for (const result of results) expect(JSON.stringify(result)).toContain(requests[0]!.id);
  });
  it("rejects conflicting guidance while preserving the active request and its review gate", async () => {
    const row = await seed(); expect(await call("noelle_generate_post", { ideaId: row.ideaId, waitSeconds: 0 })).not.toMatchObject({ isError: true });
    expect(await call("noelle_generate_post", { ideaId: row.ideaId, waitSeconds: 0, guidance: "Different request" })).toMatchObject({ isError: true });
    expect(await sql`select id from noelle.post_generation_requests`).toHaveLength(1);
    expect(await sql`select id from noelle.drafter_notes`).toHaveLength(0);
  });
  it("does not queue generation for a published parent", async () => {
    const row = await seed("draft", "published");
    expect(await call("noelle_generate_post", { ideaId: row.ideaId, waitSeconds: 0 })).toMatchObject({ isError: true });
    expect(await sql`select id from noelle.post_generation_requests`).toHaveLength(0);
  });
  async function completedRequest(ideaId: string, reviewRequired = true) {
    const [request] =
      await sql`insert into noelle.post_generation_requests(org_id,agent_instance_id,idea_id,platforms,review_required,status)
      values (${orgId},${instanceId},${ideaId},array['x'],${reviewRequired},'drafted') returning id`;
    return request!.id as string;
  }
  it("does not claim review completion when the terminal journal has no correlated drafts", async () => {
    const row = await seed();
    const requestId = await completedRequest(row.ideaId);
    const result = await call("noelle_get_post", { ideaId: row.ideaId, requestId });
    expect(result?.content[0]?.text).toContain("Post generation drafts_missing");
    expect(result?.content[0]?.text).not.toContain("passed the existing reviewer/verifier");
  });
  it.each(["idea", "instance"])(
    "excludes a request draft with a contradictory %s binding",
    async (binding) => {
      const row = await seed();
      const requestId = await completedRequest(row.ideaId);
      let draftIdea = row.ideaId;
      let draftInstance = instanceId;
      if (binding === "idea") draftIdea = (await seed()).ideaId;
      else {
        const [instance] =
          await sql`insert into noelle.agent_instances(org_id,role,status) values (${orgId},'linkedin_intern','active') returning id`;
        draftInstance = instance!.id as string;
      }
      await sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,quality_passed,verifier_meta,generation_request_id)
      values (${orgId},${draftInstance},${draftIdea},'x','Detached request body',true,'{"pass":true}',${requestId})`;
      const result = await call("noelle_get_post", { ideaId: row.ideaId, requestId });
      expect(result?.content[0]?.text).not.toContain("Detached request body");
      expect(result?.content[0]?.text).toContain("Post generation drafts_missing");
    },
  );
  it("refuses a generation journal attached to another home instance", async () => {
    const row = await seed();
    const requestId = await completedRequest(row.ideaId);
    const [other] = await sql`insert into noelle.agent_instances(org_id,role,status)
      values (${orgId},'linkedin_intern','active') returning id`;
    await sql`update noelle.post_generation_requests set agent_instance_id=${other!.id} where id=${requestId}`;
    expect(await call("noelle_get_post", { ideaId: row.ideaId, requestId })).toMatchObject({
      isError: true,
    });
  });
  it("retains the actual reviewed home-instance draft result", async () => {
    const row = await seed();
    const requestId = await completedRequest(row.ideaId);
    await sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,quality_passed,verifier_meta,generation_request_id)
      values (${orgId},${instanceId},${row.ideaId},'x','Current request body',true,'{"pass":true}',${requestId})`;
    await sql`update noelle.post_generation_requests set platforms=array['x','linkedin'] where id=${requestId}`;
    await sql`update noelle.post_drafts set generation_request_id=${requestId},quality_passed=true,verifier_meta='{"pass":true}' where id=${row.draftId}`;
    const result = await call("noelle_get_post", { ideaId: row.ideaId, requestId });
    expect(result?.content[0]?.text).toContain("Post generation drafted");
    expect(result?.content[0]?.text).toContain("Current request body");
    expect(result?.content[0]?.text).toContain("Saved edit");
  });
  it.each([
    ["missing metadata pass", true, {}, "review_pending"],
    ["failed metadata", true, { pass: false }, "needs_review"],
    ["failed quality verdict", false, { pass: true }, "needs_review"],
  ])("reports stored %s without claiming a passed review", async (_label, qualityPassed, meta, status) => {
    const row = await seed();
    const requestId = await completedRequest(row.ideaId);
    await sql`update noelle.post_drafts set platform='x',generation_request_id=${requestId},
      quality_passed=${qualityPassed as boolean},verifier_meta=${sql.json(meta as never)}
      where id=${row.draftId}`;
    const result = await call("noelle_get_post", { ideaId: row.ideaId, requestId });
    const output = result?.content[0]?.text;
    expect(output).toContain(`Post generation ${status}`);
    expect(output).not.toContain("passed the existing reviewer/verifier");
    expect(output).not.toContain("reviewer_result:** passed");
  });
  it("stores only a suggested day and reports that no publication slot was created", async () => {
    const row = await seed();
    const result = await call("noelle_schedule_post", { ideaId: row.ideaId, day: "2026-10-09" });
    expect(result?.isError).not.toBe(true);
    expect(
      (
        await sql`select suggested_day::text as day,status from noelle.post_ideas where id=${row.ideaId}`
      )[0],
    ).toEqual({ day: "2026-10-09", status: "drafted" });
    expect(await sql`select id from noelle.content_schedule_slots`).toHaveLength(0);
    expect(result?.content[0]?.text).toContain("suggested publish day");
    expect(result?.content[0]?.text).toContain("No publication slot was created");
  });
});
