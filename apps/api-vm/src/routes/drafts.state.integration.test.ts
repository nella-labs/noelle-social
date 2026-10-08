import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveXReplyClaimInTransaction } from "@noelle/runtime";
import { openApprovalStateFixture, stateForeignInstance, stateForeignOrg, stateInstance, stateOrg } from "./drafts.state-fixture.js";

const membership = vi.hoisted(() => ({ allowed: true, check: undefined as (() => Promise<void>) | undefined }));
vi.mock("../lib/auth.js", () => ({ isOrgMember: async () => { await membership.check?.(); return membership.allowed; } }));
const url = process.env.NOELLE_APPROVAL_STATE_TEST_DATABASE_URL;
describe.skipIf(!url)("approval mutations (dedicated PostgreSQL)", () => {
  let f: Awaited<ReturnType<typeof openApprovalStateFixture>>;
  beforeAll(async () => { f = await openApprovalStateFixture(url!); });
  beforeEach(async () => { membership.allowed = true; membership.check = undefined; await f.reset(); });
  afterAll(async () => { await f?.close(); });
  function inject(write: () => Promise<unknown>) {
    membership.check = async () => { membership.check = undefined; await write(); };
  }
  it.each(["save-edit", "skip", "unskip"])("preserves a permanent Reddit claim on %s", async action => {
    const row = await f.seed("reply", action === "unskip" ? "skipped" : "pending");
    await f.sql`update noelle.agent_instances set role='reddit_intern' where id=${stateInstance}`;
    await f.sql`update noelle.leads set platform='reddit' where id=${row.leadId}`;
    const digest = "a".repeat(64);
    await f.sql`insert into noelle.reddit_reply_claims(org_id,post_id,agent_instance_id,approval_id,draft_id,lead_id,
      body_sha256,target_sha256,source_sha256,draft_sha256)
      values (${stateOrg},'abc123',${stateInstance},${row.id},${row.draftId},${row.leadId},${digest},${digest},${digest},${digest})`;
    expect((await f.request(row.id, action, { body: "Changed" })).status).toBe(409);
    expect((await f.state(row))?.payload.edited_body).toBeUndefined();
  });
  it("parks a pending companion DM without changing its reply", async () => {
    const reply = await f.seed(); const dm = await f.seed("dm", "pending", reply.leadId);
    expect((await f.request(dm.id,"park")).status).toBe(200);
    expect((await f.state(dm))?.status).toBe("deferred"); expect((await f.state(reply))?.status).toBe("pending");
  });
  it("refuses to park a reply as a DM", async () => {
    const row = await f.seed(); expect((await f.request(row.id,"park")).status).toBe(409);
    expect((await f.state(row))?.status).toBe("pending");
  });
  it("does not overwrite a send committed after park authorization", async () => {
    const row = await f.seed("dm"); inject(() => f.sql`update noelle.approvals set status='sent' where id=${row.id}`);
    expect((await f.request(row.id,"park")).status).toBe(409); expect((await f.state(row))?.status).toBe("sent");
  });
  it("skips a deferred DM instead of acknowledging an unchanged row", async () => {
    const row = await f.seed("dm","deferred"); expect((await f.request(row.id,"skip")).status).toBe(200);
    expect((await f.state(row))?.status).toBe("skipped");
  });
  it("restores exactly a skipped companion DM", async () => {
    const reply = await f.seed("reply","skipped"); const dm = await f.seed("dm","skipped",reply.leadId);
    expect((await f.request(dm.id,"unskip")).status).toBe(200);
    expect((await f.state(dm))?.status).toBe("pending"); expect((await f.state(reply))?.status).toBe("skipped");
  });
  it.each(["save-edit","skip","unskip"])("refuses %s after a committed decision", async action => {
    const row = await f.seed("reply",action === "unskip" ? "skipped" : "pending");
    inject(() => f.sql`update noelle.approvals set status='sent' where id=${row.id}`);
    expect((await f.request(row.id,action,{ body:"Stale edit" })).status).toBe(409);
    expect((await f.state(row))?.status).toBe("sent"); expect((await f.state(row))?.payload.edited_body).toBeUndefined();
  });
  it.each(["receipt","claim"])("preserves %s after save-edit authorization", async barrier => {
    const row = await f.seed(); inject(() => barrier === "receipt"
      ? f.sql`update noelle.drafts set sent_external_id='123',sent_at=now() where id=${row.draftId}`
      : f.sql`insert into noelle.x_reply_claims(org_id,tweet_id,approval_id) values (${stateOrg},'123',${row.id})`);
    expect((await f.request(row.id,"save-edit",{body:"Stale edit"})).status).toBe(409);
    expect((await f.state(row))?.payload.edited_body).toBeUndefined();
  });
  it.each(["draft-org","draft-lead","approval-instance","lead-org","lead-instance","instance-role"])("rejects committed %s incoherence before editing", async changed => {
    const row = await f.seed(); const other = await f.seed(); inject(async () => {
      if (changed === "draft-org") await f.sql`update noelle.drafts set org_id=${stateForeignOrg} where id=${row.draftId}`;
      if (changed === "draft-lead") await f.sql`update noelle.drafts set lead_id=${other.leadId} where id=${row.draftId}`;
      if (changed === "approval-instance") await f.sql`update noelle.approvals set agent_instance_id=${stateForeignInstance} where id=${row.id}`;
      if (changed === "lead-org") await f.sql`update noelle.leads set org_id=${stateForeignOrg} where id=${row.leadId}`;
      if (changed === "lead-instance") await f.sql`update noelle.leads set agent_instance_id=${stateForeignInstance} where id=${row.leadId}`;
      if (changed === "instance-role") await f.sql`update noelle.agent_instances set role='linkedin_intern' where id=${stateInstance}`;
    });
    expect((await f.request(row.id,"save-edit",{body:"Wrong scope"})).status).toBe(409);
    expect((await f.state(row))?.payload.edited_body).toBeUndefined();
  });
  it.each(["skip","unskip"])("changes only coherent same-owner reply siblings on %s", async action => {
    const status = action === "unskip" ? "skipped" : "pending";
    const row = await f.seed("reply",status); const sibling = await f.seed("reply",status,row.leadId);
    const foreign = await f.seed("reply",status,row.leadId,stateForeignOrg,stateForeignInstance);
    const dm = await f.seed("dm",status,row.leadId);
    expect((await f.request(row.id,action)).status).toBe(200);
    expect((await f.state(sibling))?.status).toBe(action === "skip" ? "skipped" : "pending");
    expect((await f.state(foreign))?.status).toBe(status); expect((await f.state(dm))?.status).toBe(status);
  });
  it("ignores incoherent selected IDs in bulk skip", async () => {
    const row = await f.seed(); const bad = await f.seed("reply","pending",row.leadId,stateForeignOrg,stateForeignInstance);
    await f.sql`update noelle.approvals set org_id=${stateOrg},agent_instance_id=${stateInstance} where id=${bad.id}`;
    const response = await f.request("bulk-skip","",{org_id:stateOrg,approval_ids:[bad.id]});
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({skipped_count:0});
    expect((await f.state(row))?.status).toBe("pending"); expect((await f.state(bad))?.status).toBe("pending");
  });
  it("clears stale verdicts only when the saved text changes", async () => {
    const row = await f.seed(); expect((await f.request(row.id,"save-edit",{body:"Original"})).status).toBe(200);
    expect((await f.state(row))?.payload.verifier_meta).toEqual({pass:true});
    expect((await f.request(row.id,"save-edit",{body:"Operator correction"})).status).toBe(200);
    expect((await f.state(row))?.payload.verifier_meta).toBeUndefined();
    expect((await f.state(row))?.payload.reply_recheck).toBeUndefined();
  });
  it("does not restore automatic-review rejections", async () => {
    const row = await f.seed("reply","skipped"); await f.sql`update noelle.approvals set decided_by='automatic-review' where id=${row.id}`;
    expect((await f.request(row.id,"unskip")).status).toBe(409); expect((await f.state(row))?.status).toBe("skipped");
  });
  it("keeps membership denial free of writes", async () => {
    const row = await f.seed("dm"); membership.allowed=false;
    expect((await f.request(row.id,"park")).status).toBe(403); expect((await f.state(row))?.status).toBe("pending");
  });
  it("waits for a real dispatch reservation and preserves its committed claim", async () => {
    const row=await f.seed(); await f.sql`update noelle.leads set external_id='123' where id=${row.leadId}`;
    let claimed!:()=>void,release!:()=>void,backend=0;
    const ready=new Promise<void>(resolve=>{claimed=resolve;}),go=new Promise<void>(resolve=>{release=resolve;});
    const reservation=f.sql.begin(async tx=>{
      backend=Number((await tx`select pg_backend_pid() as pid`)[0]!.pid);
      const claim=await reserveXReplyClaimInTransaction(tx,{orgId:stateOrg,draftId:row.draftId,targetTweetId:"123",mode:"manual"});
      expect(claim).not.toBeNull();claimed();await go;return claim;
    });
    await ready;const edit=f.request(row.id,"save-edit",{body:"While dispatching"});
    let blocked=false;
    try {
      const until=Date.now()+2000;
      while (Date.now()<until) {
        blocked=(await f.sql`select 1 from pg_stat_activity where datname=current_database()
          and ${backend}=any(pg_blocking_pids(pid)) and query like '%noelle.drafts%'`).length>0;
        if (blocked) break; await new Promise(resolve=>setTimeout(resolve,10));
      }
    } finally { release(); }
    await reservation;expect((await edit).status).toBe(409);expect(blocked).toBe(true);
    expect((await f.state(row))?.payload.edited_body).toBeUndefined();
    expect(await f.sql`select approval_id from noelle.x_reply_claims`).toHaveLength(1);
  });
  it("keeps eight simultaneous reply decisions coherent without deadlocking", async () => {
    const row=await f.seed();await f.seed("reply","pending",row.leadId);
    const responses=await Promise.all(Array.from({length:8},()=>f.request(row.id,"skip")));
    expect(responses.map(response=>response.status)).toEqual(Array(8).fill(200));
    expect((await f.sql`select status from noelle.approvals`).every(row=>row.status==="skipped")).toBe(true);
  });
  it("does not acknowledge an unchanged unsupported draft kind", async () => {
    const row=await f.seed("unsupported");expect((await f.request(row.id,"skip")).status).toBe(409);
    expect((await f.state(row))?.status).toBe("pending");
  });
  it.each(["linkedin","reddit"])("retains native %s reply decision support",async platform=>{
    const row=await f.seed();await f.sql`update noelle.agent_instances set role=${platform+"_intern"} where id=${stateInstance}`;
    await f.sql`update noelle.leads set platform=${platform} where id=${row.leadId}`;
    expect((await f.request(row.id,"skip")).status).toBe(200);expect((await f.state(row))?.status).toBe("skipped");
  });
});
