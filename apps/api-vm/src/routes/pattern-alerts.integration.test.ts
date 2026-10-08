import { randomUUID } from "node:crypto";
import { PatternAlertsPageSchema } from "@noelle/contracts";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { patternAlerts } from "./pattern-alerts.js";
import type { AuthContext } from "../middleware/jwt.js";
const membership = vi.hoisted(() => ({ onCheck: undefined as (() => Promise<void>) | undefined }));
vi.mock("../lib/auth.js", () => ({
  isOrgMember: async () => {
    await membership.onCheck?.();
    return true;
  },
}));
const url = process.env.PATTERN_ALERTS_DATABASE_URL;
const org = "00000000-0000-4000-8000-000000000001";
const foreign = "00000000-0000-4000-8000-000000000002";
const instance = "00000000-0000-4000-8000-000000000011";
const user = "00000000-0000-4000-8000-000000000021";
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => {
  c.set("auth", { userId: user, raw: {} });
  await next();
});
app.route("/", patternAlerts);
describe.skipIf(!url)("Pattern alert route current authority (native)", () => {
  let sql: postgres.Sql;
  beforeAll(async () => {
    sql = postgres(url!, { max: 4, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    if (!db?.name?.endsWith("_pattern_alerts_test")) {
      await sql.end();
      throw Error("Dedicated *_pattern_alerts_test database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const file of [
      "0001_noelle_schema.sql",
      "0005_leads_full_schema.sql",
      "0004_drafts_sent_at.sql",
      "0003_x_watchlist.sql",
      "0045_post_ideas.sql",
      "0046_post_drafts.sql",
      "0062_pattern_breaker.sql",
      "0081_pattern_suggestion.sql",
      "0121_pattern_refine_claims.sql",
    ])
      await sql.unsafe(
        await readFile(
          new URL(`../../../../infra/cloudsql/schema/${file}`, import.meta.url),
          "utf8",
        ),
      );
  });
  beforeEach(async () => {
    __setDbClientForTests(sql);
    membership.onCheck = undefined;
    await sql`truncate noelle.organizations cascade`;
    await sql`insert into noelle.organizations(id,slug,name) values(${org},'one','One'),(${foreign},'two','Two')`;
    await sql`insert into noelle.agent_instances(id,org_id,role) values(${instance},${org},'x_intern')`;
    await sql`insert into noelle.org_members(org_id,user_id) values(${org},${user})`;
  });
  afterAll(async () => {
    resetDbClientForTests();
    await sql?.end();
    await new Promise((resolve) => setTimeout(resolve, 1300));
  });
  async function seed(ruleOrg = org, alertOrg = org) {
    const [r] =
      await sql`insert into noelle.pattern_rules(org_id,agent_instance_id,kind,label,instruction)
      values(${ruleOrg},${instance},'structure',${`stock closer ${randomUUID()}`},'Avoid repeating a stock closer') returning id`;
    const [a] =
      await sql`insert into noelle.pattern_alerts(org_id,agent_instance_id,rule_id,pattern_name,description,
      window_size,frequency_count,examples) values(${alertOrg},${instance},${r!.id},'stock closer','Replies repeat a stock closer',10,4,'[]') returning id`;
    return { ruleId: r!.id as string, id: a!.id as string };
  }
  const post = (id: string, action: string, body = {}) =>
    app.request(`/api/pattern-alerts/${id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  it("does not expose a soft foreign alert under the current instance", async () => {
    await seed(org, foreign);
    const response = await app.request(`/api/pattern-alerts?instanceId=${instance}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ alerts: [], nextCursor: null, total: 0 });
  });
  it("does not mutate a foreign linked rule", async () => {
    const { id, ruleId } = await seed(foreign);
    expect((await post(id, "revert")).status).toBe(404);
    expect((await sql`select active from noelle.pattern_rules where id=${ruleId}`)[0]?.active).toBe(
      true,
    );
  });
  it("rechecks membership after authorization before acknowledging a write", async () => {
    const { id } = await seed();
    membership.onCheck = async () => {
      await sql`delete from noelle.org_members where org_id=${org}`;
    };
    expect((await post(id, "acknowledge")).status).toBe(409);
    expect((await sql`select status from noelle.pattern_alerts where id=${id}`)[0]?.status).toBe(
      "open",
    );
  });
  it("rechecks native parent role after authorization", async () => {
    const { id } = await seed();
    membership.onCheck = async () => {
      await sql`update noelle.agent_instances set role='video_intern' where id=${instance}`;
    };
    expect((await post(id, "refine")).status).toBe(409);
  });
  it("returns a durable request receipt and accepts one matching explicit retry", async () => {
    const { id } = await seed();
    const queued = await post(id, "refine");
    expect(queued.status).toBe(200);
    const receipt = (await queued.json()) as { refineRequestId: string };
    expect(receipt.refineRequestId).toBeTruthy();
    const attempts = await Promise.all([
      post(id, "refine", { expectedRequestId: receipt.refineRequestId }),
      post(id, "refine", { expectedRequestId: receipt.refineRequestId }),
    ]);
    expect(attempts.map((r) => r.status).sort()).toEqual([200, 409]);
  });
  it("supports coherent revert and rejects a repeated terminal mutation", async () => {
    const { id, ruleId } = await seed();
    expect((await post(id, "revert")).status).toBe(200);
    expect((await sql`select active from noelle.pattern_rules where id=${ruleId}`)[0]?.active).toBe(
      false,
    );
    expect((await post(id, "refine")).status).toBe(409);
  });
  it("does not enqueue a refinement for an inactive current rule", async () => {
    const { id, ruleId } = await seed();
    await sql`update noelle.pattern_rules set active=false where id=${ruleId}`;
    expect((await post(id, "refine")).status).toBe(409);
  });
  it("does not enqueue a request whose supplied source evidence is unavailable", async () => {
    const { id } = await seed();
    await sql`update noelle.pattern_alerts set examples=${sql.json([{ draftId: "00000000-0000-4000-8000-000000000099", snippet: "stock closer" }])} where id=${id}`;
    expect((await post(id, "refine")).status).toBe(409);
  });

  it("returns bounded visible pages and exact continuation counts", async () => {
    for (let n = 0; n < 5; n++) {
      const { id } = await seed();
      await sql`update noelle.pattern_alerts set created_at=${`2026-10-01T00:00:00.00000${n}Z`}::text::timestamptz where id=${id}`;
    }
    const response = await app.request(`/api/pattern-alerts?instanceId=${instance}&limit=2`);
    const first = (await response.json()) as {
      alerts: { id: string }[];
      nextCursor: unknown;
      total: number;
    };
    expect(response.status).toBe(200);
    expect(first.total).toBe(5);
    expect(first.alerts).toHaveLength(2);
    const next = await app.request(
      `/api/pattern-alerts?instanceId=${instance}&limit=2&cursor=${encodeURIComponent(JSON.stringify(first.nextCursor))}`,
    );
    const second = (await next.json()) as typeof first;
    expect(second.total).toBe(5);
    expect(second.alerts).toHaveLength(2);
    expect(new Set([...first.alerts, ...second.alerts].map((row) => row.id)).size).toBe(4);
  });

  it("includes terminal statuses only in explicitly requested history", async () => {
    for (const status of ["open", "refined", "acknowledged", "reverted"]) {
      const { id } = await seed();
      await sql`update noelle.pattern_alerts set status=${status} where id=${id}`;
    }
    const visible = PatternAlertsPageSchema.parse(
      await (await app.request(`/api/pattern-alerts?instanceId=${instance}`)).json(),
    );
    const history = PatternAlertsPageSchema.parse(
      await (await app.request(`/api/pattern-alerts?instanceId=${instance}&view=history`)).json(),
    );
    expect(visible.total).toBe(2);
    expect(history.total).toBe(4);
    expect(history.alerts.map((row: { status: string }) => row.status).sort()).toEqual([
      "acknowledged",
      "open",
      "refined",
      "reverted",
    ]);
  });

  it.each(["limit=0", "limit=101", "limit=1.5", "cursor=not-json", "view=arbitrary"])(
    "rejects %s before reads",
    async (query) => {
      let authorized = false;
      membership.onCheck = async () => {
        authorized = true;
      };
      const response = await app.request(`/api/pattern-alerts?instanceId=${instance}&${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_page" });
      expect(authorized).toBe(false);
    },
  );

  it("rejects a cursor for another history view before authorization", async () => {
    const cursor = { view: "history", createdAt: "2026-10-01T00:00:00.123456Z", id: instance };
    expect(
      (
        await app.request(
          `/api/pattern-alerts?instanceId=${instance}&cursor=${encodeURIComponent(JSON.stringify(cursor))}`,
        )
      ).status,
    ).toBe(400);
  });
});
