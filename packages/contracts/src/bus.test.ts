import { describe, it, expect } from "vitest";
import {
  BusEventSchema,
  BusStateEntrySchema,
  BusEventsQuerySchema,
  BusEmitInSchema,
  BusPutInSchema,
} from "./bus.js";

const ORG = "00000000-0000-0000-0000-000000000001";
const INST = "00000000-0000-0000-0000-000000000002";
const TS = "2026-01-01T00:00:00.000Z";

describe("BusEventSchema", () => {
  it("round-trips a full event", () => {
    const e = BusEventSchema.parse({
      id: ORG,
      org_id: ORG,
      agent_instance_id: INST,
      agent_role: "x_intern",
      worker: "discovery",
      topic: "lead.discovered",
      severity: "info",
      summary: "discovered @ada",
      payload: { lead_id: "L1" },
      correlation_id: "L1",
      created_at: TS,
    });
    expect(e.topic).toBe("lead.discovered");
    expect(e.severity).toBe("info");
  });

  it("accepts a null instance + null worker (org-level/system event)", () => {
    const e = BusEventSchema.parse({
      id: ORG,
      org_id: ORG,
      agent_instance_id: null,
      agent_role: "system",
      worker: null,
      topic: "worker.error",
      severity: "error",
      summary: null,
      payload: {},
      correlation_id: null,
      created_at: TS,
    });
    expect(e.agent_instance_id).toBeNull();
  });

  it("rejects an out-of-range severity", () => {
    expect(
      BusEventSchema.safeParse({
        id: ORG,
        org_id: ORG,
        agent_instance_id: null,
        agent_role: "system",
        worker: null,
        topic: "t",
        severity: "fatal",
        summary: null,
        payload: {},
        correlation_id: null,
        created_at: TS,
      }).success,
    ).toBe(false);
  });
});

describe("BusStateEntrySchema", () => {
  it("requires version to be a number (bigint is coerced before parse)", () => {
    const ok = BusStateEntrySchema.safeParse({
      org_id: ORG,
      bucket: "worker_status",
      key: "discovery",
      value: { state: "idle" },
      version: 7,
      updated_by_instance_id: INST,
      updated_by_worker: "discovery",
      expires_at: null,
      updated_at: TS,
    });
    expect(ok.success).toBe(true);
    expect(
      BusStateEntrySchema.safeParse({
        org_id: ORG,
        bucket: "b",
        key: "k",
        value: 1,
        version: "7", // raw bigint string must be coerced first
        updated_by_instance_id: null,
        updated_by_worker: null,
        expires_at: null,
        updated_at: TS,
      }).success,
    ).toBe(false);
  });
});

describe("query + write schemas", () => {
  it("coerces the events limit and applies the default", () => {
    expect(BusEventsQuerySchema.parse({ org_id: ORG, limit: "25" }).limit).toBe(25);
    expect(BusEventsQuerySchema.parse({ org_id: ORG }).limit).toBe(100);
  });

  it("defaults emit severity + payload", () => {
    const e = BusEmitInSchema.parse({ org_id: ORG, agent_role: "x_intern", topic: "t" });
    expect(e.severity).toBe("info");
    expect(e.payload).toEqual({});
  });

  it("accepts a put with a ttl", () => {
    const p = BusPutInSchema.parse({ org_id: ORG, bucket: "b", key: "k", value: { a: 1 }, ttl_seconds: 60 });
    expect(p.ttl_seconds).toBe(60);
  });
});
