import { pngImageBytes } from "../imageBytes.fixture.js";
import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY_XAPI } from "../pgBudgetAdapters.js";
import { createPgSpendRecorder } from "../pgSpendRecorder.js";
import { BudgetExceededError } from "../budgetBucket.js";
import { captionImages, createGeminiCaptionFn, createVertexCaptionFn, createBedrockCaptionFn } from "./visionCaption.js";

const url = process.env.NOELLE_VISION_METERING_TEST_DATABASE_URL;
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
describe.skipIf(!url)("caption durable admission (native PostgreSQL)", () => {
  let sql: Sql, other: Sql, org: string, instance: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 3, onnotice: () => {} });
    other = postgres(url!, { max: 1, onnotice: () => {} });
    if ((await sql`select current_database() as name`)[0]?.name !== "noelle_vision_metering_test") {
      throw Error("dedicated vision metering native database required");
    }
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0014_llm_calls_agent_instance_id.sql", "0033_connections_credentials.sql",
      "0097_budget_cap_pause.sql", "0116_llm_budget_reservations.sql", "0117_llm_cost_basis.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    org = (await sql`insert into noelle.organizations(slug,name) values ('vision','Vision') returning id`)[0]!.id;
    instance = (await sql`insert into noelle.agent_instances(org_id,role,budget_cap_cents)
      values (${org},'x_intern',1) returning id`)[0]!.id;
  });
  afterAll(async () => { await delay(50); await Promise.all([sql?.end({ timeout: 0 }), other?.end({ timeout: 0 })]); });

  function setup(kind: "key" | "vertex" | "bedrock", parent = sql, outcome: "ok" | "unknown" | "failure" = "ok") {
    let paid = 0;
    const metering = { context: { orgId: org, instanceId: instance, agentRole: "x_intern" as const,
      worker: "drafter", bucket: "vision_caption" },
      budget: { adapters: createPgBudgetAdapters(parent, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI }) },
      recorder: createPgSpendRecorder(parent, { deadlineMs: 500, idleTimeoutMs: 20, onFailure: () => {} }) };
    const paidResult = async () => { paid++; await delay(10); if (outcome === "failure") throw Error("transport interrupted"); };
    const fetchImpl: typeof fetch = async (input) => {
      if (String(input).startsWith("https://image.test")) return new Response(pngImageBytes());
      await paidResult();
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "caption" }] } }],
        ...(outcome !== "unknown" ? { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } } : {}) }));
    };
    const captionFn = kind === "key" ? createGeminiCaptionFn({ apiKey: "test", fetchImpl, metering })
      : kind === "vertex" ? createVertexCaptionFn({ project: "test", fetchImpl, metering,
        authClient: { getAccessToken: async () => "test" } })
      : createBedrockCaptionFn({ fetchImpl, metering, clientImpl: { create: async () => {
        await paidResult(); return { content: [{ type: "text", text: "caption" }],
          ...(outcome !== "unknown" ? { usage: { input_tokens: 100, output_tokens: 20 } } : {}) };
      } } });
    return { captionFn, paid: () => paid, call: () => captionImages({ imageUrls: ["https://image.test/a.jpg"], captionFn }) };
  }

  it.each(["key", "vertex", "bedrock"] as const)("%s serializes independent workers before paid dispatch", async (kind) => {
    const a = setup(kind), b = setup(kind, other);
    const results = await Promise.allSettled([a.call(), b.call()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && r.reason instanceof BudgetExceededError)).toHaveLength(1);
    expect(a.paid() + b.paid()).toBe(1);
    expect((await sql`select count(*)::int as n from noelle.llm_calls where status='ok'`)[0]?.n).toBe(1);
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations where settled_at is null`)[0]?.n).toBe(0);
  });

  it.each(["key", "vertex", "bedrock"] as const)("%s refuses an already exhausted cap without paid dispatch", async (kind) => {
    await sql`update noelle.agent_instances set budget_cap_cents=0 where id=${instance}`;
    const s = setup(kind);
    await expect(s.call()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(s.paid()).toBe(0);
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations`)[0]?.n).toBe(0);
    expect((await sql`select status,cost_basis,cents from noelle.llm_calls`)[0])
      .toEqual({ status: "budget_exceeded", cost_basis: "not_dispatched", cents: 0 });
  });

  it.each(["key", "vertex", "bedrock"] as const)("%s retains unknown successful usage as held capacity", async (kind) => {
    const first = setup(kind, sql, "unknown");
    expect(await first.call()).toBe("caption");
    const next = setup(kind, other);
    await expect(next.call()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(next.paid()).toBe(0);
    expect((await sql`select status,cents,cost_basis from noelle.llm_calls where status='ok'`)[0])
      .toEqual({ status: "ok", cents: 0, cost_basis: "unknown" });
    expect((await sql`select estimated_cents,settled_at from noelle.llm_budget_reservations`)[0])
      .toMatchObject({ estimated_cents: 1, settled_at: null });
  });

  it.each(["key", "vertex", "bedrock"] as const)("%s records dispatched failure and retains its hold", async (kind) => {
    const first = setup(kind, sql, "failure");
    expect(await first.call()).toBe("");
    const next = setup(kind, other);
    await expect(next.call()).rejects.toBeInstanceOf(BudgetExceededError);
    expect(next.paid()).toBe(0);
    expect((await sql`select status,cost_basis from noelle.llm_calls where status='error'`)[0])
      .toEqual({ status: "error", cost_basis: "failure_estimate" });
    expect((await sql`select settled_at from noelle.llm_budget_reservations`)[0]?.settled_at).toBeNull();
  });

  it("preserves eight-way normal capacity and coherent receipt attribution", async () => {
    await sql`update noelle.agent_instances set budget_cap_cents=20 where id=${instance}`;
    const calls = Array.from({ length: 8 }, (_, i) => setup("key", i % 2 ? other : sql));
    expect(await Promise.all(calls.map((c) => c.call()))).toEqual(Array(8).fill("caption"));
    expect(calls.reduce((n, c) => n + c.paid(), 0)).toBe(8);
    expect((await sql`select count(*)::int as n,sum(cents)::int as cents from noelle.llm_calls
      where org_id=${org} and agent_instance_id=${instance} and worker='drafter' and bucket='vision_caption'
        and engine='vertex' and model='gemini-2-5-flash' and cost_basis='token_estimate' and status='ok'`)[0])
      .toEqual({ n: 8, cents: 8 });
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations where settled_at is null`)[0]?.n).toBe(0);
  });

  it("includes all three bounded prepared images in estimated admission capacity", async () => {
    let paid = 0;
    const captionFn = createGeminiCaptionFn({ apiKey: "test", metering: {
      context: { orgId: org, instanceId: instance, agentRole: "x_intern", worker: "drafter", bucket: "vision_caption" },
      budget: { adapters: createPgBudgetAdapters(sql, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI }) },
      recorder: createPgSpendRecorder(sql),
    }, fetchImpl: async (input) => {
      if (!String(input).startsWith("https://image.test")) { paid++; throw Error("unexpected paid dispatch"); }
      return new Response(pngImageBytes(5 * 1024 * 1024));
    } });
    await expect(captionImages({ imageUrls: ["https://image.test/1.jpg", "https://image.test/2.jpg", "https://image.test/3.jpg"], captionFn }))
      .rejects.toMatchObject({ name: "BudgetExceededError", estimatedCents: expect.any(Number) });
    expect(paid).toBe(0);
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations`)[0]?.n).toBe(0);
  });
});
