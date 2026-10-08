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
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 0, duplicates: 0, invalid: 3 });
    expect(db.writes).toHaveLength(0);
    expect(db.notices()).toBe(0);
  });

  const anonymous = { fingerprint: "opaque-card-A", text: "A substantive post about scaling a small team", authorHandle: "ada", reactionCount: 55, commentCount: 8 };
  const observation = (app: Hono, items: unknown[]) => app.request("/api/actuator/observations", {
    method: "POST", headers: { authorization: "Bearer actor-test", "content-type": "application/json" },
    body: JSON.stringify({ instanceId, items }),
  });
  const identityGet = (app: Hono, id = instanceId, fingerprints?: string[]) => app.request(`/api/actuator/discovery-identities?instanceId=${id}${fingerprints ? `&fingerprints=${encodeURIComponent(JSON.stringify(fingerprints))}` : ""}`, {
    headers: { authorization: "Bearer actor-test" },
  });
  const identityPost = (app: Hono, leadId: string, urn: string, id = instanceId) => app.request("/api/actuator/discovery-identities", {
    method: "POST", headers: { authorization: "Bearer actor-test", "content-type": "application/json" },
    body: JSON.stringify({ instanceId: id, leadId, fingerprint: anonymous.fingerprint, urn }),
  });
  const shortLinkPost = (app: Hono, leadId: string, shortUrl: string, id = instanceId) => app.request("/api/actuator/discovery-identities", {
    method: "POST", headers: { authorization: "Bearer actor-test", "content-type": "application/json" },
    body: JSON.stringify({ instanceId: id, leadId, fingerprint: anonymous.fingerprint, shortUrl }),
  });
  const discoveryTarget = (app: Hono, id = instanceId) => app.request(`/api/actuator/discovery-target?instanceId=${id}`, {
    headers: { authorization: "Bearer actor-test" },
  });

  it("revisits a qualified author's profile once, then durably cools that author for four hours", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [anonymous, { ...anonymous, fingerprint: "other-post", text: "Another useful post" }]);
    for (const row of db.rows.values()) db.qualify(row.externalId);
    expect(await (await discoveryTarget(app)).json()).toEqual({
      target: { kind: "profile", id: "ada", url: "https://www.linkedin.com/in/ada/recent-activity/all/" },
    });
    expect(db.revisitWrites()).toBe(2);
    expect([...db.rows.values()].every((row) => typeof row.payload.identity_revisit_at === "string")).toBe(true);
    expect(db.targetQueries[0]?.query).toContain("org_id = ? and agent_instance_id = ?");
    expect(db.targetQueries[0]?.query).toContain("payload->'classifier'->>'provider' = 'jev'");
    expect(await (await discoveryTarget(app)).json()).toEqual({ target: null });
    expect(db.revisitWrites()).toBe(2);
  });

  it("rotates to another qualified author instead of repeating the cooled profile", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [anonymous, { ...anonymous, authorHandle: "bea", fingerprint: "bea-post" }]);
    for (const row of db.rows.values()) db.qualify(row.externalId);
    expect(await (await discoveryTarget(app)).json()).toEqual({
      target: { kind: "profile", id: "ada", url: "https://www.linkedin.com/in/ada/recent-activity/all/" },
    });
    expect(await (await discoveryTarget(app)).json()).toEqual({
      target: { kind: "profile", id: "bea", url: "https://www.linkedin.com/in/bea/recent-activity/all/" },
    });
    expect(db.revisitWrites()).toBe(2);
  });

  it("never routes an unsafe or non-Jev pending author and tenant-checks target requests", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [
      { ...anonymous, authorHandle: "../feed", fingerprint: "unsafe" },
      { ...anonymous, authorHandle: "legacy", fingerprint: "non-jev" },
    ]);
    const leads = [...db.rows.values()];
    for (const row of leads) db.qualify(row.externalId);
    leads[1]!.payload.classifier = { provider: "legacy" };
    expect((await discoveryTarget(app, otherId)).status).toBe(403);
    expect(await (await discoveryTarget(app)).json()).toEqual({ target: null });
    expect(db.revisitWrites()).toBe(0);
  });

  it("stages visible content without a permalink and only requests identity after Jev qualification", async () => {
    const db = fakeDb();
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    expect(await (await observation(app, [anonymous, anonymous])).json()).toEqual({ accepted: 1, duplicates: 1, invalid: 0 });
    const [row] = [...db.rows.values()];
    expect(row).toEqual(expect.objectContaining({ externalId: expect.stringMatching(/^browser:[a-f0-9]{64}$/), status: "observed" }));
    expect(row?.payload).toEqual(expect.objectContaining({ fingerprint: anonymous.fingerprint, reactionCount: 55, commentCount: 8 }));
    expect(row?.payload).not.toHaveProperty("url");
    expect(await (await identityGet(app)).json()).toEqual({ items: [], processing: 0 });
    expect(await (await identityGet(app, instanceId, [anonymous.fingerprint])).json())
      .toEqual({ items: [], processing: 1 });
    db.qualify(row!.externalId);
    expect(await (await identityGet(app)).json()).toEqual({ items: [{ leadId: row!.id, fingerprint: anonymous.fingerprint }], processing: 0 });
  });

  it("returns a visible qualified card even when 25 newer pending cards fill the global backlog", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    const cards = Array.from({ length: 26 }, (_, index) => ({ ...anonymous, fingerprint: `visible-card-${index}` }));
    await observation(app, cards);
    for (const row of db.rows.values()) db.qualify(row.externalId);
    const oldest = cards[0]!;
    const response = await identityGet(app, instanceId, [oldest.fingerprint]);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ leadId: [...db.rows.values()][0]!.id, fingerprint: oldest.fingerprint }], processing: 0 });
  });

  it("rejects malformed visible fingerprint filters before querying pending leads", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    const response = await identityGet(app, instanceId, Array.from({ length: 51 }, (_, index) => `v1-${index}`));
    expect(response.status).toBe(400);
    expect(db.rows.size).toBe(0);
  });

  it("resolves an embed share only after Jev qualification, then wakes drafting", async () => {
    const db = fakeDb();
    __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [anonymous]);
    const [row] = [...db.rows.values()];
    const fetchMock = vi.fn(async () => new Response('<link rel="canonical" href="https://www.linkedin.com/feed/update/urn:li:activity:7506985845665681408">', { status: 200, headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await identityPost(app, row!.id, "urn:li:share:7506985844398911488")).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    db.qualify(row!.externalId);
    const response = await identityPost(app, row!.id, "urn:li:share:7506985844398911488");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resolved: true, duplicate: false });
    expect(fetchMock).toHaveBeenCalledWith("https://www.linkedin.com/embed/feed/update/urn:li:share:7506985844398911488?collapsed=1", expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) }));
    expect(row).toEqual(expect.objectContaining({ externalId: "7506985845665681408", status: "classified" }));
    expect(row?.payload).toEqual(expect.objectContaining({ urn: "urn:li:activity:7506985845665681408", url: "https://www.linkedin.com/feed/update/urn:li:activity:7506985845665681408/" }));
    expect(db.notices()).toBe(2); // observation + priority drafter wake
  });

  it("resolves a copied short link only after Jev qualification and stores the metadata activity", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [anonymous]);
    const [row] = [...db.rows.values()];
    const shortUrl = "https://lnkd.in/p/testToken_123";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: {
        location: "https://www.linkedin.com/posts/ada_topic-ugcPost-7506038810200215553-abc",
      } }))
      .mockResolvedValueOnce(new Response('<meta property="lnkd:url" content="https://www.linkedin.com/feed/update/urn:li:activity:7506038962675675138">', {
        status: 200, headers: { "content-type": "text/html" },
      }));
    vi.stubGlobal("fetch", fetchMock);
    expect((await shortLinkPost(app, row!.id, shortUrl)).status).toBe(409);
    expect(fetchMock).not.toHaveBeenCalled();
    db.qualify(row!.externalId);
    const response = await shortLinkPost(app, row!.id, shortUrl);
    expect(await response.json()).toEqual({ resolved: true, duplicate: false });
    expect(row).toEqual(expect.objectContaining({ externalId: "7506038962675675138", status: "classified" }));
    expect(row?.payload).toEqual(expect.objectContaining({
      urn: "urn:li:activity:7506038962675675138",
      url: "https://www.linkedin.com/feed/update/urn:li:activity:7506038962675675138/",
    }));
    expect(db.notices()).toBe(2);
  });

  it("rejects malformed short links without fetching and retains a qualified lead on metadata failure", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [anonymous]);
    const [row] = [...db.rows.values()]; db.qualify(row!.externalId);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await shortLinkPost(app, row!.id, "https://lnkd.in.evil.test/p/token")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 302, headers: {
      location: "https://www.linkedin.com/posts/ada_topic-ugcPost-7506038810200215553-abc",
    } })).mockResolvedValueOnce(new Response("<html>No activity metadata</html>", {
      status: 200, headers: { "content-type": "text/html" },
    }));
    expect((await shortLinkPost(app, row!.id, "https://lnkd.in/p/testToken_123")).status).toBe(503);
    expect(row?.status).toBe("identity_pending");
    expect(db.notices()).toBe(1);
  });

  it("retains the qualified candidate when the public embed is unavailable", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [anonymous]);
    const [row] = [...db.rows.values()]; db.qualify(row!.externalId);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    const failed = await identityPost(app, row!.id, "urn:li:share:7506985844398911488");
    expect(failed.status).toBe(503);
    expect(row?.status).toBe("identity_pending");
    expect(await (await identityGet(app)).json()).toEqual({ items: [{ leadId: row!.id, fingerprint: anonymous.fingerprint }], processing: 0 });
  });

  it("suppresses a duplicate activity after its anonymous card qualified", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [{ ...anonymous, fingerprint: "other-card", urn: "urn:li:activity:7506985845665681408" }, anonymous]);
    const row = [...db.rows.values()].find((value) => value.externalId.startsWith("browser:"))!;
    db.qualify(row.externalId);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await identityPost(app, row.id, "urn:li:activity:7506985845665681408");
    expect(await response.json()).toEqual({ resolved: false, duplicate: true });
    expect(row.status).toBe("skipped");
    expect(db.notices()).toBe(1); // no draft wake for a duplicate
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts a direct activity identity without visiting the embed", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [anonymous]);
    const [row] = [...db.rows.values()]; db.qualify(row!.externalId);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    const response = await identityPost(app, row!.id, "urn:li:activity:7506985845665681408");
    expect(await response.json()).toEqual({ resolved: true, duplicate: false });
    expect(row?.externalId).toBe("7506985845665681408");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("tenant checks identity requests and rejects an unsafe identifier before fetching", async () => {
    const db = fakeDb(); __setDbClientForTests(db.sql);
    const app = new Hono().route("/", linkedinDiscovery);
    await observation(app, [anonymous]);
    const [row] = [...db.rows.values()]; db.qualify(row!.externalId);
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    expect((await identityGet(app, otherId)).status).toBe(403);
    expect((await identityPost(app, row!.id, "urn:li:share:7506985844398911488", otherId)).status).toBe(403);
    expect((await identityPost(app, row!.id, "https://evil.example/post")).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
