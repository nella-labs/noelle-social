import { createServer, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ endpoint: "" }));
vi.mock("@google-cloud/storage", async importOriginal => {
  const { Storage } = await importOriginal<typeof import("@google-cloud/storage")>();
  return { Storage: class extends Storage {
    constructor() { super({ apiEndpoint: fixture.endpoint, projectId: "fixture", useAuthWithCustomEndpoint: false,
      retryOptions: { autoRetry: false } }); }
  } };
});
vi.mock("./googleCredentials.js", () => ({ defaultGoogleCredentialClient: () => ({
  getAccessToken: async () => "fixture-token",
}) }));
import { createGcsNellaClientWithSdk } from "./gcsAnchorSource.js";

afterEach(() => vi.unstubAllEnvs());
async function serve(handler: (url: URL, response: ServerResponse) => void) {
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => handler(new URL(request.url!, fixture.endpoint), response));
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("No fixture address");
  fixture.endpoint = `http://127.0.0.1:${address.port}`;
  return { sockets, async close() {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
function json(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(value));
}
const item = { name: "fixture/a.md", bucket: "fixture-bucket", size: "8", generation: "7", metageneration: "3", updated: "2026-10-06T00:00:00Z" };

it("checks readiness with one bounded native metadata page", async () => {
  let requests = 0;
  const server = await serve((url, response) => {
    requests++;
    json(response, requests < 4 ? { items: [], nextPageToken: `page${requests}` } : { items: [] });
    expect(url.pathname).toBe("/storage/v1/b/fixture-bucket/o");
  });
  try {
    const client = await createGcsNellaClientWithSdk({ bucket: "fixture-bucket" });
    expect(await client.ready()).toBe(true); expect(requests).toBe(1);
  } finally { await server.close(); }
});
it("pins native markdown downloads to their listed generation", async () => {
  let download: URL | undefined;
  const server = await serve((url, response) => {
    if (url.searchParams.get("alt") === "media") { download = url; response.end("shipping"); }
    else json(response, { items: [item] });
  });
  try {
    const client = await createGcsNellaClientWithSdk({ bucket: "fixture-bucket" });
    expect(await client.searchContext({ workspace: "mars-fixture", query: "shipping" })).toHaveLength(1);
    expect(download?.searchParams.get("generation")).toBe("7");
    expect(download?.searchParams.get("ifMetagenerationMatch")).toBe("3");
  } finally { await server.close(); }
});
it("rejects native oversized source bytes without publishing a partial index", async () => {
  const server = await serve((url, response) => {
    if (url.searchParams.get("alt") === "media") response.end("shipping " + "a".repeat(200_000));
    else json(response, { items: [{ ...item, size: "200009" }] });
  });
  try {
    const client = await createGcsNellaClientWithSdk({ bucket: "fixture-bucket" });
    await expect(client.searchContext({ workspace: "mars-fixture", query: "shipping" })).rejects.toThrow(/limit|large/);
  } finally { await server.close(); }
});
it("loads complete native metadata pages without automatic traversal or generation drift", async () => {
  const pages: string[] = [], generations: string[] = [];
  const server = await serve((url, response) => {
    if (url.searchParams.get("alt") === "media") {
      generations.push(url.searchParams.get("generation")!); response.end("shipping");
    } else {
      expect(url.searchParams.get("maxResults")).toBe("100");
      const token = url.searchParams.get("pageToken"); pages.push(token ?? "first");
      json(response, token ? { items: [{ ...item, name: "fixture/b.md", generation: "8" }] }
        : { items: [item], nextPageToken: "second" });
    }
  });
  try {
    const client = await createGcsNellaClientWithSdk({ bucket: "fixture-bucket" });
    const hits = await client.searchContext({ workspace: "mars-fixture", query: "shipping" });
    expect(hits).toHaveLength(2); expect(pages).toEqual(["first", "second"]); expect(generations.sort()).toEqual(["7", "8"]);
  } finally { await server.close(); }
});
it("cancels native source bytes that exceed a dishonest metadata size", async () => {
  let closed = false;
  const server = await serve((url, response) => {
    if (url.searchParams.get("alt") === "media") {
      response.once("close", () => { closed = true; });
      response.write("shipping " + "a".repeat(200_000));
    } else json(response, { items: [item] });
  });
  try {
    const client = await createGcsNellaClientWithSdk({ bucket: "fixture-bucket", timeoutMs: 1000 });
    await expect(client.searchContext({ workspace: "mars-fixture", query: "shipping" })).rejects.toThrow(/limit|large/);
    await vi.waitFor(() => expect(closed).toBe(true));
  } finally { await server.close(); }
});
it("closes an unfinished native source body before retrying a healthy load", async () => {
  let closed = false, healthy = false, downloads = 0;
  const server = await serve((url, response) => {
    if (url.searchParams.get("alt") === "media") {
      downloads++; response.once("close", () => { closed = true; });
      if (healthy) response.end("shipping"); else response.write("shipping");
    } else json(response, { items: [item] });
  });
  try {
    const client = await createGcsNellaClientWithSdk({ bucket: "fixture-bucket", timeoutMs: 1000 });
    await expect(client.searchContext({ workspace: "mars-fixture", query: "shipping" })).rejects.toMatchObject({ code: "timeout" });
    await vi.waitFor(() => expect(closed).toBe(true)); healthy = true;
    expect(await client.searchContext({ workspace: "mars-fixture", query: "shipping" })).toHaveLength(1);
    expect(downloads).toBe(2);
  } finally { await server.close(); }
});

it.each(["transcoded", "gzip"])("reads generation-pinned %s gzip markdown without comparing decoded bytes to stored checksums", async mode => {
  const stored = gzipSync("shipping");
  const server = await serve((url, response) => {
    if (url.searchParams.get("alt") === "media") {
      if (mode === "gzip") response.setHeader("content-encoding", "gzip");
      response.end(mode === "gzip" ? stored : "shipping");
    } else json(response, { items: [{ ...item, size: String(stored.length), contentEncoding: "gzip",
      md5Hash: createHash("md5").update(stored).digest("base64") }] });
  });
  try {
    const client = await createGcsNellaClientWithSdk({ bucket: "fixture-bucket" });
    expect(await client.searchContext({ workspace: "mars-fixture", query: "shipping" })).toHaveLength(1);
  } finally { await server.close(); }
});

it("bounds actual decoded gzip source bytes before indexing", async () => {
  const stored = gzipSync("shipping " + "a".repeat(200_000));
  const server = await serve((url, response) => {
    if (url.searchParams.get("alt") === "media") {
      response.setHeader("content-encoding", "gzip"); response.end(stored);
    } else json(response, { items: [{ ...item, size: String(stored.length), contentEncoding: "gzip" }] });
  });
  try {
    const client = await createGcsNellaClientWithSdk({ bucket: "fixture-bucket" });
    await expect(client.searchContext({ workspace: "mars-fixture", query: "shipping" })).rejects.toMatchObject({ code: "body_too_large" });
  } finally { await server.close(); }
});
