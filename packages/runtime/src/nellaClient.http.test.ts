import { createServer } from "node:http";
import { expect, it, vi } from "vitest";
import { createNellaClient } from "./nellaClient.js";

it("bounds an actual hosted search body before parsing its source chunks", async () => {
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: { results: [{
      chunk: { filePath: "voice/sample.md", content: "x".repeat(4 * 1024 * 1024), startLine: 1, endLine: 1 }, score: 1,
    }] } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listen failed");
  try {
    const client = createNellaClient({ apiKey: "synthetic", baseUrl: `http://127.0.0.1:${address.port}` });
    await expect(client.searchContext({ workspace: "fixture", query: "shipping", topK: 1 })).rejects.toMatchObject({ name: "NellaError", message: expect.stringContaining("body_too_large") });
  } finally {
    vi.useRealTimers();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

it("does not report a ready receipt while its actual response body remains open", async () => {
  let admit!: () => void, close!: () => void;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const closed = new Promise<void>(resolve => { close = resolve; });
  const server = createServer((req, res) => {
    req.resume(); res.once("close", close); admit();
    res.writeHead(200, { "content-type": "application/json" }); res.write('{"ready":true}');
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listen failed");
  try {
    let receive!: () => void;
    const received = new Promise<void>(resolve => { receive = resolve; });
    const client = createNellaClient({ apiKey: "synthetic", baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 30,
      fetchImpl: async (...args) => { const response = await fetch(...args); receive(); return response; } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = client.ready();
    await admitted; await received;
    await vi.advanceTimersByTimeAsync(30);
    expect(await pending).toBe(false);
    await closed;
  } finally {
    vi.useRealTimers();
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
