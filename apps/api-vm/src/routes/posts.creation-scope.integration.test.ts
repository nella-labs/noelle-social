import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import postgres, { type Sql } from "postgres";
import { Hono } from "hono";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { posts } from "./posts.js";
import type { AuthContext } from "../middleware/jwt.js";
const url = process.env.NOELLE_CONTENT_SCOPE_TEST_DATABASE_URL;
describe.skipIf(!url)("content creation scope (dedicated PostgreSQL)", () => {
  const ownOrg = "00000000-0000-4000-8000-000000000001",
    otherOrg = "00000000-0000-4000-8000-000000000002";
  const ownX = "00000000-0000-4000-8000-000000000011",
    otherX = "00000000-0000-4000-8000-000000000012";
  const ownLi = "00000000-0000-4000-8000-000000000021",
    otherLi = "00000000-0000-4000-8000-000000000022";
  const user = "00000000-0000-4000-8000-000000000099";
  let sql: Sql;
  const app = new Hono<{ Variables: { auth: AuthContext } }>();
  app.use("*", async (c, next) => {
    c.set("auth", { userId: user, raw: {} });
    await next();
  });
  app.route("/", posts);
  function request(kind: "ideate" | "manual", owner: object = {}, platform = "x") {
    const body =
      kind === "ideate"
        ? { mode: "single", platform, count: 3, ...owner }
        : { hook: "A bounded fixture hook", platform, ...owner };
    return app.request(`/api/posts/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }
  async function saved(kind: "ideate" | "manual") {
    const rows = await sql.unsafe(
      `select org_id,agent_instance_id from noelle.${kind === "ideate" ? "ideation_requests" : "post_ideas"}`,
    );
    return [...rows];
  }
  beforeAll(async () => {
    const blocked = () => {
      throw new Error("Network is forbidden in content scope fixtures");
    };
    vi.stubGlobal("fetch", blocked);
    vi.spyOn(http, "request").mockImplementation(blocked);
    vi.spyOn(http, "get").mockImplementation(blocked);
    vi.spyOn(https, "request").mockImplementation(blocked);
    vi.spyOn(https, "get").mockImplementation(blocked);
    const url = process.env.NOELLE_CONTENT_SCOPE_TEST_DATABASE_URL;
    if (
      !url ||
      new URL(url).pathname !== "/noelle_content_scope_test" ||
      !["localhost", "127.0.0.1"].includes(new URL(url).hostname)
    )
      throw new Error("Exact dedicated local database required");
    sql = postgres(url, {
      max: 3,
      onnotice: () => {},
      connection: {
        application_name: "content_scope_actual_entry_fixture",
        statement_timeout: 5000,
      },
    });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_content_scope_test")
      throw new Error("Exact database required before DDL");
    await sql`drop schema if exists noelle cascade`;
    for (const name of [
      "0001_noelle_schema.sql",
      "0045_post_ideas.sql",
      "0046_post_drafts.sql",
      "0050_ideation_requests.sql",
      "0059_content_crossplatform.sql",
      "0072_ideation_request_target_platforms.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url),
          "utf8",
        ),
      );
    __setDbClientForTests(sql);
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values (${ownOrg},'selected','Selected'),(${otherOrg},'other','Other')`;
    await sql`insert into noelle.agent_instances(id,org_id,role,status) values
    (${ownX},${ownOrg},'x_intern','paused'),(${otherX},${otherOrg},'x_intern','active'),
    (${ownLi},${ownOrg},'linkedin_intern','paused'),(${otherLi},${otherOrg},'linkedin_intern','active')`;
    await sql`insert into noelle.org_members(org_id,user_id) values (${ownOrg},${user}),(${otherOrg},${user})`;
  });
  afterAll(async () => {
    resetDbClientForTests();
    await sql?.end({ timeout: 0 });
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  test.each(["ideate", "manual"] as const)(
    "actual %s route retains explicit selected-org paused owner against another org active owner",
    async (kind) => {
      const response = await request(kind, { orgId: ownOrg, agentInstanceId: ownX });
      expect(response.status).toBe(200);
      expect(await saved(kind)).toEqual([{ org_id: ownOrg, agent_instance_id: ownX }]);
    },
  );
  test.each(["ideate", "manual"] as const)(
    "actual %s route does not deny valid selected tenant because global owner is foreign",
    async (kind) => {
      await sql`delete from noelle.org_members where org_id=${otherOrg}`;
      const response = await request(kind, { orgId: ownOrg, agentInstanceId: ownX });
      expect(response.status).toBe(200);
      expect(await saved(kind)).toEqual([{ org_id: ownOrg, agent_instance_id: ownX }]);
    },
  );
  test.each(["ideate", "manual"] as const)(
    "actual %s route rejects contradictory explicit owner before insert",
    async (kind) => {
      const response = await request(kind, { orgId: otherOrg, agentInstanceId: ownX });
      expect(response.status).toBe(404);
      expect(await saved(kind)).toEqual([]);
    },
  );
  test.each(["ideate", "manual"] as const)(
    "healthy legacy %s route retains one eligible X lane",
    async (kind) => {
      await sql`update noelle.agent_instances set status='inactive' where id=${otherX}`;
      const response = await request(kind);
      expect(response.status).toBe(200);
      expect(await saved(kind)).toEqual([{ org_id: ownOrg, agent_instance_id: ownX }]);
    },
  );
  test.each(["ideate", "manual"] as const)(
    "healthy %s membership rejection never writes",
    async (kind) => {
      await sql`delete from noelle.org_members`;
      const response = await request(kind, { orgId: ownOrg, agentInstanceId: ownX });
      expect(response.status).toBe(403);
      expect(await saved(kind)).toEqual([]);
    },
  );
  test.each(["ideate", "manual"] as const)(
    "legacy %s rejects multiple eligible organizations without choosing one",
    async (kind) => {
      const response = await request(kind);
      expect(response.status).toBe(409);
      expect(await saved(kind)).toEqual([]);
    },
  );
  test.each(["ideate", "manual"] as const)(
    "explicit %s LinkedIn owner stays in its selected tenant",
    async (kind) => {
      const response = await request(kind, { orgId: ownOrg, agentInstanceId: ownLi }, "linkedin");
      expect(response.status).toBe(200);
      expect(await saved(kind)).toEqual([{ org_id: ownOrg, agent_instance_id: ownLi }]);
    },
  );
  test.each(["ideate", "manual"] as const)(
    "partial %s owner is invalid before SQL mutation",
    async (kind) => {
      expect((await request(kind, { orgId: ownOrg })).status).toBe(400);
      expect(await saved(kind)).toEqual([]);
    },
  );
  test.each(["ideate", "manual"] as const)(
    "inactive %s selected owner cannot use another eligible instance",
    async (kind) => {
      await sql`update noelle.agent_instances set status='inactive' where id=${ownX}`;
      expect((await request(kind, { orgId: ownOrg, agentInstanceId: ownX })).status).toBe(404);
      expect(await saved(kind)).toEqual([]);
    },
  );
});
