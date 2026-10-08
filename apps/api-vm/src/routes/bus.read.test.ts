import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "../middleware/jwt.js";

const fixtures = vi.hoisted(() => ({
  member: vi.fn(),
  queries: [] as Array<{ text: string; values: unknown[] }>,
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock("../lib/auth.js", () => ({ isOrgMember: fixtures.member }));
vi.mock("../lib/db.js", () => ({ noelleDb: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
  const text = strings.join("?");
  fixtures.queries.push({ text, values });
  return Promise.resolve(fixtures.rows);
} }));
import { busRead } from "./bus.js";

const org = "11111111-1111-4111-8111-111111111111";
const instance = "22222222-2222-4222-8222-222222222222";
const invalidIdentityQueries: Array<Record<string, string>> = [
  { org_id: "invalid" },
  { agent_instance_id: "invalid" },
];
const app = new Hono<{ Variables: { auth: AuthContext } }>();
app.use("*", async (c, next) => { c.set("auth", { userId: "reader" } as AuthContext); await next(); });
app.route("/", busRead);
const request = (params: Record<string, string> = {}) =>
  app.request(`/api/bus/events?${new URLSearchParams({ org_id: org, ...params })}`);

beforeEach(() => {
  fixtures.member.mockReset().mockResolvedValue(true);
  fixtures.queries.length = 0;
  fixtures.rows = [];
});

describe("bus event read query contract", () => {
  it.each(["NaN", "garbage", "1.5", "Infinity"])("rejects invalid limit %j before storage", async limit => {
    const response = await request({ limit });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_query" });
    expect(fixtures.queries).toHaveLength(0);
  });
  it.each(invalidIdentityQueries)("rejects invalid identity %j before membership and storage", async query => {
    expect((await request(query)).status).toBe(400);
    expect(fixtures.member).not.toHaveBeenCalled();
    expect(fixtures.queries).toHaveLength(0);
  });
  it("retains the default100 and maps the existing wire fields", async () => {
    fixtures.rows = [{ id: instance, org_id: org, agent_role: "system", topic: "worker.error",
      severity: "warn", created_at: new Date("2026-01-01T00:00:00Z") }];
    const response = await request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [{ id: instance, org_id: org,
      agent_instance_id: null, agent_role: "system", worker: null, topic: "worker.error",
      severity: "warn", summary: null, payload: {}, correlation_id: null,
      created_at: "2026-01-01T00:00:00.000Z" }] });
    expect(fixtures.queries.at(-1)?.values.at(-1)).toBe(100);
    expect(fixtures.member).toHaveBeenCalledWith("reader", org);
  });
  it("retains explicit valid filters and the500 maximum", async () => {
    expect((await request({ limit: "500", topic: "worker.error", agent_instance_id: instance })).status).toBe(200);
    expect(fixtures.queries.at(-1)?.values.at(-1)).toBe(500);
    expect(fixtures.queries.flatMap(query => query.values)).toContain(instance);
    expect(fixtures.queries.flatMap(query => query.values)).toContain("worker.error");
  });
  it("denies a nonmember before reading event storage", async () => {
    fixtures.member.mockResolvedValue(false);
    expect((await request()).status).toBe(403);
    expect(fixtures.queries).toHaveLength(0);
  });
  it("rejects invalid state scope before membership and storage", async () => {
    expect((await app.request("/api/bus/state?org_id=invalid")).status).toBe(400);
    expect(fixtures.member).not.toHaveBeenCalled();
    expect(fixtures.queries).toHaveLength(0);
  });
  it("retains state membership and empty bucket reads", async () => {
    const response = await app.request(`/api/bus/state?org_id=${org}&bucket=worker_status`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ entries: [] });
    expect(fixtures.member).toHaveBeenCalledWith("reader", org);
    expect(fixtures.queries.flatMap(query => query.values)).toContain("worker_status");
  });
});
