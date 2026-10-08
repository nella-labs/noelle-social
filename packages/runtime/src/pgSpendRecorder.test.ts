import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { SpendRow } from "./spendRecorder.js";
import { createPgSpendRecorder } from "./pgSpendRecorder.js";

const driver = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("postgres", () => ({ default: driver.create }));

const row: SpendRow = {
  orgId: "org_1", instanceId: "inst_1", agentRole: "x_intern", worker: "drafter",
  engine: "bedrock", model: "model_name", bucket: "drafter-codex",
  inputTokens: 1234, outputTokens: 567, cents: 4, latencyMs: 1820, status: "ok",
  startedAt: new Date("2026-05-26T19:45:00Z"),
};
function parentSql() {
  return Object.assign(vi.fn(), { options: {
    host: ["host_a", "host_b"], port: [5432, 5433], database: "database", user: "user",
    pass: vi.fn(async () => "credential_value"), ssl: { rejectUnauthorized: true },
    shared: { retries: 4, typeArrayMap: {} }, parameters: {}, connect_timeout: 30,
    connection: { application_name: "intern", timezone: "UTC", statement_timeout: "50ms", lock_timeout: 25 },
    debug: vi.fn(), prepare: true, max: 5, max_pipeline: 100,
  } }) as unknown as Sql;
}
function ownedSql() {
  return Object.assign(vi.fn().mockResolvedValue([]), {
    json: (value: unknown) => value, end: vi.fn().mockResolvedValue(undefined),
  });
}
let owned: ReturnType<typeof ownedSql>;
beforeEach(() => {
  owned = ownedSql(); driver.create.mockReset(); driver.create.mockReturnValue(owned);
});
afterEach(() => { vi.useRealTimers(); });

const options = () => ({ idleTimeoutMs: 1, onFailure: vi.fn() });

describe("createPgSpendRecorder", () => {
  it("writes exact attribution and charge bindings on its owned pool", async () => {
    const parent = parentSql();
    await createPgSpendRecorder(parent, options()).record(row);
    expect(owned.mock.calls).toHaveLength(1);
    expect(owned.mock.calls[0]!.slice(1)).toEqual([{
      org_id: "org_1", agent_instance_id: "inst_1", agent_role: "x_intern", worker: "drafter",
      engine: "bedrock", model: "model_name", bucket: "drafter-codex", input_tokens: 1234,
      output_tokens: 567, cents: 4, latency_ms: 1820, status: "ok", started_at: row.startedAt.toISOString(),
      credential_id: null, attempt_id: null, cost_basis: "unknown",
    }]);
    expect(parent).not.toHaveBeenCalled();
  });

  it("shares a writer across recorders on the same parent without sharing driver state", async () => {
    const parent = parentSql();
    await Promise.all([createPgSpendRecorder(parent, options()).record(row), createPgSpendRecorder(parent, options()).record(row)]);
    expect(owned.mock.calls).toHaveLength(2);
    expect(driver.create).toHaveBeenCalledTimes(1);
    expect(driver.create.mock.calls[0]![0].shared).not.toBe((parent.options as unknown as { shared: unknown }).shared);
  });

  it("preserves connection/auth selection and suppresses query debug output", async () => {
    const parent = parentSql();
    await createPgSpendRecorder(parent, options()).record(row);
    const copied = driver.create.mock.calls[0]![0];
    expect(copied.host).toEqual(["host_a", "host_b"]);
    expect(copied.port).toEqual([5432, 5433]);
    expect(copied.pass).toBe(parent.options.pass);
    expect(copied.ssl).toBe(parent.options.ssl);
    expect(copied.connection.timezone).toBe("UTC");
    expect(copied.connection.application_name).toBe("intern");
    expect(copied.connection.statement_timeout).toBe(50);
    expect(copied.connection.lock_timeout).toBe(25);
    expect(copied.debug).toBe(false);
    expect(copied.max).toBe(1);
    expect(copied.max_pipeline).toBe(1);
    expect(parent.options.max).toBe(5);
  });

  it("rejects database failures with sanitized context even when the consumer catches", async () => {
    owned.mockRejectedValue(Object.assign(new Error("sensitive database detail"), { code: "23514", query: "private query", parameters: ["secret"] }));
    const opts = options(); const error = await createPgSpendRecorder(parentSql(), opts).record(row).catch((e: unknown) => e);
    expect(error).toMatchObject({ name: "SpendRecordingError", category: "database" });
    expect(error).not.toHaveProperty("cause");
    expect(opts.onFailure).toHaveBeenCalledWith({ category: "database", orgId: "org_1", instanceId: "inst_1", agentRole: "x_intern", worker: "drafter", engine: "bedrock" });
    expect(JSON.stringify(opts.onFailure.mock.calls)).not.toContain("secret");
    expect(owned.end).toHaveBeenCalled();
  });

  it("keeps the failure visible when the reporting callback throws", async () => {
    owned.mockRejectedValue(new Error("connection refused"));
    await expect(createPgSpendRecorder(parentSql(), { onFailure: () => { throw Error("reporter failed"); } }).record(row))
      .rejects.toMatchObject({ category: "connection" });
  });

  it("never creates queries for receipts that expired in the admission queue", async () => {
    vi.useFakeTimers();
    let rejectWrite!: (e: unknown) => void;
    owned.mockImplementation(() => new Promise((_, reject) => { rejectWrite = reject; }));
    owned.end.mockImplementation(async () => { rejectWrite(new Error("connection destroyed")); });
    const recorder = createPgSpendRecorder(parentSql(), { ...options(), deadlineMs: 100, maxPending: 3 });
    const settled = Promise.allSettled([recorder.record(row), recorder.record(row), recorder.record(row)]);
    await vi.advanceTimersByTimeAsync(101);
    const outcomes = await settled;
    expect(owned.mock.calls).toHaveLength(1);
    expect(outcomes.every((x) => x.status === "rejected" && x.reason.category === "deadline")).toBe(true);
  });

  it("preserves all status variants and credential attribution", async () => {
    const recorder = createPgSpendRecorder(parentSql(), options());
    for (const status of ["ok", "error", "timeout", "budget_exceeded"] as const) {
      await recorder.record({ ...row, status, credentialId: "credential_id" });
    }
    expect(owned.mock.calls.map((call) => call[1].status)).toEqual(["ok", "error", "timeout", "budget_exceeded"]);
    expect(owned.mock.calls.every((call) => call[1].credential_id === "credential_id")).toBe(true);
  });
});
