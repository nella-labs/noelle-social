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

const reply = {
  approval_id: "11111111-1111-1111-1111-111111111111",
  draft_id: "22222222-2222-2222-2222-222222222222",
  lead_id: "33333333-3333-3333-3333-333333333333",
  kind: "reply" as const,
  body: "nice ship",
  target: {
    type: "post" as const,
    url: "https://x.com/jackfriks/status/123",
    tweet_id: "123",
    author_handle: "jackfriks",
    author_name: "Jack",
  },
};

describe("ActuatorApi (X)", () => {
  it("reads and edits the tenant-scoped browser reply cap", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ sent: 7, cap: 80, remaining: 73 }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    expect(await api.fetchReplyCap()).toEqual({ sent: 7, cap: 80, remaining: 73 });
    expect(await api.setReplyCap(80)).toEqual({ sent: 7, cap: 80, remaining: 73 });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.test/api/actuator/reply-cap?platform=x&instanceId=inst-1");
    expect(fetchImpl.mock.calls[0]![1]?.method).toBe("GET");
    expect(fetchImpl.mock.calls[1]![1]?.method).toBe("POST");
    expect(JSON.parse(fetchImpl.mock.calls[1]![1]?.body as string)).toEqual({ cap: 80 });
  });

  it("checks durable discovery capacity for the configured instance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ limit: 5, occupied: 4, available: 1 }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    expect(await api.fetchDiscoveryCapacity()).toEqual({ limit: 5, occupied: 4, available: 1 });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.test/api/x-actuator/discovery-capacity?instanceId=inst-1");
    expect(fetchImpl.mock.calls[0]![1]?.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("sends the daily minimum and preserves today's cap with its ceiling", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({
      sent: 7, cap: 103, remaining: 96, configuredCap: 140, minimum: 80, day: "2026-10-07",
    }));
    const api = new ActuatorApi(config, fetchImpl);
    expect(await api.setReplyCap(140, 80)).toEqual({
      sent: 7, cap: 103, remaining: 96, configuredCap: 140, minimum: 80, day: "2026-10-07",
    });
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string)).toEqual({ cap: 140, minimum: 80 });
  });

  it.each([
    ["legacy fixed response", { sent: 0, cap: 140, remaining: 140 }],
    ["different ceiling", { sent: 0, cap: 103, remaining: 103, configuredCap: 150, minimum: 80, day: "2026-10-07" }],
    ["different minimum", { sent: 0, cap: 103, remaining: 103, configuredCap: 140, minimum: 90, day: "2026-10-07" }],
    ["missing day", { sent: 0, cap: 103, remaining: 103, configuredCap: 140, minimum: 80 }],
  ])("does not confirm a varying write from a %s", async (_label, response) => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(response));
    await expect(new ActuatorApi(config, fetchImpl).setReplyCap(140, 80))
      .rejects.toThrow("API did not confirm the daily reply range");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("can explicitly clear daily variation without changing the ceiling", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ sent: 7, cap: 140, remaining: 133 }));
    await new ActuatorApi(config, fetchImpl).setReplyCap(140, null);
    expect(JSON.parse(fetchImpl.mock.calls[0]![1]?.body as string)).toEqual({ cap: 140, minimum: null });
  });

  it.each([[null, 80], [140, 141], [140, 80.5], [501, null]])(
    "rejects an invalid ceiling/range before any request (%s, %s)", async (cap, minimum) => {
      const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ sent: 0, cap: 140, remaining: 140 }));
      await expect(new ActuatorApi(config, fetchImpl).setReplyCap(cap, minimum)).rejects.toThrow();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed daily policy metadata in a successful response", async () => {
    const api = new ActuatorApi(config, vi.fn<typeof fetch>(async () => jsonResponse({
      sent: 7, cap: 103, remaining: 96, configuredCap: 140, minimum: "80", day: "2026-10-07",
    })));
    await expect(api.fetchReplyCap()).rejects.toThrow("invalid browser reply cap response");
  });

  it("accepts a pre-existing backlog above the five-reply limit as full", async () => {
    const api = new ActuatorApi(config, vi.fn<typeof fetch>(async () => jsonResponse({ limit: 5, occupied: 12, available: 0 })) as unknown as typeof fetch);
    expect(await api.fetchDiscoveryCapacity()).toEqual({ limit: 5, occupied: 12, available: 0 });
  });

  it("rejects malformed discovery capacity instead of scrolling without a bound", async () => {
    const api = new ActuatorApi(config, vi.fn<typeof fetch>(async () => jsonResponse({ limit: 5, occupied: 0, available: 1000 })) as unknown as typeof fetch);
    await expect(api.fetchDiscoveryCapacity()).rejects.toThrow("invalid X discovery capacity");
  });

  it("stages browser observations with the configured tenant identity", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ accepted: 1, duplicates: 0, invalid: 0 }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    const result = await api.postObservations([{ tweetId: "123", url: "https://x.com/jackfriks/status/123", text: "Full post", authorHandle: "jackfriks", likeCount: 40, replyCount: 7 }]);
    expect(result.accepted).toBe(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/x-actuator/observations");
    expect(JSON.parse(init!.body as string)).toMatchObject({ instanceId: "inst-1", items: [{ tweetId: "123", likeCount: 40, replyCount: 7 }] });
  });

  it("fetches only priority-ready X approvals through the separate route", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ replies: [reply] }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    expect((await api.fetchPriorityReady()).comments).toHaveLength(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.test/api/actionable-x/priority-ready?instanceId=inst-1");
  });

  it("a denied or lost pre-send claim cannot be treated as permission to post", async () => {
    const conflict = new ActuatorApi(config, vi.fn<typeof fetch>(async () => jsonResponse({}, 409)) as unknown as typeof fetch);
    expect(await conflict.claimReply(reply.approval_id)).toEqual({ claimed: false });
    const outage = new ActuatorApi(config, vi.fn<typeof fetch>(async () => { throw new Error("offline"); }) as unknown as typeof fetch);
    await expect(outage.claimReply(reply.approval_id)).rejects.toThrow("offline");
  });
  it("fetchQueue hits /api/actionable-x and adapts { replies } → { comments, dms:[] }", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ replies: [reply] }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    const out = await api.fetchQueue();
    expect(out.dms).toEqual([]);
    expect(out.comments).toEqual([
      { approval_id: reply.approval_id, draft_id: reply.draft_id, body: "nice ship", target: { url: reply.target.url } },
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actionable-x?instanceId=inst-1");
    expect(init!.headers).toMatchObject({ authorization: "Bearer tok" });
  });

  it("markSent POSTs to the generic actuator mark-sent with sent_via=extension", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ status: "sent" }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.markSent("approval-9");
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/mark-sent/approval-9");
    expect(JSON.parse(init!.body as string)).toEqual({ sent_via: "extension" });
  });

  it("REGRESSION: exposes NO enableSend — the X actuator must never flip reply_send_enabled", () => {
    // On X, agent_instances.reply_send_enabled is the master gate of the
    // x-intern official-API send worker (apps/x-intern/src/workers/send.ts):
    // arming it from the extension would launch a second unattended sender over
    // the same approval pool (duplicate public posts), and disarming it at run
    // end would revoke the operator's standing dashboard consent. If someone
    // re-ports the LinkedIn actuator's enableSend here, this test is the tripwire.
    const api = new ActuatorApi(config);
    expect((api as unknown as Record<string, unknown>)["enableSend"]).toBeUndefined();
  });

  it("logActivity POSTs events to /api/x-activity", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ inserted: 1 }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.logActivity("44444444-4444-4444-4444-444444444444", [
      { type: "reply", approval_id: reply.approval_id, at: "2026-07-10T20:00:00.000Z" },
    ]);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/x-activity");
    expect(JSON.parse(init!.body as string)).toMatchObject({ session_id: "44444444-4444-4444-4444-444444444444" });
  });

  it("logActivity is a no-op with zero events (never calls fetch)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ inserted: 0 }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await api.logActivity("44444444-4444-4444-4444-444444444444", []);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws on non-2xx", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ error: "x" }, 500));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    await expect(api.markSent("d")).rejects.toThrow();
  });

  it("health GETs /api/actuator/x-health with the bearer header and parses status", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse({ status: "ok" }));
    const api = new ActuatorApi(config, fetchImpl as unknown as typeof fetch);
    const out = await api.health();
    expect(out).toEqual({ status: "ok" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.test/api/actuator/x-health?instanceId=inst-1");
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
