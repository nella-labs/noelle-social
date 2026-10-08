import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import { xDiscovery } from "./x-discovery-api.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const item = {
  tweetId: "1837123456789012345", url: "https://x.com/ada/status/1837123456789012345",
  text: "Useful deployment lessons", authorHandle: "ada",
};

function fakeDb(occupied = 0) {
  const seen = new Set<string>();
  const writes: Array<{ id: string; payload: Record<string, unknown>; query: string }> = [];
  const updated: string[] = [];
  let notices = 0;
  let slots = 0;
  const capacityQueries: Array<{ query: string; values: unknown[] }> = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").toLowerCase();
    if (query.includes("from noelle.agent_instances")) {
      return values[0] === instanceId && values[1] === orgId ? [{ id: instanceId }] : [];
    }
    if (query.includes("insert into noelle.x_discovery_schedule")) return [{ slot_count: String(++slots) }];
    if (query.includes("from noelle.leads l") && query.includes("count(*)")) {
      capacityQueries.push({ query, values });
      return [{ occupied }];
    }
    if (query.includes("from noelle.x_watchlist_people") && query.includes("union all")) {
      return [{ handle: "ada", lastCheckedAt: null, latestObservedPostAt: null }];
    }
    if (query.includes("from noelle.x_watchlist") && query.includes("kind = 'keyword'")) return [];
    if (query.includes("insert into noelle.leads")) {
      const id = values[2] as string;
      if (seen.has(id)) return [];
      seen.add(id);
      writes.push({ id, payload: values[5] as Record<string, unknown>, query });
      return [{ id: "44444444-4444-4444-8444-444444444444" }];
    }
    if (query.includes("update noelle.x_watchlist")) { updated.push(query); return []; }
    if (query.includes("pg_notify")) { notices++; return []; }
    return [];
  }) as unknown as { (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>; json(v: unknown): unknown };
  sql.json = (v) => v;
  return { sql: sql as never, writes, updated, capacityQueries, notices: () => notices, slots: () => slots };
}

describe("X browser discovery API", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = "postgres://test:test@127.0.0.1:5432/test";
    process.env.NOELLE_HMAC_SECRET = "h".repeat(48);
    process.env.NOELLE_ACTUATOR_TOKEN = "actor-test";
    process.env.NOELLE_ACTUATOR_ORG_ID = orgId;
    resetEnvForTests();
    resetDbClientForTests();
  });
  const app = () => new Hono().route("/", xDiscovery);
  const headers = { authorization: "Bearer actor-test", "content-type": "application/json" };
  const observe = (id: string, items: unknown[]) => app().request("/api/x-actuator/observations", {
    method: "POST", headers, body: JSON.stringify({ instanceId: id, items }),
  });

  it("tenant-checks before scheduling or staging", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    expect((await app().request(`/api/x-actuator/discovery-target?instanceId=${otherId}`, { headers })).status).toBe(403);
    expect((await observe(otherId, [item])).status).toBe(403);
    expect(db.slots()).toBe(0);
    expect(db.writes).toHaveLength(0);
  });

  it("returns one watched profile for a durable ambient slot", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const response = await app().request(`/api/x-actuator/discovery-target?instanceId=${instanceId}`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ target: { kind: "profile", handle: "ada" } });
    expect(db.slots()).toBe(1);
    expect(db.updated).toHaveLength(2); // both X handle lists share one cooldown
  });

  it("reports twelve X reply slots and excludes unqualified observations, DMs, and legacy leads", async () => {
    const db = fakeDb(4); __setDbClientForTests(db.sql);
    const response = await app().request(`/api/x-actuator/discovery-capacity?instanceId=${instanceId}`, { headers });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ limit: 12, occupied: 4, available: 8 });
    expect(db.capacityQueries).toHaveLength(1);
    const { query, values } = db.capacityQueries[0]!;
    expect(values).toContain(orgId);
    expect(values).toContain(instanceId);
    expect(values).toContain("x");
    expect(query).toContain("payload->>'source' = 'extension_observed'");
    expect(query).toContain("l.status = 'drafting'");
    expect(query).toContain("a.status = 'pending'");
    expect(query).toContain("d.id = a.draft_id");
    expect(query).toContain("d.org_id = a.org_id");
    expect(query).toContain("a.lead_id = l.id");
    expect(query).toContain("coalesce(d.payload->>'kind', 'reply') = 'reply'");
    expect(query).not.toContain("identity_pending");
    expect(query).not.toContain("observed_classifying");
    expect(query).not.toContain("l.status = 'classified'");
  });

  it("tenant-checks capacity before querying and clamps availability at zero", async () => {
    const db = fakeDb(13); __setDbClientForTests(db.sql);
    expect((await app().request(`/api/x-actuator/discovery-capacity?instanceId=${otherId}`, { headers })).status).toBe(403);
    expect(db.capacityQueries).toHaveLength(0);
    const response = await app().request(`/api/x-actuator/discovery-capacity?instanceId=${instanceId}`, { headers });
    expect(await response.json()).toEqual({ limit: 12, occupied: 13, available: 0 });
  });

  it("deduplicates by tweet ID and stages an observed lead without a classifier claim", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    expect(await (await observe(instanceId, [item, item])).json()).toEqual({ accepted: 1, duplicates: 1, invalid: 0 });
    expect(db.writes).toEqual([expect.objectContaining({
      id: item.tweetId,
      payload: expect.objectContaining({ source: "extension_observed", text: item.text, posted_at: null }),
      query: expect.stringContaining("'observed', true"),
    })]);
    expect(db.writes[0]?.payload).not.toHaveProperty("classifier");
    expect(db.notices()).toBe(1);
  });

  it("rejects unsafe items and batches above 50", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    expect(await (await observe(instanceId, [{ ...item, url: "https://evil.example/ada/status/1837123456789012345" }])).json())
      .toEqual({ accepted: 0, duplicates: 0, invalid: 1 });
    expect((await observe(instanceId, Array(51).fill(item))).status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });

  it("counts a malformed card without discarding a valid card in the same batch", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const response = await observe(instanceId, [{ text: "Missing identity", authorHandle: "ada" }, item]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0, invalid: 1 });
    expect(db.writes).toHaveLength(1);
  });

  it("stages premium X text without truncating it", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const longText = "a".repeat(20_000);
    expect(await (await observe(instanceId, [{ ...item, text: longText }])).json())
      .toEqual({ accepted: 1, duplicates: 0, invalid: 0 });
    expect(db.writes[0]?.payload.text).toBe(longText);
  });
});
