import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { actuator } from "./actuator.js";

const org="11111111-1111-4111-8111-111111111111";
const instance="22222222-2222-4222-8222-222222222222";
const url=process.env.NOELLE_LINKEDIN_BROWSER_CLAIMS_TEST_DATABASE_URL;
vi.mock("../middleware/actuator.js",()=>({ requireActuatorToken:async (c:{set:(key:string,value:unknown)=>void},next:()=>Promise<void>)=>{c.set("actuator",{orgId:org});await next();} }));

describe.skipIf(!url)("native LinkedIn browser reservations",()=>{
  let sql:ReturnType<typeof postgres>;
  beforeAll(async()=>{
    sql=postgres(url!,{max:12,onnotice:()=>{}});
    const [db]=await sql<{name:string}[]>`select current_database() as name`;
    if(!db?.name.endsWith('_linkedin_browser_claims_test')) throw new Error('Dedicated claim test database required');
    await sql`drop schema if exists noelle cascade`;
    for(const file of ['0001_noelle_schema.sql','0004_drafts_sent_at.sql','0003_x_watchlist.sql','0005_leads_full_schema.sql','0018_x_watchlist_people.sql','0015_auto_send.sql','0027_linkedin_watchlist_people.sql','0054_linkedin_activity.sql','0081_reply_send_enabled.sql','0107_linkedin_reply_claims.sql','0110_actuator_daily_reply_cap.sql'])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`,import.meta.url),'utf8'));
  });
  beforeEach(async()=>{
    vi.unstubAllEnvs(); __setDbClientForTests(sql);
    await sql`truncate noelle.linkedin_reply_claims,noelle.linkedin_activity,noelle.approvals,noelle.drafts,noelle.leads,noelle.agent_instances,noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values(${org},'claim','Claim')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,reply_send_enabled,actuator_daily_reply_cap)
      values(${instance},${org},'linkedin_intern',true,40)`;
  });
  afterAll(async()=>{vi.unstubAllEnvs();resetDbClientForTests();await sql?.end();});
  async function candidate(target='101'){
    const [lead]=await sql<{id:string}[]>`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,author_handle,payload)
      values(${org},${instance},${target},'linkedin','builder',jsonb_build_object('original_post_url',${`https://www.linkedin.com/feed/update/urn:li:activity:${target}/`}::text)) returning id`;
    const [draft]=await sql<{id:string}[]>`insert into noelle.drafts(org_id,lead_id,payload)
      values(${org},${lead!.id},'{"kind":"reply","body":"Supported reply","verifier_meta":{"pass":true,"judgeOk":true,"scores":{"voice":0.9}}}') returning id`;
    const [approval]=await sql<{id:string}[]>`insert into noelle.approvals(org_id,agent_instance_id,lead_id,draft_id)
      values(${org},${instance},${lead!.id},${draft!.id}) returning id`;
    return {approvalId:approval!.id,draftId:draft!.id,leadId:lead!.id};
  }
  async function claim(id:string){
    const response=await actuator.request(`/api/actuator/claim-comment/${id}`,{method:'POST'});
    return {status:response.status,body:await response.json() as {claimed:boolean;reason?:string}};
  }
  it('reserves one durable post identity exactly once',async()=>{
    const row=await candidate();
    expect((await claim(row.approvalId)).body).toEqual({claimed:true});
    expect((await claim(row.approvalId)).body.claimed).toBe(false);
    expect(await sql`select * from noelle.linkedin_reply_claims`).toHaveLength(1);
  });
  it('bounds parallel claims on different posts by one instance cap',async()=>{
    await sql`update noelle.agent_instances set actuator_daily_reply_cap=3 where id=${instance}`;
    const rows=await Promise.all(Array.from({length:8},(_,i)=>candidate(String(101+i))));
    expect((await Promise.all(rows.map(row=>claim(row.approvalId)))).filter(row=>row.body.claimed)).toHaveLength(3);
  });
  it('withholds an existing platform receipt',async()=>{
    const row=await candidate();
    await sql`update noelle.drafts set sent_external_id='202',sent_at=now() where id=${row.draftId}`;
    expect((await claim(row.approvalId)).body.claimed).toBe(false);
  });
  it('withholds a lead assigned to a different native instance',async()=>{
    const row=await candidate();
    const [other]=await sql<{id:string}[]>`insert into noelle.agent_instances(org_id,role) values(${org},'x_intern') returning id`;
    await sql`update noelle.leads set agent_instance_id=${other!.id} where id=${row.leadId}`;
    expect((await claim(row.approvalId)).body.claimed).toBe(false);
  });
  it.each(['review','decision','body','source'])('rechecks a committing %s change',async change=>{
    const row=await candidate(); let request:ReturnType<typeof claim>|undefined; let settled=false;
    await sql.begin(async tx=>{
      if(change==='source') await tx`select id from noelle.leads where id=${row.leadId} for no key update`;
      else await tx`select id from noelle.drafts where id=${row.draftId} for update`;
      if(change==='review') await tx`update noelle.drafts set payload=payload-'verifier_meta' where id=${row.draftId}`;
      else if(change==='body') await tx`update noelle.drafts set payload=payload||'{"edited_body":"Changed text"}' where id=${row.draftId}`;
      else if(change==='source') await tx`update noelle.leads set payload=payload||'{"original_post_url":"https://www.linkedin.com/feed/update/urn:li:activity:202/"}' where id=${row.leadId}`;
      else await tx`update noelle.approvals set status='skipped' where id=${row.approvalId}`;
      request=claim(row.approvalId); void request.then(()=>{settled=true;});
      for(let attempt=0;attempt<100;attempt++){
        const [state]=await sql<{waiting:boolean}[]>`select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock' and (query like '%noelle.drafts%' or query like '%noelle.leads%')) as waiting`;
        if(settled||state?.waiting) return;
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      throw new Error('Claim did not reach decision or row lock');
    });
    expect((await request)?.body.claimed).toBe(false);
    expect(await sql`select * from noelle.linkedin_reply_claims`).toHaveLength(0);
  });
});
