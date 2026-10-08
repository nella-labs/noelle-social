import { describe, it, expect, vi } from "vitest";
import { ActuatorApi } from "../src/lib/api.js";
import type { ActuatorConfig } from "../src/lib/types.js";

const config: ActuatorConfig = {
  apiBaseUrl: "https://api.test",
  token: "tok",
  instanceId: "inst-1",
  caps: { likes: 120, comments: 80, dms: 10 },
  preferWatchlistRatio: 0.7,
  deepNightTaper: false,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("ActuatorApi", () => {
  it("reads and edits the tenant-scoped browser reply cap", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ sent: 20, cap: 80, remaining: 60 }));
    const api = new ActuatorApi(config, fetchImpl);
    expect(await api.fetchReplyCap()).toEqual({ sent: 20, cap: 80, remaining: 60 });
    expect(await api.setReplyCap(80)).toEqual({ sent: 20, cap: 80, remaining: 60 });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.test/api/actuator/reply-cap?platform=linkedin&instanceId=inst-1");
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe("GET");
    expect(fetchImpl.mock.calls[1]![1]?.method).toBe("POST");
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]?.body as string)).toEqual({ cap: 80 });
  });

  it("fetches a rotating discovery target for this instance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ target: { kind: "profile", id: "p1", url: "https://www.linkedin.com/in/p1/" } }));
    const target = await new ActuatorApi(config, fetchImpl).fetchDiscoveryTarget();
    expect(target).toEqual({ kind: "profile", id: "p1", url: "https://www.linkedin.com/in/p1/" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.test/api/actuator/discovery-target?instanceId=inst-1");
  });

  it("reads the server's discovery slots for this instance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ limit: 5, occupied: 4, available: 1 }));
    const capacity = await new ActuatorApi(config, fetchImpl).fetchDiscoveryCapacity();
    expect(capacity).toEqual({ limit: 5, occupied: 4, available: 1 });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.test/api/actuator/discovery-capacity?instanceId=inst-1");
    await expect(new ActuatorApi(config, async () => jsonResponse({ limit: 5, occupied: 4, available: 2 })).fetchDiscoveryCapacity())
      .rejects.toThrow("invalid discovery capacity");
  });

  it("posts a batch of visible posts with the configured instance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ accepted: 1, duplicates: 0 }));
    const items = [{ fingerprint: "ada-post", urn: "urn:li:activity:123", url: "https://www.linkedin.com/feed/update/urn:li:activity:123/", text: "Post", authorName: "Ada", authorHandle: "ada" }];
    await new ActuatorApi(config, fetchImpl).postObservations(items);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/observations");
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({ instanceId: "inst-1", items });
  });

  it("gets qualified cards needing identity and submits a discovered share URN", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ items: [{ leadId: "lead-1", fingerprint: "v1-post" }], processing: 1 }))
      .mockResolvedValueOnce(jsonResponse({ resolved: true, duplicate: false }));
    const api = new ActuatorApi(config, fetchImpl);
    expect(await api.fetchDiscoveryIdentities(["v1-post"])).toEqual({ items: [{ leadId: "lead-1", fingerprint: "v1-post" }], processing: 1 });
    expect(await api.resolveDiscoveryIdentity("lead-1", "v1-post", "urn:li:share:7506985844398911488"))
      .toEqual({ resolved: true, duplicate: false });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.test/api/actuator/discovery-identities?instanceId=inst-1&fingerprints=%5B%22v1-post%22%5D");
    const [url, init] = fetchImpl.mock.calls[1]!;
    expect(String(url)).toBe("https://api.test/api/actuator/discovery-identities");
    expect(JSON.parse(init!.body as string)).toEqual({
      instanceId: "inst-1", leadId: "lead-1", fingerprint: "v1-post", urn: "urn:li:share:7506985844398911488",
    });
  });

  it("sends a captured lnkd.in post link to tenant-checked identity resolution", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ resolved: true, duplicate: false }));
    const api = new ActuatorApi(config, fetchImpl);
    expect(await api.resolveDiscoveryShortLink("lead-1", "v1-post", "https://lnkd.in/p/eQDXbx_h"))
      .toEqual({ resolved: true, duplicate: false });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/discovery-identities");
    expect(JSON.parse(init!.body as string)).toEqual({
      instanceId: "inst-1", leadId: "lead-1", fingerprint: "v1-post", shortUrl: "https://lnkd.in/p/eQDXbx_h",
    });
    await expect(api.resolveDiscoveryShortLink("lead-1", "v1-post", "https://lnkd.in.evil.example/p/fake"))
      .rejects.toThrow("invalid LinkedIn short post URL");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("long-polls priority-ready comments with a cursor and the bearer token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ comments: [], dms: [] }));
    await new ActuatorApi(config, fetchImpl).fetchPriorityReady(1234);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/priority-ready?instanceId=inst-1&since=1234&waitMs=25000");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });
  it("fetchQueue hits the right URL with the bearer token and parses", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ comments: [], dms: [] }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    const out = await api.fetchQueue();
    expect(out).toEqual({ comments: [], dms: [] });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actionable-linkedin?instanceId=inst-1");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("reads a tenant-checked approval state before retrying a withheld slot", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ status: "sent", autosend_pending: false }));
    const state = await new ActuatorApi(config, fetchImpl).fetchApprovalState("approval/9");
    expect(state).toEqual({ status: "sent", autosend_pending: false });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/approval-state/approval%2F9");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("markSent POSTs to actuator route with sent_via=extension", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ status: "sent" }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.markSent("approval-9");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/mark-sent/approval-9");
    expect(JSON.parse(init!.body as string)).toEqual({ sent_via: "extension" });
  });

  it("claims a post on the server before posting and rejects malformed claim replies", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ claimed: true }));
    const api = new ActuatorApi(config, fetchImpl);
    expect(await api.claimComment("approval/9")).toEqual({ claimed: true });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/claim-comment/approval%2F9");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });

    const malformed = new ActuatorApi(config, async () => jsonResponse({ claimed: "yes" }));
    await expect(malformed.claimComment("approval/9")).rejects.toThrow("invalid claim-comment response");
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "x" }, 500));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await expect(api.markSent("d")).rejects.toThrow();
  });

  it("enableSend POSTs {instanceId, enabled} to the enable-send route", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ ok: true, instanceId: "inst-1", reply_send_enabled: true }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.enableSend("inst-1", true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/enable-send");
    expect(init!.method).toBe("POST");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
    expect(JSON.parse(init!.body as string)).toEqual({ instanceId: "inst-1", enabled: true });
  });

  it("health GETs the actuator health route with the bearer header and parses status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ status: "ok" }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    const out = await api.health();
    expect(out).toEqual({ status: "ok" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/health");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("health rejects on non-2xx (drives the caller's fail-closed .catch)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "down" }, 503));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await expect(api.health()).rejects.toThrow();
  });

  it("default fetch is bound to the global scope (avoids 'Illegal invocation')", async () => {
    // The browser throws "Illegal invocation" if fetch runs with `this` set to
    // anything but the realm global. The default fetchImpl must be bound so that
    // calling it as `this.fetchImpl(...)` still runs with this === globalThis.
    const original = globalThis.fetch;
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({}));
    globalThis.fetch = fetchImpl;
    try {
      const api = new ActuatorApi(config); // no fetchImpl → exercises the default
      await api.markSent("d");
      expect(fetchImpl.mock.contexts).toEqual([globalThis]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
