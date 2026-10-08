import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { voyageEmbed } from "./voyageEmbed.js";
import { voyageContextEmbed } from "./voyageContextEmbed.js";
import { voyageRerank } from "./voyageRerank.js";

const lanes = [
  { name: "embedding", call: (options: Parameters<typeof voyageEmbed>[1]) => voyageEmbed(["one"], options), fallback: [] },
  { name: "contextual embedding", call: (options: Parameters<typeof voyageContextEmbed>[1]) => voyageContextEmbed([["one"]], options), fallback: [] },
  { name: "rerank", call: (options: Parameters<typeof voyageRerank>[2]) => voyageRerank("query", ["one", "two"], options), fallback: [{ index: 0, score: 2 }, { index: 1, score: 1 }] },
];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe.each(lanes)("Voyage $name transport", ({ call, fallback }) => {
  it("bounds streamed bytes and awaits cancellation of an oversized response", async () => {
    let canceled = false, chunks = 0;
    // Non-ASCII content exceeds the byte bound sooner than a character count.
    const chunk = new TextEncoder().encode("é".repeat(32_768));
    const body = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(chunk); },
      async cancel() { await new Promise(resolve => setImmediate(resolve)); canceled = true; },
    });
    const response = new Response(body, { headers: { "content-length": "1" } });
    expect(await call({ apiKey: "fixture-key", fetchImpl: async () => response })).toEqual(fallback);
    expect(canceled).toBe(true);
    expect(chunks).toBeLessThan(260);
    expect(body.locked).toBe(false);
  });
  it("does not dispatch an already aborted caller", async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn(async () => Response.json({ data: [] }));
    expect(await call({ apiKey: "fixture-key", fetchImpl, signal: controller.signal })).toEqual(fallback);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it("closes native HTTP body I/O when its caller aborts after headers", async () => {
    let headers!: () => void, close!: () => void;
    const received = new Promise<void>(resolve => { headers = resolve; });
    const closed = new Promise<void>(resolve => { close = resolve; });
    const server = createServer((_request, response) => {
      response.writeHead(200); response.write("{"); headers();
      response.once("close", close);
    });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("fixture address missing");
    const controller = new AbortController();
    const result = call({ apiKey: "fixture-key", endpoint: `http://127.0.0.1:${address.port}`, signal: controller.signal });
    await received; controller.abort();
    expect(await result).toEqual(fallback);
    await closed;
  });
});
