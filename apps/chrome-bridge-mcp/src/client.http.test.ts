import { createServer, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient } from "./client.js";

const packageDir = fileURLToPath(new URL("../", import.meta.url));
const nativeFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const turn = () => new Promise<void>(resolve => realSetTimeout(resolve, 40));
const health = { ok: true, version: "fixture", ext_connected: false, sources: [], uptime_ms: 1 };
const token = "test-token";
const originalUrl = process.env.NOELLE_BRIDGE_URL;
const originalToken = process.env.NOELLE_BRIDGE_TOKEN;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
};

async function serve(handler: (path: string, res: ServerResponse) => void) {
  let requests = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((req, res) => { requests++; handler(req.url ?? "", res); });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing localhost fixture address");
  const url = `http://127.0.0.1:${address.port}`;
  process.env.NOELLE_BRIDGE_URL = url;
  process.env.NOELLE_BRIDGE_TOKEN = token;
  return {
    url, requests: () => requests, sockets: () => sockets.size,
    async close() {
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      for (const socket of sockets) socket.destroy();
      await closed;
      await turn();
      expect(sockets.size).toBe(0);
    },
  };
}

afterEach(() => {
  vi.useRealTimers(); vi.unstubAllGlobals();
  if (originalUrl === undefined) delete process.env.NOELLE_BRIDGE_URL;
  else process.env.NOELLE_BRIDGE_URL = originalUrl;
  if (originalToken === undefined) delete process.env.NOELLE_BRIDGE_TOKEN;
  else process.env.NOELLE_BRIDGE_TOKEN = originalToken;
});

describe("actual BridgeClient native HTTP boundary", () => {
  for (const phase of ["headers", "body"] as const) {
    it(`bounds a genuinely admitted held ${phase} and recovers without retry`, async () => {
      const admitted = deferred<void>();
      const closed = deferred<void>();
      let held: ServerResponse | undefined;
      let first = true;
      let automaticClose = false;
      let cleaning = false;
      const fixture = await serve((_path, res) => {
        if (first) {
          first = false; held = res;
          res.on("close", () => { if (!cleaning) automaticClose = true; closed.resolve(); });
          if (phase === "body") { res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":'); }
          admitted.resolve();
        } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(health)); }
      });
      let signal: AbortSignal | null | undefined;
      vi.stubGlobal("fetch", ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        signal = init?.signal; return nativeFetch(input, init);
      }) as typeof fetch);
      let result: unknown;
      let settled = false;
      let pending: Promise<unknown> | undefined;
      try {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        pending = new BridgeClient().health().then(r => { result = r; settled = true; return r; });
        await admitted.promise;
        // No vi.waitFor: native server admission precedes deadline advancement.
        await turn();
        await vi.advanceTimersByTimeAsync(30_001);
        await turn();
        expect(settled, "an admitted request must finish within a finite full-body deadline").toBe(true);
        expect(result).toMatchObject({ ok: false });
        expect(signal?.aborted).toBe(true);
        await closed.promise;
        expect(automaticClose).toBe(true);
      } finally {
        vi.useRealTimers(); cleaning = true; held?.destroy();
        await pending;
        const recovered = await new BridgeClient().health();
        expect(recovered).toEqual(health);
        expect(fixture.requests()).toBe(2);
        await fixture.close();
      }
    }, 15_000);
  }

  it("rejects a response larger than the canonical HTTP owner permits", async () => {
    const fixture = await serve((_path, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, value: "x".repeat(17 * 1024 * 1024) }));
    });
    try {
      const result = await new BridgeClient().op({ op: "meta.ping" });
      expect(result).toMatchObject({ ok: false });
      expect(fixture.requests()).toBe(1);
    } finally { await fixture.close(); }
  });

  it("reports a native body failure instead of a success-shaped empty object", async () => {
    const headersSeen = deferred<void>();
    let response: ServerResponse | undefined;
    const fixture = await serve((_path, res) => {
      response = res;
      res.writeHead(200, { "content-type": "application/json" }); res.write('{"ok":');
    });
    vi.stubGlobal("fetch", (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const result = await nativeFetch(input, init); headersSeen.resolve(); return result;
    }) as typeof fetch);
    try {
      const pending = new BridgeClient().health();
      await headersSeen.promise;
      response!.destroy();
      const result = await pending;
      expect(result).toMatchObject({ ok: false });
      expect(fixture.requests()).toBe(1);
    } finally { await fixture.close(); }
  });

  it("keeps healthy JSON, op failure, HTTP hints, invalid JSON and empty-body contracts", async () => {
    const replies = [
      { status: 200, text: JSON.stringify(health) },
      { status: 200, text: JSON.stringify({ ok: false, error: "selector missing" }) },
      { status: 401, text: JSON.stringify({ error: "invalid token" }) },
      { status: 503, text: JSON.stringify({ error: "extension not connected" }) },
      { status: 504, text: JSON.stringify({ error: "fixture timeout" }) },
      { status: 200, text: "not json" },
      { status: 200, text: "" },
    ];
    const fixture = await serve((_path, res) => {
      const reply = replies.shift()!; res.writeHead(reply.status, { "content-type": "application/json" }); res.end(reply.text);
    });
    try {
      const client = new BridgeClient();
      expect(await client.health()).toEqual(health);
      expect(await client.op({ op: "meta.ping" })).toEqual({ ok: false, error: "selector missing" });
      for (const status of [401, 503, 504]) expect(await client.health()).toMatchObject({ ok: false, hint: expect.stringContaining(String(status)) });
      expect(await client.health()).toMatchObject({ ok: false, error: expect.stringContaining("non-JSON") });
      expect(await client.health()).toEqual({});
      expect(fixture.requests()).toBe(7);
    } finally { await fixture.close(); }
  });
});

describe("BridgeClient canonical HTTP options and receipts", () => {
  const invalidOptions = [
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: NaN },
    { timeoutMs: Infinity }, { timeoutMs: 1.5 }, { timeoutMs: 1_800_001 },
    { maxBytes: 0 }, { maxBytes: -1 }, { maxBytes: NaN },
    { maxBytes: Infinity }, { maxBytes: 1.5 }, { maxBytes: 16 * 1024 * 1024 + 1 },
  ];

  it.each(invalidOptions)("rejects invalid options before dispatch: %j", async options => {
    let calls = 0;
    vi.stubGlobal("fetch", ((...args: Parameters<typeof fetch>) => {
      calls++;
      return nativeFetch(...args);
    }) as typeof fetch);
    const fixture = await serve((_path, res) => res.end(JSON.stringify(health)));
    try {
      expect(await new BridgeClient(options).health()).toMatchObject({
        ok: false,
        error: expect.stringContaining("Invalid Bridge HTTP options"),
      });
      expect(calls).toBe(0);
      expect(fixture.requests()).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  it("admits split UTF-8 at the exact byte bound and rejects one byte below", async () => {
    const text = JSON.stringify({ ok: true, value: "😀" });
    const bytes = Buffer.from(text);
    const emoji = bytes.indexOf(Buffer.from("😀"));
    const fixture = await serve((_path, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write(bytes.subarray(0, emoji + 2));
      setImmediate(() => res.end(bytes.subarray(emoji + 2)));
    });
    try {
      expect(await new BridgeClient({ maxBytes: bytes.length }).op({ op: "meta.ping" }))
        .toEqual({ ok: true, value: "😀" });
      expect(await new BridgeClient({ maxBytes: bytes.length - 1 }).op({ op: "meta.ping" }))
