import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { __setDbClientForTests, resetDbClientForTests } from "../lib/db.js";
import { resetEnvForTests } from "../env.js";
import { linkedinDiscovery } from "./linkedin-discovery-api.js";

const orgId = "11111111-1111-4111-8111-111111111111";
const instanceId = "22222222-2222-4222-8222-222222222222";
const otherId = "33333333-3333-4333-8333-333333333333";
const url = "https://www.linkedin.com/posts/ada_activity-7481524546924343296-abc";
type FakeLead = { id: string; externalId: string; status: string; payload: Record<string, unknown> };

function fakeDb(occupied = 0) {
  const seen = new Set<string>();
  const writes: Array<{ id: string; status: unknown; priority: unknown; payload: unknown }> = [];
  const rows = new Map<string, FakeLead>();
  const inserts: string[] = [];
  let notices = 0;
  let slots = 0;
  let revisitWrites = 0;
  const targetQueries: Array<{ query: string; values: unknown[] }> = [];
  const capacityQueries: Array<{ query: string; values: unknown[] }> = [];
  const sql = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").toLowerCase();
    if (query.includes("from noelle.agent_instances")) {
      return values[0] === instanceId && values[1] === orgId ? [{ id: instanceId }] : [];
    }
    if (query.includes("from noelle.leads l") && query.includes("count(*)")) {
      capacityQueries.push({ query, values });
      return [{ occupied }];
    }
    if (query.includes("insert into noelle.linkedin_discovery_schedule")) return [{ slot_count: String(++slots) }];
    if (query.includes("from noelle.linkedin_watchlist_people") || query.includes("from noelle.linkedin_watchlist")) return [];
    if (query.includes("from noelle.leads") && query.includes("group by lower(author_handle)")) {
      targetQueries.push({ query, values });
      const grouped = new Map<string, FakeLead[]>();
      for (const row of rows.values()) {
        if (row.status !== "identity_pending" || row.payload.source !== "extension_observed" ||
            (row.payload.classifier as { provider?: string } | undefined)?.provider !== "jev") continue;
        const handle = (row.payload.authorPublicId as string).toLowerCase();
        grouped.set(handle, [...(grouped.get(handle) ?? []), row]);
      }
      return [...grouped].map(([publicId, leads]) => ({
        publicId,
        lastCheckedAt: leads.map((row) => row.payload.identity_revisit_at as string | undefined).filter(Boolean).sort().at(-1) ?? null,
        latestPendingAt: "2026-09-19T11:50:00Z",
      }));
    }
    if (query.includes("update noelle.leads") && query.includes("lower(author_handle) = lower(")) {
      const publicId = values.at(-1) as string;
      const marked = [...rows.values()].filter((row) => row.status === "identity_pending" &&
        (row.payload.authorPublicId as string).toLowerCase() === publicId.toLowerCase());
      for (const row of marked) row.payload.identity_revisit_at = new Date().toISOString();
      revisitWrites += marked.length;
      return marked.map((row) => ({ id: row.id }));
    }
    if (query.includes("insert into noelle.leads")) {
      inserts.push(query);
      const id = values[2] as string;
      if (seen.has(id)) return [];
      seen.add(id);
      const leadId = `44444444-4444-4444-8444-${String(rows.size + 1).padStart(12, "0")}`;
      writes.push({ id, payload: values[5], status: query.includes("'observed'") ? "observed" : null,
        priority: query.includes("'observed', true") });
      rows.set(id, { id: leadId, externalId: id, status: "observed", payload: values[5] as Record<string, unknown> });
      return [{ id: leadId }];
    }
    if (query.trim().startsWith("select") && query.includes("from noelle.leads") && query.includes("identity_pending")) {
      const candidates = [...rows.values()].filter((r) => r.payload.fingerprint && r.payload.source === "extension_observed");
      if (query.includes("fingerprint =")) {
        const row = candidates.find((r) => r.status === "identity_pending" && r.id === values[2] && r.payload.fingerprint === values[3]);
        return row ? [{ id: row.id, fingerprint: row.payload.fingerprint }] : [];
      }
      const fingerprints = values[3] === false ? values[4] as string[] : null;
      return candidates.reverse()
        .filter((r) => r.status === "identity_pending" || (fingerprints !== null && (r.status === "observed" || r.status === "observed_classifying")))
        .filter((r) => fingerprints === null || fingerprints.includes(r.payload.fingerprint as string))
        .slice(0, fingerprints === null ? 20 : 50)
        .map((r) => ({ leadId: r.id, fingerprint: r.payload.fingerprint, status: r.status }));
    }
    if (query.trim().startsWith("select") && query.includes("from noelle.leads") && query.includes("external_id =")) {
      const row = rows.get(values[1] as string);
      return row ? [{ id: row.id }] : [];
    }
    if (query.includes("update noelle.leads") && query.includes("external_id =")) {
      const row = [...rows.values()].find((r) => r.id === values[4]);
      if (!row || row.status !== "identity_pending") return [];
      rows.delete(row.externalId);
      row.externalId = values[0] as string;
      row.payload = { ...row.payload, ...(values[1] as Record<string, unknown>) };
      row.status = "classified";
      rows.set(row.externalId, row);
      return [{ id: row.id }];
    }
    if (query.includes("update noelle.leads") && query.includes("status = 'skipped'")) {
      const row = [...rows.values()].find((r) => r.id === values[3]);
      if (row) row.status = "skipped";
      return [];
    }
    if (query.includes("pg_notify")) { notices++; return []; }
    return [];
  }) as unknown as { (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]>; json(value: unknown): unknown };
  sql.json = (value) => value;
  return { sql: sql as never, writes, inserts, rows, capacityQueries, targetQueries, notices: () => notices,
    revisitWrites: () => revisitWrites,
    qualify(id: string) { const row = rows.get(id); if (row) {
      row.status = "identity_pending";
      row.payload.classifier = { provider: "jev" };
    } } };
}

describe("LinkedIn actor observations API", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.NOELLE_DATABASE_URL = "postgres://test:test@127.0.0.1:5432/test";
    process.env.NOELLE_HMAC_SECRET = "h".repeat(48);
    process.env.NOELLE_ACTUATOR_TOKEN = "actor-test";
    process.env.NOELLE_ACTUATOR_ORG_ID = orgId;
    resetEnvForTests();
    resetDbClientForTests();
  });
  afterEach(() => vi.unstubAllGlobals());

  const request = (app: Hono, id: string) => app.request("/api/actuator/observations", {
    method: "POST",
    headers: { authorization: "Bearer actor-test", "content-type": "application/json" },
    body: JSON.stringify({ instanceId: id, items: [{ url, text: "Useful post about deploying small models", authorHandle: "ada" }] }),
  });

  it("rejects another tenant's instance before any lead insert", async () => {
    const db = fakeDb();
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    expect((await request(app, otherId)).status).toBe(403);
    expect(db.writes).toHaveLength(0);
  });

  it("reports five saved reply slots without counting raw observations or pending DMs", async () => {
    const db = fakeDb(4); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    const response = await app.request(`/api/actuator/discovery-capacity?instanceId=${instanceId}`, {
      headers: { authorization: "Bearer actor-test" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ limit: 5, occupied: 4, available: 1 });
    expect(db.capacityQueries).toHaveLength(1);
    const { query, values } = db.capacityQueries[0]!;
    expect(values).toContain(orgId);
    expect(values).toContain(instanceId);
    expect(values).toContain("linkedin");
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

  it("tenant-checks capacity and returns no free slots once five are occupied", async () => {
    const db = fakeDb(5); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    const headers = { authorization: "Bearer actor-test" };
    expect((await app.request(`/api/actuator/discovery-capacity?instanceId=${otherId}`, { headers })).status).toBe(403);
    expect(db.capacityQueries).toHaveLength(0);
    const response = await app.request(`/api/actuator/discovery-capacity?instanceId=${instanceId}`, { headers });
    expect(await response.json()).toEqual({ limit: 5, occupied: 5, available: 0 });
  });

  it("stages a distinct post once and leaves it for strict Jev qualification", async () => {
    const db = fakeDb();
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    const first = await request(app, instanceId);
    const second = await request(app, instanceId);
    expect(await first.json()).toEqual({ accepted: 1, duplicates: 0, invalid: 0 });
    expect(await second.json()).toEqual({ accepted: 0, duplicates: 1, invalid: 0 });
    expect(db.writes).toEqual([expect.objectContaining({
      id: "7481524546924343296", status: "observed", priority: true,
      payload: expect.objectContaining({ source: "extension_observed", posted_at: null }),
    })]);
    expect(db.notices()).toBe(1);
    expect(db.inserts[0]).toContain("on conflict (org_id, platform, external_id) do nothing");
  });

  it("rejects observations without a usable public author handle before staging", async () => {
    const db = fakeDb();
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    const response = await app.request("/api/actuator/observations", {
      method: "POST",
      headers: { authorization: "Bearer actor-test", "content-type": "application/json" },
      body: JSON.stringify({ instanceId, items: [
        { url, text: "Missing author" },
        { url, text: "Only an opaque author ID", authorId: "A123" },
        { url, text: "Blank handle", authorHandle: "   " },
      ] }),
