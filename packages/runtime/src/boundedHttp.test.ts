import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBoundedHttpFetch, decodeHttpJson, fetchBoundedHttpResponse, HttpBodyError,
  readBoundedHttpBytes, readBoundedHttpJson, readBoundedHttpText } from "./boundedHttp.js";

const servers: Server[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

async function slowServer(mode: "headers" | "body") {
  let close!: () => void;
  const closed = new Promise<void>((resolve) => { close = resolve; });
  let admit!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const server = createServer((_req, res) => {
    admit();
    if (mode === "body") { res.writeHead(200); res.write("{"); }
    const timer = setInterval(() => { if (mode === "body") res.write(" "); }, 10);
    res.once("close", () => { clearInterval(timer); close(); });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing server address");
  return { url: `http://127.0.0.1:${address.port}`, closed, admitted };
}

describe("bounded HTTP response owner", () => {
  it.each(["headers", "body"] as const)("aborts real slow %s I/O and closes its request", async (mode) => {
    const server = await slowServer(mode);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false, receive!: () => void;
    const received = new Promise<void>(resolve => { receive = resolve; });
    const pending = fetchBoundedHttpResponse(server.url, {}, { timeoutMs: 80,
      fetchImpl: async (...args) => { const response = await fetch(...args); receive(); return response; } })
      .catch(error => error).finally(() => { settled = true; });
    await server.admitted;
    if (mode === "body") await received;
    await vi.advanceTimersByTimeAsync(79);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ code: "timeout" });
    await server.closed;
  });

  it("links caller abort to a running request", async () => {
    const server = await slowServer("body");
    const controller = new AbortController();
    const pending = fetchBoundedHttpResponse(server.url, { signal: controller.signal }).catch(error => error);
    await server.admitted;
    controller.abort();
    expect(await pending).toMatchObject({ code: "aborted" });
    await server.closed;
  });

  it("never dispatches an already aborted request", async () => {
    const controller = new AbortController(); controller.abort();
    let calls = 0;
    await expect(fetchBoundedHttpResponse("https://example.test", { signal: controller.signal }, {
      fetchImpl: async () => { calls++; return new Response("{}"); },
    })).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toBe(0);
  });

  it("returns an authoritative HTTP status with its bounded error body", async () => {
    const out = await fetchBoundedHttpResponse("https://example.test", {}, {
      fetchImpl: async () => new Response('{"error":"denied"}', { status: 403 }),
    });
    expect(out.response.status).toBe(403);
    expect(decodeHttpJson(out.bytes)).toEqual({ error: "denied" });
  });

  it("preserves received HTTP status when its diagnostic body times out", async () => {
    let canceled = false;
    await expect(fetchBoundedHttpResponse("https://example.test", {}, { timeoutMs: 20,
      fetchImpl: async () => new Response(new ReadableStream({ cancel() { canceled = true; } }), { status: 401 }),
    })).rejects.toMatchObject({ code: "timeout", status: 401 });
    expect(canceled).toBe(true);
  });

  it("adapts SDK fetch hooks while preserving headers and bodyless responses", async () => {
    const sdkFetch = createBoundedHttpFetch({ fetchImpl: async () => new Response("{}", { headers: { "request-id": "receipt" } }) });
    const response = await sdkFetch("https://example.test");
    expect(await response.json()).toEqual({});
    expect(response.headers.get("request-id")).toBe("receipt");
    const noBody = await createBoundedHttpFetch({ fetchImpl: async () => new Response(null, { status: 204 }) })("https://example.test");
    expect(noBody.status).toBe(204);
    expect(noBody.body).toBeNull();
  });

  it("supports the existing ten-minute ideation deadline", async () => {
    const out = await fetchBoundedHttpResponse("https://example.test", {}, { timeoutMs: 600_000,
      fetchImpl: async () => new Response("{}") });
    expect(decodeHttpJson(out.bytes)).toEqual({});
  });

  it("counts UTF-8 bytes across chunks and cancels oversized bodies", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xf0, 0x9f]));
        controller.enqueue(new Uint8Array([0x98, 0x80]));
      },
      cancel() { canceled = true; },
    });
    const response = new Response(stream, { headers: { "content-length": "1" } });
    await expect(readBoundedHttpText(response, { maxBytes: 3 })).rejects.toMatchObject({ code: "body_too_large" });
    expect(canceled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it("decodes split multibyte text at the exact byte limit", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array([0xf0, 0x9f]));
      controller.enqueue(new Uint8Array([0x98, 0x80])); controller.close();
    } });
    expect(await readBoundedHttpText(new Response(stream), { maxBytes: 4 })).toBe("😀");
  });

  it("cancels a stalled standalone decoder when its owner aborts", async () => {
    let canceled = false;
    const controller = new AbortController();
    const response = new Response(new ReadableStream<Uint8Array>({ cancel() { canceled = true; } }));
    const pending = readBoundedHttpBytes(response, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(canceled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  it("rejects invalid JSON without including response content", async () => {
    await expect(readBoundedHttpJson(new Response("private response")))
      .rejects.toMatchObject({ code: "invalid_json", message: "HTTP response contains invalid JSON" });
  });

  it("sanitizes transport failures", async () => {
    await expect(fetchBoundedHttpResponse("https://example.test/private", {}, {
      fetchImpl: async () => { throw new Error("secret token and request body"); },
    })).rejects.toEqual(new HttpBodyError("network", "HTTP request failed"));
  });

  it.each([0, -1, Infinity, NaN, 0.5, 16 * 1024 * 1024 + 1])("rejects invalid body bound %s", async (maxBytes) => {
    await expect(readBoundedHttpBytes(new Response("x"), { maxBytes })).rejects.toBeInstanceOf(RangeError);
  });

  it.each([0, Infinity, 1_800_001])("rejects invalid timeout %s before dispatch", async (timeoutMs) => {
    let calls = 0;
    await expect(fetchBoundedHttpResponse("https://example.test", {}, { timeoutMs,
      fetchImpl: async () => { calls++; return new Response("{}"); } })).rejects.toBeInstanceOf(RangeError);
    expect(calls).toBe(0);
  });
});
