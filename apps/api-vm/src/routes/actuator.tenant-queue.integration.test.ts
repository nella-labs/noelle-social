import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { actuator } from "./actuator.js";

const org='11111111-1111-4111-8111-111111111111',foreign='22222222-2222-4222-8222-222222222222';
const url=process.env.NOELLE_ACTUATOR_TENANT_QUEUE_TEST_DATABASE_URL;
vi.mock('../middleware/actuator.js',()=>({requireActuatorToken:async(c:{set:(key:string,value:unknown)=>void},next:()=>Promise<void>)=>{c.set('actuator',{orgId:org});await next();}}));
type Platform='x'|'linkedin'|'reddit';
const platforms:Platform[]=['x','linkedin','reddit'];

describe.skipIf(!url)('native browser queue tenant boundaries',()=>{
  let sql:ReturnType<typeof postgres>; let instances:Record<Platform,string>;
  beforeAll(async()=>{
    sql=postgres(url!,{max:3,onnotice:()=>{}});
    const [db]=await sql<{name:string}[]>`select current_database() as name`;
    if(!db?.name.endsWith('_actuator_tenant_queue_test')) { await sql.end(); throw new Error('Dedicated queue test database required'); }
    await sql`drop schema if exists noelle cascade`;
    for(const file of ['0001_noelle_schema.sql','0004_drafts_sent_at.sql','0003_x_watchlist.sql','0005_leads_full_schema.sql','0018_x_watchlist_people.sql','0015_auto_send.sql','0027_linkedin_watchlist_people.sql','0054_linkedin_activity.sql','0081_reply_send_enabled.sql','0083_x_activity.sql','0084_reddit_activity.sql','0107_linkedin_reply_claims.sql','0108_x_browser_discovery.sql','0110_actuator_daily_reply_cap.sql', '0126_x_daily_reply_cap_variation.sql','0125_reddit_reply_claims.sql'])
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`,import.meta.url),'utf8'));
  });
  beforeEach(async()=>{
    __setDbClientForTests(sql);
    await sql`truncate noelle.x_reply_claims,noelle.x_activity,noelle.linkedin_reply_claims,noelle.linkedin_activity,noelle.reddit_activity,noelle.approvals,noelle.drafts,noelle.leads,noelle.agent_instances,noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values(${org},'one','One'),(${foreign},'two','Two')`;
    instances={} as Record<Platform,string>;
    for(const platform of platforms){
      const [row]=await sql<{id:string}[]>`insert into noelle.agent_instances(org_id,role,reply_send_enabled)
        values(${org},${platform+'_intern'},true) returning id`;
      instances[platform]=row!.id;
    }
  });
  afterAll(async()=>{resetDbClientForTests();await new Promise(resolve=>setTimeout(resolve,1100));await sql?.end();});
  async function candidate(platform:Platform,externalId='101'){
    const payload={original_post_url:platform==='reddit' ? `https://www.reddit.com/r/SaaS/comments/${externalId}/title/` : `https://www.linkedin.com/feed/update/urn:li:activity:${externalId}/`,
      url:`https://www.reddit.com/r/SaaS/comments/${externalId}/title/`,subreddit:'SaaS',author_handle:'builder'};
    const [lead]=await sql<{id:string}[]>`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,author_handle,payload)
      values(${org},${instances[platform]},${externalId},${platform},'builder',${sql.json(payload)}) returning id`;
    const [draft]=await sql<{id:string}[]>`insert into noelle.drafts(org_id,lead_id,payload)
      values(${org},${lead!.id},'{"kind":"reply","body":"Supported reply","verifier_meta":{"pass":true,"judgeOk":true,"scores":{"voice":0.9}}}') returning id`;
    const [approval]=await sql<{id:string}[]>`insert into noelle.approvals(org_id,agent_instance_id,lead_id,draft_id)
      values(${org},${instances[platform]},${lead!.id},${draft!.id}) returning id`;
    return {leadId:lead!.id,draftId:draft!.id,approvalId:approval!.id};
  }
  async function queue(platform:Platform){
    const response=await actuator.request(`/api/actionable-${platform}?instanceId=${instances[platform]}`);
    expect(response.status).toBe(200);
    return response.json() as Promise<{replies?:unknown[];comments?:unknown[];dms?:unknown[]}>;
  }
  for(const platform of platforms){
    it(`${platform} serves its consistent owned reply`,async()=>{
      await candidate(platform);const body=await queue(platform);
      expect(body.replies??body.comments).toHaveLength(1);
    });
    it.each(['draft-org','lead-org','draft-lead','approval-org','lead-instance','platform','role'])(`${platform} withholds a mismatched %s reference`,async mismatch=>{
      const row=await candidate(platform);
      if(mismatch==='draft-org') await sql`update noelle.drafts set org_id=${foreign} where id=${row.draftId}`;
      else if(mismatch==='lead-org') await sql`update noelle.leads set org_id=${foreign} where id=${row.leadId}`;
      else if(mismatch==='draft-lead'){
        const other=await candidate(platform,'202');
        await sql`update noelle.drafts set lead_id=${other.leadId} where id=${row.draftId}`;
        await sql`update noelle.approvals set status='skipped' where id=${other.approvalId}`;
      } else if(mismatch==='approval-org') await sql`update noelle.approvals set org_id=${foreign} where id=${row.approvalId}`;
      else if(mismatch==='lead-instance') await sql`update noelle.leads set agent_instance_id=${instances[platform==='x'?'linkedin':'x']} where id=${row.leadId}`;
      else if(mismatch==='platform') await sql`update noelle.leads set platform=${platform==='x'?'linkedin':'x'} where id=${row.leadId}`;
      else await sql`update noelle.agent_instances set role='video_intern' where id=${instances[platform]}`;
      const body=await queue(platform);
      expect(body.replies??body.comments).toHaveLength(0);
      expect(body.dms??[]).toHaveLength(0);
    });
  }
});
