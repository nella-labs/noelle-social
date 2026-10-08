import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import postgres from "postgres";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import type { AuthContext } from "../middleware/jwt.js";
import { posts } from "./posts.js";

export const postsOrg = "00000000-0000-4000-8000-000000000001";
export const postsForeignOrg = "00000000-0000-4000-8000-000000000002";
export const postsInstance = "00000000-0000-4000-8000-000000000011";
export const postsForeignInstance = "00000000-0000-4000-8000-000000000012";
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => { c.set("auth", { userId: postsOrg, raw: {} }); await next(); });
app.route("/", posts);

export async function openPostsStateFixture(url: string) {
  const sql = postgres(url, { max: 12, onnotice: () => {} });
  const [db] = await sql`select current_database() as name`;
  if (!db?.name.endsWith("_content_posts_state_test")) {
    await sql.end(); throw new Error("Dedicated content posts state test database required");
  }
  await sql`drop schema if exists noelle cascade`;
  for (const file of ["0001_noelle_schema.sql", "0045_post_ideas.sql", "0046_post_drafts.sql", "0047_drafter_notes.sql",
    "0050_ideation_requests.sql", "0056_content_edits_ledger.sql", "0059_content_crossplatform.sql", "0060_post_draft_fields.sql", "0061_ideation_polish.sql",
    "0072_ideation_request_target_platforms.sql", "0074_content_schedule_slots.sql", "0079_x_self_tracking.sql", "0100_post_generation_requests.sql"])
    await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url), "utf8"));
  __setDbClientForTests(sql);
  return {
    sql,
    async reset() {
      __setDbClientForTests(sql); await sql`truncate noelle.organizations cascade`;
      await sql`insert into noelle.organizations(id,slug,name) values (${postsOrg},'one','One'),(${postsForeignOrg},'two','Two')`;
      await sql`insert into noelle.agent_instances(id,org_id,role,status) values
        (${postsInstance},${postsOrg},'x_intern','active'),(${postsForeignInstance},${postsForeignOrg},'x_intern','active')`;
    },
    async seed(status = "draft", platform = "x", ideaStatus = "drafted") {
      const [idea] = await sql`insert into noelle.post_ideas(org_id,agent_instance_id,platform,target_platforms,hook,pillar,status)
        values (${postsOrg},${postsInstance},'x',array['x','linkedin'],'A concrete finding','building',${ideaStatus}) returning id`;
      const [draft] = await sql`insert into noelle.post_drafts(org_id,agent_instance_id,idea_id,platform,body,final_body,status,stage)
        values (${postsOrg},${postsInstance},${idea!.id},${platform},'Original text','Saved operator edit',${status},${status === 'published' ? 'posted' : 'draft'}) returning id`;
      return { ideaId: idea!.id as string, draftId: draft!.id as string };
    },
    async slot(row: { ideaId: string; draftId: string }, status = "publishing", error: string | null = null) {
      await sql`insert into noelle.content_schedule_slots(org_id,agent_instance_id,platform,slot_at,status,idea_id,draft_id,auto_publish,error_message)
        values (${postsOrg},${postsInstance},'x',now(),${status},${row.ideaId},${row.draftId},true,${error})`;
    },
    request(id: string, action: string, body: object = {}) {
      return app.request(`/api/posts/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    },
    async close() { resetDbClientForTests(); await sql.end(); },
  };
}
