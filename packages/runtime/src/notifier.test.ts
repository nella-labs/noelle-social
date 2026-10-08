import { describe, expect, it, vi } from "vitest";
import { SecretAccessError, type SecretsClient } from "@noelle/secrets";
import { createNotifier, type NotifierLogger } from "./notifier.js";

// This module had FOUR copies across the interns and not one test in any of
// them. That absence is why the copies were free to drift, so the consolidation
// brings the coverage the originals never had.

function log(): NotifierLogger & { infos: unknown[]; errors: unknown[] } {
  const infos: unknown[] = [];
  const errors: unknown[] = [];
  return {
    infos,
    errors,
    info: (o, m) => void infos.push([o, m]),
    error: (o, m) => void errors.push([o, m]),
  };
}

/** A secrets client backed by a plain map; unknown fragments behave like GCP's NOT_FOUND. */
function secrets(values: Record<string, string>): SecretsClient {
  return {
    getForOrg: async (_orgId: string, fragment: string) => {
      if (fragment in values) return values[fragment]!;
      throw new SecretAccessError(`failed to access secret: 5 NOT_FOUND: Secret [${fragment}] not found`);
    },
  } as unknown as SecretsClient;
}

const BOTH_KEYS = { "pushover-user-key": "u1", "pushover-token": "t1" };

/** Captures the outgoing form body so field-level assertions are on real output. */
function fetchOk(captured: URLSearchParams[]) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    captured.push(new URLSearchParams(String(init?.body ?? "")));
    return new Response(JSON.stringify({ status: 1, request: "req-123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

describe("createNotifier", () => {
  it("prepares credentials once and sends without reading secrets under a database lease", async () => {
    const client = secrets(BOTH_KEYS);
    const get = vi.spyOn(client, "getForOrg");
    const bodies: URLSearchParams[] = [];
    const n = createNotifier({ secrets: client, log: log(), fetchImpl: fetchOk(bodies) });
    const prepared = await n.prepare("owning-org");
    expect(get.mock.calls.map(call => call[0])).toEqual(["owning-org", "owning-org"]);
    await prepared.notify({ title: "first", message: "message" });
    await prepared.notify({ title: "second", message: "message" });
    expect(get).toHaveBeenCalledTimes(2); expect(bodies).toHaveLength(2);
  });

  it("applies the remaining send budget to the full response body", async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"status":')); },
      cancel() { cancelled = true; },
    }));
    const fetchImpl = vi.fn(async () => response);
    const n = createNotifier({ secrets: secrets(BOTH_KEYS), log: log(), fetchImpl });
    const prepared = await n.prepare("owning-org");
    expect((await prepared.notify({ title: "title", message: "message" }, { timeoutMs: 20 })).status).toBe("error");
    expect(cancelled).toBe(true);
  });

  it("sends when both keys resolve", async () => {
    const bodies: URLSearchParams[] = [];
    const n = createNotifier({ secrets: secrets(BOTH_KEYS), log: log(), fetchImpl: fetchOk(bodies) });
    const res = await n.notify({ orgId: "o1", title: "t", message: "m" });
    expect(res).toEqual({ status: "sent", channel: "pushover", request: "req-123" });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.get("user")).toBe("u1");
    expect(bodies[0]!.get("token")).toBe("t1");
  });

  it("returns no_channel WITHOUT throwing when the org has no keys", async () => {
    // The classifier calls this on its happy path, so a missing-secrets org must
    // never surface as an exception.
    const l = log();
    const n = createNotifier({ secrets: secrets({}), log: l, fetchImpl: fetchOk([]) });
    const res = await n.notify({ orgId: "o1", title: "t", message: "m" });
    expect(res.status).toBe("no_channel");
    expect(res.channel).toBeNull();
    expect(l.infos).toHaveLength(1);
  });

  it("needs BOTH keys — one alone is still no_channel", async () => {
    for (const partial of [{ "pushover-user-key": "u1" }, { "pushover-token": "t1" }]) {
      const n = createNotifier({ secrets: secrets(partial), log: log(), fetchImpl: fetchOk([]) });
      expect((await n.notify({ orgId: "o1", title: "t", message: "m" })).status).toBe("no_channel");
    }
  });

  it("a secrets failure that is NOT a missing secret propagates", async () => {
    // The guard is `instanceof SecretAccessError && /NOT_FOUND/`. Anything else
    // must throw: swallowing it would turn a broken secrets client into a
    // permanent silent no_channel, and alerting would be dead with no signal.
    const boom: SecretsClient = {
      getForOrg: async () => {
        throw new Error("PERMISSION_DENIED: caller lacks secretmanager.versions.access");
      },
    } as unknown as SecretsClient;
    const n = createNotifier({ secrets: boom, log: log(), fetchImpl: fetchOk([]) });
    await expect(n.notify({ orgId: "o1", title: "t", message: "m" })).rejects.toThrow(/PERMISSION_DENIED/);
  });

  it("a SecretAccessError WITHOUT NOT_FOUND also propagates", async () => {
    const boom: SecretsClient = {
      getForOrg: async () => {
        throw new SecretAccessError("DEADLINE_EXCEEDED talking to Secret Manager");
      },
    } as unknown as SecretsClient;
    const n = createNotifier({ secrets: boom, log: log(), fetchImpl: fetchOk([]) });
    await expect(n.notify({ orgId: "o1", title: "t", message: "m" })).rejects.toThrow(/DEADLINE_EXCEEDED/);
  });

  it("a send failure is reported, not thrown, and is logged", async () => {
    const l = log();
    const failing = (async () =>
      new Response(JSON.stringify({ status: 0, errors: ["application token is invalid"] }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const n = createNotifier({ secrets: secrets(BOTH_KEYS), log: l, fetchImpl: failing });
    const res = await n.notify({ orgId: "o1", title: "t", message: "m" });
    expect(res.status).toBe("error");
    expect(res.channel).toBe("pushover");
    expect(l.errors).toHaveLength(1);
  });

  it("omits url and url_title when absent, and forwards them when set", async () => {
    // Pins the behaviour behind the conditional spread the app copies disagreed
    // on: x-intern passed these unconditionally, the other three spread them.
    // Both produce the same body, and this is what proves it.
    const without: URLSearchParams[] = [];
    await createNotifier({ secrets: secrets(BOTH_KEYS), log: log(), fetchImpl: fetchOk(without) }).notify({
      orgId: "o1",
      title: "t",
      message: "m",
    });
    expect(without[0]!.has("url")).toBe(false);
    expect(without[0]!.has("url_title")).toBe(false);

    const with_: URLSearchParams[] = [];
    await createNotifier({ secrets: secrets(BOTH_KEYS), log: log(), fetchImpl: fetchOk(with_) }).notify({
      orgId: "o1",
      title: "t",
      message: "m",
      url: "https://example.test/x",
      url_title: "open",
    });
    expect(with_[0]!.get("url")).toBe("https://example.test/x");
    expect(with_[0]!.get("url_title")).toBe("open");
  });

  it("an empty-string url is treated as absent", async () => {
    // The equivalence claim only holds because sendPushover gates on truthiness
    // (pushoverClient.ts `if (args.url)`), so "" must not reach the body.
    const bodies: URLSearchParams[] = [];
    await createNotifier({ secrets: secrets(BOTH_KEYS), log: log(), fetchImpl: fetchOk(bodies) }).notify({
      orgId: "o1",
      title: "t",
      message: "m",
      url: "",
      url_title: "",
    });
    expect(bodies[0]!.has("url")).toBe(false);
    expect(bodies[0]!.has("url_title")).toBe(false);
  });

  it("does not consult secrets more than the two keys it needs", async () => {
    const spy = vi.fn(async (_o: string, fragment: string) => {
      if (fragment in BOTH_KEYS) return BOTH_KEYS[fragment as keyof typeof BOTH_KEYS];
      throw new SecretAccessError("5 NOT_FOUND");
    });
    const n = createNotifier({
      secrets: { getForOrg: spy } as unknown as SecretsClient,
      log: log(),
      fetchImpl: fetchOk([]),
    });
    await n.notify({ orgId: "o1", title: "t", message: "m" });
    expect(spy.mock.calls.map((c) => c[1])).toEqual(["pushover-user-key", "pushover-token"]);
  });
});
