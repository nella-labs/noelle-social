import { describe, it, expect, vi } from "vitest";
import { createBus } from "./bus.js";
import type { QueryExecutor } from "./tenancy.js";

/** A QueryExecutor that records calls and returns a fixed result set. */
function recorder(result: Record<string, unknown>[] = []) {
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = [];
  const exec: QueryExecutor = async (sql, params) => {
    calls.push({ sql, params });
    return result;
  };
  return { exec, calls };
}

describe("createBus.emit", () => {
  it("writes a bus_events row with the bound scope + payload", async () => {
    const { exec, calls } = recorder();
    const bus = createBus({ exec, orgId: "org-1", agentInstanceId: "inst-1", agentRole: "x_intern" });
    await bus.emit({
      topic: "lead.discovered",
      worker: "discovery",
      summary: "discovered @ada",
      payload: { lead_id: "L1" },
      correlationId: "L1",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("insert into noelle.bus_events");
    expect(calls[0]!.params).toEqual([
      "org-1",
      "inst-1",
      "x_intern",
      "discovery",
      "lead.discovered",
      "info",
      "discovered @ada",
      { lead_id: "L1" }, // raw object — postgres.js serializes to jsonb
      "L1",
    ]);
  });

  it("defaults severity=info, role=system, and nulls the optional fields", async () => {
    const { exec, calls } = recorder();
    const bus = createBus({ exec, orgId: "o" });
    await bus.emit({ topic: "worker.error" });
    expect(calls[0]!.params).toEqual(["o", null, "system", null, "worker.error", "info", null, {}, null]);
  });

  it("is FAIL-SOFT — a throwing exec is swallowed, not propagated", async () => {
    const err = new Error("db down");
    const exec: QueryExecutor = async () => {
      throw err;
    };
    const onError = vi.fn();
    const bus = createBus({ exec, orgId: "o", onError });
    await expect(bus.emit({ topic: "t" })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("emit", err);
  });
});

describe("createBus.put", () => {
  it("upserts and bumps version on conflict", async () => {
    const { exec, calls } = recorder();
    const bus = createBus({ exec, orgId: "o", agentInstanceId: "i" });
    await bus.put("worker_status", "discovery", { state: "running" }, { worker: "discovery" });
    expect(calls[0]!.sql).toContain("on conflict (org_id, bucket, key) do update");
    expect(calls[0]!.sql).toContain("noelle.bus_state.version + 1");
    expect(calls[0]!.params).toEqual([
      "o",
      "worker_status",
      "discovery",
      { state: "running" }, // raw object — postgres.js serializes to jsonb
      "i",
      "discovery",
      null,
    ]);
  });

  it("passes ttlSeconds through for the expiry clause", async () => {
    const { exec, calls } = recorder();
    const bus = createBus({ exec, orgId: "o" });
    await bus.put("pipeline", "k", { v: 1 }, { ttlSeconds: 60 });
    expect(calls[0]!.params[6]).toBe(60);
  });

  it("is FAIL-SOFT — a throwing exec is swallowed", async () => {
    const exec: QueryExecutor = async () => {
      throw new Error("nope");
    };
    const onError = vi.fn();
    const bus = createBus({ exec, orgId: "o", onError });
    await expect(bus.put("b", "k", { v: 1 })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("put", expect.any(Error));
  });
});

describe("createBus reads", () => {
  it("rejects a NaN event limit before querying storage", async () => {
    const { exec, calls } = recorder();
    const bus = createBus({ exec, orgId: "o" });
    await expect(bus.tail({ limit: NaN })).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it.each([[undefined, 50], [0, 1], [1.9, 1], [900, 500]] as const)(
    "retains finite event limit normalization %j", async (limit, expected) => {
      const { exec, calls } = recorder();
      const bus = createBus({ exec, orgId: "o" });
      await bus.tail(limit === undefined ? undefined : { limit });
      expect(calls[0]!.sql).toContain(`limit ${expected}`);
    },
  );

  it("get returns the parsed value, handling both object and string jsonb", async () => {
    const objBus = createBus({ exec: recorder([{ value: { k: 1 } }]).exec, orgId: "o" });
    expect(await objBus.get("b", "k")).toEqual({ k: 1 });

    const strBus = createBus({ exec: recorder([{ value: '{"k":2}' }]).exec, orgId: "o" });
    expect(await strBus.get("b", "k")).toEqual({ k: 2 });
  });

  it("get returns null when the key is absent", async () => {
    const bus = createBus({ exec: recorder([]).exec, orgId: "o" });
    expect(await bus.get("b", "missing")).toBeNull();
  });

  it("list coerces the bigint version (string) to a number", async () => {
    const { exec } = recorder([
      {
        bucket: "worker_status",
        key: "discovery",
        value: { state: "idle" },
        version: "7", // postgres.js returns bigint as a string
        updated_by_worker: "discovery",
        updated_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    const bus = createBus({ exec, orgId: "o" });
    const rows = await bus.list("worker_status");
    expect(rows[0]!.version).toBe(7);
    expect(typeof rows[0]!.version).toBe("number");
    expect(rows[0]!.updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("tail maps events and applies the topic filter + limit", async () => {
    const { exec, calls } = recorder([
      {
        id: "e1",
        agent_instance_id: null,
        agent_role: "system",
        worker: null,
        topic: "worker.error",
        severity: "error",
        summary: "boom",
        payload: {},
        correlation_id: null,
        created_at: new Date("2026-01-01T00:00:00Z"),
      },
    ]);
    const bus = createBus({ exec, orgId: "o" });
    const rows = await bus.tail({ topic: "worker.error", limit: 10 });
    expect(calls[0]!.params).toEqual(["o", "worker.error"]);
    expect(calls[0]!.sql).toContain("limit 10");
    expect(rows[0]).toMatchObject({
      id: "e1",
      topic: "worker.error",
      severity: "error",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});
