import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";
import { resetEnvForTests } from "../env.js";
import { signHmacBody } from "../middleware/hmac.js";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";

const url = process.env.NOELLE_OUTBOUND_TIMESTAMP_TEST_DATABASE_URL;
const secret = "timestamp-fixture-secret".repeat(3);
const measured = "2026-10-01T12:34:56.000Z";

describe.skipIf(!url)("outbound source timestamps (native PostgreSQL)", () => {
  let sql: Sql;
  let org: string;
  let instance: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    const [current] = await sql`select current_database() as db`;
    if (!String(current?.db).includes("outbound_timestamp_test")) throw Error("dedicated outbound timestamp test database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0005_leads_full_schema.sql", "0106_tenant_scoped_lead_identity.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = url;
    process.env.NOELLE_SUPABASE_JWT_SECRET = "timestamp-fixture-jwt";
    process.env.NOELLE_HMAC_SECRET = secret;
    delete process.env.NOELLE_APP_BASE_URL;
    resetEnvForTests();
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    const [savedOrg] = await sql`insert into noelle.organizations(slug,name) values ('source-time','Source time') returning id`;
    org = savedOrg!.id;
    const [savedInstance] = await sql`insert into noelle.agent_instances(org_id,role,status) values (${org},'x_intern','active') returning id`;
    instance = savedInstance!.id;
    __setDbClientForTests(sql);
  });
  afterAll(async () => { resetDbClientForTests(); await sql?.end({ timeout: 0 }); });

  async function post(postedAt: string | null) {
    const body = JSON.stringify({
      owner: { orgId: org, agentInstanceId: instance },
      leadId: "source-post", batchNumber: null, platform: "x", authorHandle: "source_author", authorId: "123",
      authorFollowers: null, allowsDms: null, originalPostId: "1234567890123456789",
      originalPostText: "the measured source post", originalPostUrl: "https://x.com/source_author/status/1234567890123456789",
      postedAt, matchedTrigger: null, humanReviewRequired: true, qualityGatePassed: false,
      drafts: [{ id: crypto.randomUUID(), kind: "reply", angle: "technical", body: "the concrete source detail", charCount: 26 }],
    });
    const ts = Math.floor(Date.now() / 1000);
    const { signature } = signHmacBody(secret, ts, body);
    const response = await createApp().request("/api/outbound", {
      method: "POST", body,
      headers: { "content-type": "application/json", "x-noelle-timestamp": String(ts), "x-noelle-signature": signature },
    });
    expect(response.status, await response.text()).toBe(200);
    const [row] = await sql`select payload from noelle.leads where org_id=${org} and external_id='source-post'`;
    return row!.payload as Record<string, unknown>;
  }

  it("stores a new lead's unknown source time as null", async () => {
    expect((await post(null)).posted_at).toBeNull();
  });

  it("does not erase a measured source timestamp when later drafting sends unknown", async () => {
    await sql`insert into noelle.leads(org_id,agent_instance_id,external_id,platform,author_handle,payload)
      values (${org},${instance},'source-post','x','source_author',${sql.json({ text: "original source", posted_at: measured })})`;
    expect(await post(null)).toMatchObject({ text: "original source", posted_at: measured });
  });

  it("retains a valid measured source timestamp", async () => {
    expect((await post(measured)).posted_at).toBe(measured);
  });
});
