import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { NoelleContext } from "../context.js";
import { approvalsModule } from "./approvals.js";

const url = process.env.NOELLE_APPROVAL_MCP_STATE_TEST_DATABASE_URL;
const orgId="00000000-0000-4000-8000-000000000001", instanceId="00000000-0000-4000-8000-000000000011";
describe.skipIf(!url)("approval tool mutation authority (dedicated PostgreSQL)", () => {
  let sql: ReturnType<typeof postgres>, ctx: NoelleContext;
  beforeAll(async () => {
    sql=postgres(url!,{max:10,onnotice:()=>{}});
    const [db]=await sql`select current_database() as name`;
    if (!db?.name.endsWith("_approval_mcp_state_test")) {
      await sql.end(); throw new Error("Dedicated approval MCP state test database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const file of ["0001_noelle_schema.sql","0004_drafts_sent_at.sql","0003_x_watchlist.sql",
      "0005_leads_full_schema.sql","0018_x_watchlist_people.sql","0107_linkedin_reply_claims.sql","0108_x_browser_discovery.sql", "0125_reddit_reply_claims.sql"])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`,import.meta.url),"utf8"));
    ctx={sql,assertWritable:()=>{},operatorId:()=>"operator",resolveOrg:async()=>({orgId,slug:"one",name:"One"})} as unknown as NoelleContext;
  });
  beforeEach(async()=>{
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${orgId},'one','One')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,status) values (${instanceId},${orgId},'x_intern','active')`;
  });
  afterAll(async()=>{await sql?.end();});
  async function seed(kind="reply",status="pending",leadId?:string){
    if (!leadId){const [lead]=await sql`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,payload)
      values (${orgId},${instanceId},gen_random_uuid()::text,'x','{}') returning id`;leadId=lead!.id as string;}
    const [draft]=await sql`insert into noelle.drafts(org_id,lead_id,payload)
      values (${orgId},${leadId},${sql.json({kind,body:"Original",verifier_meta:{pass:true},reply_recheck:{pass:true}})}) returning id`;
    const [approval]=await sql`insert into noelle.approvals(org_id,agent_instance_id,draft_id,lead_id,status,decided_by)
      values (${orgId},${instanceId},${draft!.id},${leadId},${status},'operator') returning id`;
    return {id:approval!.id as string,draftId:draft!.id as string,leadId};
  }
  const call=(name:string,id:string,extra:Record<string,unknown>={})=>approvalsModule.handle(name,{approvalId:id,...extra},ctx);
  async function state(id:string){return (await sql`select a.status,d.payload from noelle.approvals a join noelle.drafts d on d.id=a.draft_id where a.id=${id}`)[0];}
  it.each(["sent","skipped","expired"])("does not park a %s DM",async status=>{
    const row=await seed("dm",status); expect(await call("noelle_park_draft",row.id)).toMatchObject({isError:true});
    expect((await state(row.id))?.status).toBe(status);
  });
  it("does not park a reply",async()=>{
    const row=await seed();expect(await call("noelle_park_draft",row.id)).toMatchObject({isError:true});
    expect((await state(row.id))?.status).toBe("pending");
  });
  it("restores exactly a skipped companion DM",async()=>{
    const reply=await seed("reply","skipped"),dm=await seed("dm","skipped",reply.leadId);
    expect(await call("noelle_unskip_draft",dm.id)).not.toMatchObject({isError:true});
    expect((await state(dm.id))?.status).toBe("pending");expect((await state(reply.id))?.status).toBe("skipped");
  });
  it("retains a receipt while refusing an edit",async()=>{
    const row=await seed();await sql`update noelle.drafts set sent_external_id='123',sent_at=now() where id=${row.draftId}`;
    expect(await call("noelle_edit_draft",row.id,{body:"Wrong edit"})).toMatchObject({isError:true});
    expect((await state(row.id))?.payload.edited_body).toBeUndefined();
  });
  it("retains an uncertain target claim while refusing an edit",async()=>{
    const row=await seed();await sql`insert into noelle.x_reply_claims(org_id,tweet_id,approval_id) values (${orgId},'123',${row.id})`;
    expect(await call("noelle_edit_draft",row.id,{body:"Wrong edit"})).toMatchObject({isError:true});
    expect((await state(row.id))?.payload.edited_body).toBeUndefined();
  });
  it("clears a stale verifier only after text changes",async()=>{
    const row=await seed();await call("noelle_edit_draft",row.id,{body:"Original"});
    expect((await state(row.id))?.payload.verifier_meta).toEqual({pass:true});
    await call("noelle_edit_draft",row.id,{body:"Operator correction"});
    expect((await state(row.id))?.payload.verifier_meta).toBeUndefined();
    expect((await state(row.id))?.payload.reply_recheck).toBeUndefined();
  });
  it("keeps coherent reply angles together while preserving the companion DM",async()=>{
    const reply=await seed(),sibling=await seed("reply","pending",reply.leadId),dm=await seed("dm","pending",reply.leadId);
    expect(await call("noelle_skip_draft",reply.id)).not.toMatchObject({isError:true});
    expect((await state(reply.id))?.status).toBe("skipped");expect((await state(sibling.id))?.status).toBe("skipped");
    expect((await state(dm.id))?.status).toBe("pending");
  });
});
