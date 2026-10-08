import postgres, { type Sql } from "postgres";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPgBudgetAdapters, CAP_EXEMPT_ENGINES_APIFY_XAPI } from "./pgBudgetAdapters.js";
import { createPgSpendRecorder } from "./pgSpendRecorder.js";
import { BudgetExceededError, type BudgetAttempt } from "./budgetBucket.js";
import type { SpendRow } from "./spendRecorder.js";
import { callAgentModel, createBudgetedBackend, ModelNotDispatchedError, type EngineBackend } from "./callAgentModel.js";

const url = process.env.NOELLE_BUDGET_ADMISSION_TEST_DATABASE_URL;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
describe.skipIf(!url)("durable budget admission (native PostgreSQL)", () => {
  let sql: Sql, other: Sql, org: string, instance: string, foreignOrg: string, foreignInstance: string;
  beforeAll(async () => {
    sql = postgres(url!, { max: 3, onnotice: () => {} });
    other = postgres(url!, { max: 1, onnotice: () => {} });
    const [db] = await sql`select current_database() as name`;
    if (db?.name !== "noelle_budget_native_test") throw Error("dedicated budget native database required");
    await sql`drop schema if exists noelle cascade`;
    for (const name of ["0001_noelle_schema.sql", "0014_llm_calls_agent_instance_id.sql", "0033_connections_credentials.sql", "0097_budget_cap_pause.sql", "0116_llm_budget_reservations.sql", "0117_llm_cost_basis.sql"]) {
      await sql.unsafe(await readFile(new URL(`../../../infra/cloudsql/schema/${name}`, import.meta.url), "utf8"));
    }
  });
  beforeEach(async () => {
    await sql`truncate noelle.organizations cascade`;
    [org, foreignOrg] = (await sql`insert into noelle.organizations(slug,name) values ('budget_a','A'),('budget_b','B') returning id`).map((r) => r.id);
    [instance, foreignInstance] = (await sql`insert into noelle.agent_instances(org_id,role,budget_cap_cents)
      values (${org},'x_intern',10),(${foreignOrg},'x_intern',10) returning id`).map((r) => r.id);
  });
  afterAll(async () => { await delay(100); await Promise.all([sql?.end({ timeout: 0 }), other?.end({ timeout: 0 })]); });
  const attempt = (overrides: Partial<BudgetAttempt> = {}): BudgetAttempt => ({
    orgId: org, instanceId: instance, agentRole: "x_intern", worker: "drafter", bucket: "drafter",
    engine: "bedrock", model: "claude-sonnet-4-6", estimatedCents: 8, ...overrides,
  });
  const adapters = (parent = sql, deadline = 1000) => createPgBudgetAdapters(parent, { exemptEngines: CAP_EXEMPT_ENGINES_APIFY_XAPI, admissionDeadlineMs: deadline });
  const recorder = (parent = sql) => createPgSpendRecorder(parent, { deadlineMs: 300, idleTimeoutMs: 20, onFailure: () => {} });
  function receipt(attemptId: string, overrides: Partial<SpendRow> = {}): SpendRow {
    return { attemptId, orgId: org, instanceId: instance, agentRole: "x_intern", worker: "drafter", engine: "bedrock",
      model: "claude-sonnet-4-6", bucket: "drafter", inputTokens: 10, outputTokens: 20, cents: 8,
      latencyMs: 1, status: "ok", costBasis: "token_estimate", startedAt: new Date(), ...overrides };
  }
  async function reserve(args = attempt(), parent = sql) { return (await adapters(parent).reserveAttempt!(args)).attemptId; }
  async function tableLock(table: "llm_calls" | "llm_budget_reservations") {
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((r) => { acquired = r; });
    const held = new Promise<void>((r) => { release = r; });
    const tx = sql.begin(async (tx) => { await tx.unsafe(`lock table noelle.${table} in access exclusive mode`); acquired(); await held; });
    await ready; return async () => { release(); await tx; };
  }
  it("serializes independent pools before receipts exist", async () => {
    const outcomes = await Promise.allSettled([reserve(), reserve(attempt(), other)]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected" && r.reason instanceof BudgetExceededError)).toHaveLength(1);
    expect((await sql`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(0);
    expect((await sql`select sum(estimated_cents)::int as held from noelle.llm_budget_reservations`)[0]?.held).toBe(8);
  });
  it("preserves normal eight-way throughput at adequate capacity", async () => {
    await sql`update noelle.agent_instances set budget_cap_cents=100 where id=${instance}`;
    const ids = await Promise.all(Array.from({ length: 8 }, () => reserve()));
    await Promise.all(ids.map((id) => recorder().record(receipt(id))));
    expect((await sql`select count(*)::int as n,sum(cents)::int as cents from noelle.llm_calls`)[0]).toEqual({ n: 8, cents: 64 });
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations where settled_at is null`)[0]?.n).toBe(0);
  });
  it("is idempotent for an identical receipt and rejects identity or charge changes", async () => {
    const id = await reserve(); const row = receipt(id);
    await Promise.all([recorder().record(row), recorder(other).record(row)]);
    expect((await sql`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(1);
    await expect(recorder().record({ ...row, cents: 9 })).rejects.toMatchObject({ category: "database" });
    await expect(recorder().record({ ...row, orgId: foreignOrg, instanceId: foreignInstance })).rejects.toMatchObject({ category: "database" });
    expect((await sql`select sum(cents)::int as cents from noelle.llm_calls`)[0]?.cents).toBe(8);
  });
  it("retains a timeout hold and accounts its estimate without counting the receipt twice", async () => {
    const id = await reserve(); await recorder().record(receipt(id, { status: "timeout", cents: 2 }));
    await expect(reserve(attempt({ estimatedCents: 3 }))).rejects.toMatchObject({ spentCents: 8 });
    expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).toBeNull();
  });
  it("retains unresolved admissions through a period boundary", async () => {
    const id = await reserve();
    await sql`update noelle.llm_budget_reservations set admitted_at=now()-interval '2 months' where id=${id}`;
    await expect(reserve()).rejects.toBeInstanceOf(BudgetExceededError);
  });
  it("allows independent tenants and rejects foreign instance/cap attribution", async () => {
    await reserve(); await reserve(attempt({ orgId: foreignOrg, instanceId: foreignInstance }), other);
    await expect(reserve(attempt({ instanceId: foreignInstance }))).rejects.toMatchObject({ category: "database" });
    await recorder().record(receipt(await reserve(attempt({ estimatedCents: 0 })), { cents: 0 }));
    await expect(adapters().fetchCaps({ orgId: org, instanceId: foreignInstance, bucket: "drafter" }))
      .rejects.toMatchObject({ category: "database" });
  });
  it("retains unresolved organization charges when the hired instance is deleted", async () => {
    const id = await reserve();
    await sql`delete from noelle.agent_instances where id=${instance}`;
    const [held] = await sql`select org_id,agent_instance_id,estimated_cents,settled_at from noelle.llm_budget_reservations where id=${id}`;
    expect(held).toMatchObject({ org_id: org, agent_instance_id: null, estimated_cents: 8, settled_at: null });
    const [replacement] = await sql`insert into noelle.agent_instances(org_id,role,budget_cap_cents) values (${org},'x_intern',10) returning id`;
    await expect(reserve(attempt({ instanceId: replacement!.id }))).rejects.toMatchObject({ spentCents: 8 });
  });
  it("preserves engine exemptions and atomically caps the separate subscription pot", async () => {
    await reserve();
    await reserve(attempt({ engine: "xapi", model: "write" }));
    const codex = attempt({ engine: "codex-cli", model: "gpt-5", engineCapCents: 10 });
    await reserve(codex);
    await expect(reserve(codex)).rejects.toMatchObject({ spentCents: 8, capCents: 10 });
  });
  it("respects temporary common cap pauses without dropping reservations", async () => {
    await reserve(); await sql`update noelle.organizations set budget_cap_paused_until=now()+interval '1 minute' where id=${org}`;
    await reserve();
    await sql`update noelle.organizations set budget_cap_paused_until=now()-interval '1 second' where id=${org}`;
    await expect(reserve()).rejects.toMatchObject({ spentCents: 16 });
  });
  it("checks pause expiry after a contended admission lock is acquired", async () => {
    await reserve();
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((r) => { acquired = r; });
    const held = new Promise<void>((r) => { release = r; });
    const lock = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('llm-budget:' || ${org}::uuid::text,0))`;
      acquired(); await held;
    });
    await ready;
    await sql`update noelle.organizations set budget_cap_paused_until=clock_timestamp()+interval '250 milliseconds' where id=${org}`;
    const pending = reserve(attempt(), other).then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    const safety = setTimeout(release, 800);
    try {
      let blocked = false;
      for (let i = 0; i < 20; i++) {
        const [state] = await sql`select count(*)::int as n from pg_stat_activity
          where datname=current_database() and wait_event='advisory'`;
        if (state?.n > 0) { blocked = true; break; }
        await delay(5);
      }
      expect(blocked).toBe(true);
      await delay(270);
    } finally { clearTimeout(safety); release(); await lock; }
    const result = await pending;
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toBeInstanceOf(BudgetExceededError);
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations`)[0]?.n).toBe(1);
  });
  it("keeps a successful response with unknown cost held for reconciliation", async () => {
    const id = await reserve();
    await recorder().record({ ...receipt(id, { cents: 0 }), costBasis: "unknown" } as SpendRow);
    expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).toBeNull();
    await expect(reserve()).rejects.toMatchObject({ spentCents: 8 });
  });
  it("persists and settles a provider-reported zero without retaining estimated capacity", async () => {
    const id = await reserve();
    await recorder().record({ ...receipt(id, { cents: 0 }), costBasis: "provider_reported" } as SpendRow);
    expect((await sql`select to_jsonb(c)->>'cost_basis' as basis from noelle.llm_calls c where attempt_id=${id}`)[0]?.basis).toBe("provider_reported");
    expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).not.toBeNull();
    await reserve();
  });
  it("rejects an idempotent receipt whose accounting basis changes", async () => {
    const id = await reserve();
    const row = { ...receipt(id), costBasis: "token_estimate" } as SpendRow;
    await recorder().record(row);
    await expect(recorder().record({ ...row, costBasis: "provider_reported" } as SpendRow)).rejects.toMatchObject({ category: "database" });
    expect((await sql`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(1);
  });
  it("retains capacity after an actual successful call returns no usable usage", async () => {
    const result = await callAgentModel({ ...attempt(), system: "system", prompt: "prompt", directRouting: true,
      routing: { primary: { engine: "bedrock", model: "claude-sonnet-4-6" } }, agentRole: "x_intern",
    }, { engines: { bedrock: { call: async () => ({ text: "successful response", usage: undefined }) } as unknown as EngineBackend },
      budget: { adapters: adapters(), estimateCents: () => 8 }, recorder: recorder() });
    expect(result.text).toBe("successful response");
    expect((await sql`select status,cents,input_tokens,output_tokens,cost_basis from noelle.llm_calls`)[0])
      .toEqual({ status: "ok", cents: 0, input_tokens: 0, output_tokens: 0, cost_basis: "unknown" });
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations where settled_at is null`)[0]?.n).toBe(1);
    await expect(reserve()).rejects.toMatchObject({ spentCents: 8 });
  });
  it("supports the pre-provenance schema while retaining an unknown successful hold", async () => {
    const id = await reserve();
    await sql`alter table noelle.llm_calls drop column cost_basis`;
    try {
      const row = receipt(id, { cents: 0, costBasis: "provider_reported" });
      await recorder().record(row);
      await recorder().record(row);
      expect((await sql`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(1);
      expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).toBeNull();
      await expect(reserve()).rejects.toMatchObject({ spentCents: 8 });
    } finally {
      await sql.unsafe(await readFile(new URL("../../../infra/cloudsql/schema/0117_llm_cost_basis.sql", import.meta.url), "utf8"));
    }
    expect((await sql`select cost_basis from noelle.llm_calls where attempt_id=${id}`)[0]?.cost_basis).toBe("unknown");
  });
  it("records confirmed accounting excess over the estimate and blocks subsequent work", async () => {
    const id = await reserve(); await recorder().record(receipt(id, { cents: 12 }));
    await expect(reserve()).rejects.toMatchObject({ spentCents: 12 });
  });
  it.each([false, true])("bounds blocked settlement, keeps the hold, and never writes after returning (refusal=%s)", async (refusal) => {
    const id = await reserve(); const unlock = await tableLock("llm_calls");
    const row = refusal ? refused(id) : receipt(id);
    const safety = setTimeout(() => { void unlock(); }, 1500);
    try {
      const started = performance.now();
      await expect(recorder().record(row)).rejects.toMatchObject({ category: "deadline" });
      expect(performance.now() - started).toBeLessThan(700);
    } finally { clearTimeout(safety); await unlock(); }
    await delay(100);
    expect((await sql`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(0);
    expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).toBeNull();
    await recorder().record(row);
    expect((await sql`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(1);
  });
  it("bounds admission lock wait and creates no reservation after rejection", async () => {
    let release!: () => void, acquired!: () => void;
    const ready = new Promise<void>((r) => { acquired = r; });
    const held = new Promise<void>((r) => { release = r; });
    const tx = sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended('llm-budget:' || ${org}::uuid::text,0))`;
      acquired(); await held;
    });
    await ready; const safety = setTimeout(release, 1500);
    try {
      const started = performance.now();
      await expect(adapters(other, 1000).reserveAttempt!(attempt())).rejects.toMatchObject({ category: "deadline" });
      expect(performance.now() - started).toBeLessThan(1300);
    } finally { clearTimeout(safety); release(); await tx; }
    await delay(100);
    expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations`)[0]?.n).toBe(0);
    await reserve(attempt(), other);
    expect((await other`select 1 as healthy`)[0]?.healthy).toBe(1);
  });
  const refused = (id: string, overrides: Partial<SpendRow> = {}) => receipt(id, {
    status: "error", costBasis: "not_dispatched", inputTokens: 0, outputTokens: 0, cents: 0, latencyMs: null, ...overrides,
  });
  it("atomically settles an identical confirmed refusal once without a charge", async () => {
    const id = await reserve(); const row = refused(id);
    await Promise.all([recorder().record(row), recorder(other).record(row)]);
    expect((await sql`select count(*)::int as n,sum(cents)::int as cents from noelle.llm_calls`)[0]).toEqual({ n: 1, cents: 0 });
    expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).not.toBeNull();
    await reserve();
  });
  it("acknowledges refusal after admission without dispatching a provider", async () => {
    let providers = 0, hooks = 0;
    const options = { engine: "bedrock" as const, context: { ...attempt(), agentRole: "x_intern" as const }, budget: { adapters: adapters(), estimateCents: () => 8 },
      recorder: recorder(), beforeDispatch: async () => {
        hooks++; expect((await sql`select count(*)::int as n from noelle.llm_budget_reservations`)[0]?.n).toBe(1);
        return "not_dispatched" as const;
      } };
    const backend = createBudgetedBackend({ call: async () => { providers++; return { text: "forbidden", usage: { input_tokens: 1, output_tokens: 1 } }; } }, options);
    await expect(backend.call({ system: "system", prompt: "prompt", model: attempt().model })).rejects.toMatchObject({ name: "ModelNotDispatchedError" });
    expect([providers, hooks]).toEqual([0, 1]);
    expect((await sql`select status,cost_basis,input_tokens,output_tokens,cents,latency_ms from noelle.llm_calls`)[0])
      .toEqual({ status: "error", cost_basis: "not_dispatched", input_tokens: 0, output_tokens: 0, cents: 0, latency_ms: null });
    expect((await sql`select settled_at from noelle.llm_budget_reservations`)[0]?.settled_at).not.toBeNull();
  });
  it.each(["thrown", "nominal", "invalid"])("retains an unknown acknowledgement hold with no provider (%s)", async (kind) => {
    let providers = 0, hooks = 0;
    const error = kind === "nominal" ? new ModelNotDispatchedError() : new Error("acknowledgement unavailable");
    const backend = createBudgetedBackend({ call: async () => { providers++; return { text: "forbidden", usage: { input_tokens: 1, output_tokens: 1 } }; } }, {
      engine: "bedrock", context: { ...attempt(), agentRole: "x_intern" }, budget: { adapters: adapters(), estimateCents: () => 8 },
      recorder: recorder(), beforeDispatch: async () => { hooks++; if (kind === "invalid") return undefined as never; throw error; },
    });
    const pending = backend.call({ system: "system", prompt: "prompt", model: attempt().model });
    if (kind === "invalid") await expect(pending).rejects.toThrow("Invalid model dispatch acknowledgement");
    else await expect(pending).rejects.toBe(error);
    expect([providers, hooks]).toEqual([0, 1]);
    expect((await sql`select status,cost_basis,input_tokens,output_tokens,cents,latency_ms from noelle.llm_calls`)[0])
      .toEqual({ status: "error", cost_basis: "unknown", input_tokens: 0, output_tokens: 0, cents: 0, latency_ms: null });
    expect((await sql`select settled_at from noelle.llm_budget_reservations`)[0]?.settled_at).toBeNull();
    await expect(reserve()).rejects.toMatchObject({ spentCents: 8 });
  });
  it.each([
    { status: "ok" as const }, { status: "timeout" as const }, { inputTokens: 1 },
    { outputTokens: 1 }, { cents: 1 }, { latencyMs: 0 },
  ])("rejects inconsistent not-dispatched accounting and rolls back (%j)", async (overrides) => {
    const id = await reserve();
    await expect(recorder().record(refused(id, overrides))).rejects.toMatchObject({ category: "database" });
    expect((await sql`select count(*)::int as n from noelle.llm_calls where attempt_id=${id}`)[0]?.n).toBe(0);
    expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).toBeNull();
  });
  it.each([
    "orgId", "instanceId", "agentRole", "worker", "engine", "model", "bucket",
  ] as const)("rejects a confirmed refusal with a mismatched %s", async (key) => {
    const id = await reserve();
    const foreign = { orgId: foreignOrg, instanceId: foreignInstance, agentRole: "linkedin_intern", worker: "briefer",
      engine: "vertex", model: "gemini-2-5-flash", bucket: "ideation" };
    await expect(recorder().record({ ...refused(id), [key]: foreign[key] } as SpendRow)).rejects.toMatchObject({ category: "database" });
    expect((await sql`select count(*)::int as n from noelle.llm_calls`)[0]?.n).toBe(0);
    expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).toBeNull();
  });
  it("rolls back receipt insertion when confirmed refusal settlement fails", async () => {
    const id = await reserve();
    await sql.unsafe(`create function noelle.reject_settlement() returns trigger language plpgsql as $$ begin raise exception 'blocked' using errcode='23514'; end $$;
      create trigger reject_settlement before update of settled_at on noelle.llm_budget_reservations for each row execute function noelle.reject_settlement()`);
    try {
      await expect(recorder().record(refused(id))).rejects.toMatchObject({ category: "database" });
    } finally {
      await sql.unsafe("drop trigger reject_settlement on noelle.llm_budget_reservations; drop function noelle.reject_settlement()");
    }
    expect((await sql`select count(*)::int as n from noelle.llm_calls where attempt_id=${id}`)[0]?.n).toBe(0);
    expect((await sql`select settled_at from noelle.llm_budget_reservations where id=${id}`)[0]?.settled_at).toBeNull();
  });
});
