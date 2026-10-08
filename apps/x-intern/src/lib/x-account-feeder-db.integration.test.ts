import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertAccountUltraProfile } from "./x-account-feeder-db.js";

const url = process.env.NOELLE_CORPUS_METRICS_TEST_DATABASE_URL;
describe.skipIf(!url)("X profile rollup write compatibility (native PostgreSQL)", () => {
  let sql: Sql;
  let orgId: string;
  let instanceId: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 2, onnotice: () => {} });
    if (!String((await sql`select current_database() as name`)[0]?.name).includes("account_corpus_metrics_test")) throw new Error("dedicated corpus metrics test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0051_account_feeder.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    orgId = String((await sql`insert into noelle.organizations(slug,name) values ('profile_test','Profile test') returning id`)[0]!.id);
    instanceId = String((await sql`insert into noelle.agent_instances(org_id,role) values (${orgId},'x_intern') returning id`)[0]!.id);
  });
  afterAll(async () => { await sql?.end({ timeout: 0 }); });
  const profile = () => ({ orgId, agentInstanceId: instanceId, platform: "x", accountHandle: "source",
    voiceSummary: "Saved writing style", tone: "direct", structureNotes: "short paragraphs",
    hookPatterns: [], signaturePhrases: [], topTopics: [], avgLikeCount: null, avgCommentCount: null,
    postsAnalyzed: 1, samplePostIds: [], model: "test" });

  it("preserves unknown and measured averages through the X facade", async () => {
    await upsertAccountUltraProfile(sql, profile());
    expect((await sql`select avg_like_count,avg_comment_count from noelle.account_ultra_profiles`)[0]).toEqual({ avg_like_count: null, avg_comment_count: null });
    await upsertAccountUltraProfile(sql, { ...profile(), avgLikeCount: 0, avgCommentCount: 2.5 });
    expect((await sql`select avg_like_count::text,avg_comment_count::text from noelle.account_ultra_profiles`)[0]).toEqual({ avg_like_count: "0", avg_comment_count: "2.5" });
  });
});
