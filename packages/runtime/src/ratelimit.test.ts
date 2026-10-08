import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  MemoryTokenBucket,
  UpstashTokenBucket,
  enforce,
  rateLimitedResponse,
  _resetRateLimitRegistryForTests,
  getRateLimit,
} from "./ratelimit.js";

describe("MemoryTokenBucket", () => {
  it("allows up to capacity then denies", async () => {
    const b = new MemoryTokenBucket({ capacity: 3, refillPerSecond: 0 });
    const r1 = await b.take("k");
    const r2 = await b.take("k");
    const r3 = await b.take("k");
    const r4 = await b.take("k");
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(true);
    expect(r3.allowed).toBe(true);
    expect(r4.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it("refills tokens over time at refillPerSecond", async () => {
    vi.useFakeTimers();
    try {
      const b = new MemoryTokenBucket({ capacity: 10, refillPerSecond: 5 });
      // Drain bucket.
      for (let i = 0; i < 10; i++) await b.take("k");
      const denied = await b.take("k");
      expect(denied.allowed).toBe(false);
      // After 400ms at 5 tokens/sec we should have 2 tokens.
      vi.advanceTimersByTime(400);
      const allowed = await b.take("k", 2);
      expect(allowed.allowed).toBe(true);
      const denied2 = await b.take("k");
      expect(denied2.allowed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retryAfterMs reflects the refill rate", async () => {
    const b = new MemoryTokenBucket({ capacity: 1, refillPerSecond: 1 });
    await b.take("k");
    const denied = await b.take("k");
    expect(denied.allowed).toBe(false);
    // Needs ~1 token at 1/sec → ~1000ms wait.
    expect(denied.retryAfterMs).toBeGreaterThanOrEqual(900);
    expect(denied.retryAfterMs).toBeLessThanOrEqual(1100);
  });

  it("separate keys do not share the bucket", async () => {
    const b = new MemoryTokenBucket({ capacity: 1, refillPerSecond: 0 });
    expect((await b.take("a")).allowed).toBe(true);
    expect((await b.take("b")).allowed).toBe(true);
    expect((await b.take("a")).allowed).toBe(false);
    expect((await b.take("b")).allowed).toBe(false);
  });

  it("never exceeds capacity even after long idle", async () => {
    vi.useFakeTimers();
    try {
      const b = new MemoryTokenBucket({ capacity: 5, refillPerSecond: 100 });
      // Take 1 so the bucket is initialized.
      await b.take("k");
      vi.advanceTimersByTime(10_000);
      // Should be capped at 5; taking 5 must succeed, the 6th must fail.
      for (let i = 0; i < 5; i++) {
        const r = await b.take("k");
        expect(r.allowed).toBe(true);
      }
      const overflow = await b.take("k");
      expect(overflow.allowed).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("UpstashTokenBucket (mocked)", () => {
  it.each([[2, 1, 0], [0, "invalid", 25], [0, 1.5, 25], [0, 1, -2], [0, 1, 25, 0]])
    ("fails open on an impossible Lua receipt %j", async (...result) => {
      const bucket = new UpstashTokenBucket({ url: "https://example.test", token: "test", capacity: 5,
        refillPerSecond: 1, fetchImpl: async () => new Response(JSON.stringify({ result })) });
      expect(await bucket.take("key")).toEqual({ allowed: true, remaining: 5, retryAfterMs: 0 });
    });

  it("bounds the full response body before its existing fail-open policy", async () => {
    let canceled = false;
    let timer: ReturnType<typeof setTimeout>;
    const response = new Response(new ReadableStream<Uint8Array>({ start(controller) {
      timer = setTimeout(() => { controller.enqueue(new TextEncoder().encode('{"result":[0,0,20]}')); controller.close(); }, 150);
    }, cancel() { canceled = true; clearTimeout(timer); } }));
    const options = { url: "https://example.test", token: "test", capacity: 5, refillPerSecond: 1,
      timeoutMs: 20, fetchImpl: async () => response };
    expect(await new UpstashTokenBucket(options).take("key")).toEqual({ allowed: true, remaining: 5, retryAfterMs: 0 });
    expect(canceled).toBe(true);
  });

  it("issues a POST with EVAL command and parses the Lua array result", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: [1, 4, 0] }))) as unknown as typeof fetch;

    const b = new UpstashTokenBucket({
      url: "https://example.upstash.io",
      token: "tok",
      capacity: 5,
      refillPerSecond: 1,
      fetchImpl,
    });
    const r = await b.take("user:42", 1);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(4);
    expect(r.retryAfterMs).toBe(0);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const call = (fetchImpl as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    const [url, init] = call;
    expect(url).toBe("https://example.upstash.io");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer tok");
    const sent = JSON.parse(init.body as string) as unknown[];
    expect(sent[0]).toBe("EVAL");
    // numkeys then key
    expect(sent[2]).toBe("1");
    expect(sent[3]).toBe("user:42");
    // ARGV: capacity, refill, cost, now
    expect(sent[4]).toBe("5");
    expect(sent[5]).toBe("1");
    expect(sent[6]).toBe("1");
  });

  it("returns denied + retryAfterMs when Lua signals denial", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: [0, 0, 750] }))) as unknown as typeof fetch;
    const b = new UpstashTokenBucket({
      url: "https://example.upstash.io",
      token: "tok",
      capacity: 1,
      refillPerSecond: 2,
      fetchImpl,
    });
    const r = await b.take("k", 1);
    expect(r.allowed).toBe(false);
    expect(r.retryAfterMs).toBe(750);
    expect(r.remaining).toBe(0);
  });

  it("fails open on HTTP error so the platform doesn't 503 the world", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 500 })) as unknown as typeof fetch;
    const b = new UpstashTokenBucket({
      url: "https://example.upstash.io",
      token: "tok",
      capacity: 7,
      refillPerSecond: 1,
      fetchImpl,
    });
    const r = await b.take("k");
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(7);
  });

  it("fails open on network exception", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const b = new UpstashTokenBucket({
      url: "https://example.upstash.io",
      token: "tok",
      capacity: 3,
      refillPerSecond: 1,
      fetchImpl,
    });
    const r = await b.take("k");
    expect(r.allowed).toBe(true);
  });

  it("strips trailing slashes from the URL", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: [1, 0, 0] }))) as unknown as typeof fetch;
    const b = new UpstashTokenBucket({
      url: "https://example.upstash.io/",
      token: "tok",
      capacity: 1,
      refillPerSecond: 1,
      fetchImpl,
    });
    await b.take("k");
    const call = (fetchImpl as unknown as { mock: { calls: [string][] } }).mock.calls[0]!;
    const [url] = call;
    expect(url).toBe("https://example.upstash.io");
  });
});

describe("getRateLimit", () => {
  it("returns MemoryTokenBucket for driver=memory", () => {
    const r = getRateLimit({ capacity: 1, refillPerSecond: 1 }, "memory");
    expect(r).toBeInstanceOf(MemoryTokenBucket);
  });

