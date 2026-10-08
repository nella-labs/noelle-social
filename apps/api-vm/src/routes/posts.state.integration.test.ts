import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTENT_PUBLISH_UNCERTAIN_ERROR } from "@noelle/contracts";
import { openPostsStateFixture, postsForeignInstance, postsForeignOrg, postsInstance } from "./posts.state-fixture.js";

const membership = vi.hoisted(() => ({ allowed: true, check: undefined as (() => Promise<void>) | undefined }));
vi.mock("../lib/auth.js", async importOriginal => ({
  ...await importOriginal<typeof import("../lib/auth.js")>(),
  isOrgMember: async () => { await membership.check?.(); return membership.allowed; },
}));
const url = process.env.NOELLE_CONTENT_POSTS_STATE_TEST_DATABASE_URL;
describe.skipIf(!url)("original post state mutations (dedicated PostgreSQL)", () => {
  let f: Awaited<ReturnType<typeof openPostsStateFixture>>;
  beforeAll(async () => { f = await openPostsStateFixture(url!); });
  beforeEach(async () => { membership.allowed = true; membership.check = undefined; await f.reset(); });
  afterAll(async () => { await f?.close(); });
  const state = (id: string) => f.sql`select status,stage,final_body,hook,cta from noelle.post_drafts where id=${id}`;

  it.each(["mark-ready", "patch", "dismiss"])("preserves a published draft on %s", async action => {
    const row = await f.seed("published");
    const body = action === "patch" ? { stage: "draft", body: "Changed" } : action === "dismiss" ? { target: "draft" } : {};
    expect((await f.request(row.draftId, action, body)).status).toBe(409);
    expect((await state(row.draftId))[0]).toMatchObject({ status: "published", stage: "posted", final_body: "Saved operator edit" });
  });
  it("preserves a saved edit when Mark ready omits an edited body", async () => {
    const row = await f.seed(); expect((await f.request(row.draftId, "mark-ready")).status).toBe(200);
    expect((await state(row.draftId))[0]).toMatchObject({ status: "ready", final_body: "Saved operator edit" });
  });
  it("allows a home-instance cross-platform variant to become ready", async () => {
    const row = await f.seed("draft", "linkedin");
    expect((await f.request(row.draftId, "mark-ready", { editedBody: "Reviewed variant" })).status).toBe(200);
    expect((await state(row.draftId))[0]?.final_body).toBe("Reviewed variant");
  });
  it("keeps manual Mark posted an explicit idempotent acknowledgment", async () => {
    const row = await f.seed(); const body = { postedUrl: "https://x.com/operator/status/123" };
    expect((await f.request(row.draftId, "mark-posted", body)).status).toBe(200);
    expect((await f.request(row.draftId, "mark-posted", body)).status).toBe(200);
    expect((await state(row.draftId))[0]).toMatchObject({ status: "published", stage: "posted" });
  });
  it("retains disjoint field edits from simultaneous PATCH requests", async () => {
    const row = await f.seed(); let arrive = 0; let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    membership.check = async () => { if (++arrive === 2) release(); await ready; };
    const replies = await Promise.all([f.request(row.draftId, "patch", { hook: "New hook" }), f.request(row.draftId, "patch", { cta: "New CTA" })]);
    expect(replies.map(r => r.status)).toEqual([200,200]);
    expect((await state(row.draftId))[0]).toMatchObject({ hook: "New hook", cta: "New CTA" });
  });
  it.each(["published", "receipt", "publishing", "uncertain"])("rechecks committed %s after authorization", async changed => {
    const row = await f.seed(); membership.check = async () => {
      membership.check = undefined;
      if (changed === "published") await f.sql`update noelle.post_drafts set status='published',stage='posted' where id=${row.draftId}`;
      else if (changed === "receipt") await f.sql`update noelle.post_drafts set posted_url='https://x.com/operator/status/123' where id=${row.draftId}`;
      else await f.slot(row, changed === "publishing" ? "publishing" : "failed", changed === "uncertain" ? CONTENT_PUBLISH_UNCERTAIN_ERROR : null);
    };
    expect((await f.request(row.draftId, "patch", { body: "Stale edit" })).status).toBe(409);
    expect((await state(row.draftId))[0]?.final_body).toBe("Saved operator edit");
  });
  it.each(["instance-org", "instance-role", "idea-org", "draft-org", "draft-instance"])("rejects committed %s incoherence", async changed => {
    const row = await f.seed(); membership.check = async () => {
      membership.check = undefined;
      if (changed === "instance-org") { await f.sql`update noelle.agent_instances set role='linkedin_intern' where id=${postsForeignInstance}`;
        await f.sql`update noelle.agent_instances set org_id=${postsForeignOrg} where id=${postsInstance}`; }
      if (changed === "instance-role") await f.sql`update noelle.agent_instances set role='linkedin_intern' where id=${postsInstance}`;
      if (changed === "idea-org") await f.sql`update noelle.post_ideas set org_id=${postsForeignOrg} where id=${row.ideaId}`;
      if (changed === "draft-org") await f.sql`update noelle.post_drafts set org_id=${postsForeignOrg} where id=${row.draftId}`;
      if (changed === "draft-instance") await f.sql`update noelle.post_drafts set agent_instance_id=${postsForeignInstance} where id=${row.draftId}`;
    };
    expect((await f.request(row.draftId, "mark-ready")).status).toBe(409);
    expect((await state(row.draftId))[0]?.status).toBe("draft");
  });
  it("does not revive a dismissed draft by editing an unrelated field", async () => {
    const row = await f.seed("dismissed"); expect((await f.request(row.draftId, "patch", { notes: "A note" })).status).toBe(409);
    expect((await state(row.draftId))[0]?.status).toBe("dismissed");
  });
  it("keeps archived versions while dismissing an unpublished platform set", async () => {
    const row = await f.seed();
    const [archived] = await f.sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,status)
      select org_id,agent_instance_id,idea_id,platform,'Archived','published' from noelle.post_drafts where id=${row.draftId} returning id`;
    expect((await f.request(row.draftId, "dismiss", { target: "draft", scope: "set" })).status).toBe(200);
    expect((await state(row.draftId))[0]?.status).toBe("dismissed");
    expect((await state(archived!.id))[0]?.status).toBe("published");
  });
  it("does not hide a quarantined sibling behind a whole-set dismissal", async () => {
    const row = await f.seed();
    const [sibling] = await f.sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,status)
      select org_id,agent_instance_id,idea_id,platform,'Unresolved write','ready' from noelle.post_drafts where id=${row.draftId} returning id`;
    await f.slot({ ideaId: row.ideaId, draftId: sibling!.id as string }, "failed", CONTENT_PUBLISH_UNCERTAIN_ERROR);
    expect((await f.request(row.draftId, "dismiss", { target: "draft", scope: "set" })).status).toBe(409);
    expect((await state(row.draftId))[0]?.status).toBe("draft");
    expect((await state(sibling!.id))[0]?.status).toBe("ready");
  });
  it("enqueues one replacement across eight concurrent calls", async () => {
    const row = await f.seed(); const replies = await Promise.all(Array.from({ length: 8 }, () => f.request(row.ideaId, "replace")));
    expect(replies.filter(r => r.status === 200)).toHaveLength(1);
    expect(replies.filter(r => r.status === 409)).toHaveLength(7);
    expect(await f.sql`select id from noelle.ideation_requests`).toHaveLength(1);
  });
  it("enqueues one active polish request and permits a new request after completion", async () => {
    const row = await f.seed(); await f.sql`update noelle.agent_instances set role='linkedin_intern' where id=${postsInstance}`;
    await f.sql`update noelle.post_ideas set platform='linkedin' where id=${row.ideaId}`;
    const replies = await Promise.all(Array.from({ length: 8 }, () => f.request(row.ideaId, "polish")));
    expect(replies.filter(r => r.status === 200)).toHaveLength(1);
    expect(await f.sql`select id from noelle.ideation_requests where status='pending'`).toHaveLength(1);
    await f.sql`update noelle.ideation_requests set status='done'`;
    expect((await f.request(row.ideaId, "polish")).status).toBe(200);
  });
  it.each(["generate", "chat", "polish", "replace"])("never queues %s for a published idea", async action => {
    const row = await f.seed("draft", "x", "published");
    expect((await f.request(row.ideaId, action, action === "chat" ? { message: "Rewrite" } : { guidance: "Rewrite" })).status).toBe(409);
    expect(await f.sql`select id from noelle.ideation_requests`).toHaveLength(0);
    expect(await f.sql`select id from noelle.drafter_notes`).toHaveLength(0);
  });
  it("does not requeue a claimed generation or store falsely accepted guidance", async () => {
    const row = await f.seed("draft", "x", "drafting");
    expect((await f.request(row.ideaId, "generate", { guidance: "New steer" })).status).toBe(409);
    expect((await f.sql`select status from noelle.post_ideas where id=${row.ideaId}`)[0]?.status).toBe("drafting");
    expect(await f.sql`select id from noelle.drafter_notes`).toHaveLength(0);
  });
  it("rejects unsupported X polish rather than acknowledging a worker no-op", async () => {
    const row = await f.seed(); expect((await f.request(row.ideaId, "polish")).status).toBe(422);
    expect(await f.sql`select id from noelle.ideation_requests`).toHaveLength(0);
  });
  it("preserves null-journal ordinary generation for existing automatic admission", async () => {
    const row = await f.seed(); expect((await f.request(row.ideaId, "generate")).status).toBe(200);
    expect((await f.sql`select status,generation_request_id from noelle.post_ideas where id=${row.ideaId}`)[0])
      .toEqual({ status: "approved", generation_request_id: null });
  });
  it("assigns a fresh journal identity when regenerating a completed reviewed request", async () => {
    const row = await f.seed();
    const [request] = await f.sql`insert into noelle.post_generation_requests(org_id,agent_instance_id,idea_id,platforms,status)
      select org_id,agent_instance_id,id,array['x'],'drafted' from noelle.post_ideas where id=${row.ideaId} returning id`;
    await f.sql`update noelle.post_ideas set generation_request_id=${request!.id},generation_review_required=true where id=${row.ideaId}`;
    expect((await f.request(row.ideaId, "generate", { guidance: "New generation" })).status).toBe(200);
    const [idea] = await f.sql`select generation_request_id,generation_review_required from noelle.post_ideas where id=${row.ideaId}`;
    expect(idea?.generation_request_id).not.toBe(request!.id);
    expect(idea?.generation_review_required).toBe(true);
    expect(await f.sql`select id from noelle.post_generation_requests where status='queued'`).toHaveLength(1);
  });
  it("keeps membership denial free of content writes", async () => {
    const row = await f.seed(); membership.allowed = false;
    expect((await f.request(row.draftId, "mark-ready")).status).toBe(403);
    expect((await state(row.draftId))[0]?.status).toBe("draft");
  });
});
