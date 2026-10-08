import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import { actuator } from "./actuator.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const approved = {
  approval_id: "33333333-3333-4333-8333-333333333333",
  draft_id: "44444444-4444-4444-8444-444444444444",
  lead_id: "55555555-5555-4555-8555-555555555555",
  draft_payload: { kind: "reply", body: "Concrete reply", verifier_meta: {
    pass: true, judgeOk: true, scores: { voice: 0.9, grounding: 0.9, relevance: 0.9, format: 0.9 },
  } },
  lead_payload: { source: "extension_observed", classifier: { judge: "jev" }, posted_at: "2026-09-15T12:00:00Z" },
  author_handle: "ada", external_id: "1837123456789012345", auto_send_target_at: null,
};

describe("X priority-ready GET", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = "postgres://test:test@127.0.0.1:5432/test";
    process.env.NOELLE_HMAC_SECRET = "h".repeat(48);
    process.env.NOELLE_ACTUATOR_TOKEN = "actor-test";
    process.env.NOELLE_ACTUATOR_ORG_ID = orgId;
    resetEnvForTests(); resetDbClientForTests();
  });

  it("serves only reviewed Jev observations through a read-only query", async () => {
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.reduce((out, part, i) => out + part +
        (i < values.length ? typeof values[i] === "string" && values[i].includes("l.payload->>") ? values[i] : "?" : ""), "").toLowerCase();
      if (strings.join("?").includes("and l.payload->>'source'")) return query;
      queries.push(query);
      if (query.includes("from noelle.agent_instances")) return [{ id: instanceId, reply_send_enabled: true, auto_send_enabled: false }];
      if (query.includes("select distinct tweet_id")) return [];
      if (query.includes("from noelle.approvals a") && query.includes("join noelle.drafts d")) return [
        approved,
        { ...approved, approval_id: "66666666-6666-4666-8666-666666666666", lead_payload: { source: "apify", classifier: { judge: "jev" } } },
        { ...approved, approval_id: "77777777-7777-4777-8777-777777777777", lead_payload: { source: "extension_observed", classifier: { judge: "legacy" } } },
      ];
      if (query.includes("select count(*)")) return [{ n: 0 }];
      return [];
    }) as never;
    Object.assign(sql, { unsafe: (fragment: string) => fragment, begin: (fn: (tx: unknown) => Promise<unknown>) => fn(sql) });
    __setDbClientForTests(sql);
    const res = await new Hono().route("/", actuator).request(`/api/actionable-x/priority-ready?instanceId=${instanceId}`, {
      headers: { authorization: "Bearer actor-test" },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { replies: unknown[] };
    expect(body.replies).toEqual([expect.objectContaining({ approval_id: approved.approval_id })]);
    const queueQuery = queries.find((q) => q.includes("a.auto_send_target_at is null"))!;
    expect(queueQuery).toMatch(/l\.payload->>'source' = 'extension_observed'/);
    expect(queueQuery).toMatch(/l\.payload->'classifier'->>'judge' = 'jev'/);
    expect(queries.some(query => /verifier_meta'->'judgeok' = 'true'::jsonb/.test(query))).toBe(true);
    const ageFragment = queries.find((q) => q.includes("source' = 'extension_observed'") && q.includes("is null") && q.includes(" >= "))!;
    expect(ageFragment).toMatch(/source' = 'extension_observed'/);
    expect(ageFragment).toMatch(/classifier'->>'judge' = 'jev'/);
    expect(queries.every((q) => !/\b(insert|update|delete)\b/.test(q))).toBe(true);
  });
});
