import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type { Socket } from "node:net";
import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ endpoint: "",
  metadata: vi.fn(async () => ({ client_email: "fixture@example.invalid" })),
  sign: vi.fn(async (_data: string, _endpoint?: string, _timeoutMs?: number) => Buffer.from("fixture-signature").toString("base64")),
}));
vi.mock("@google-cloud/storage", async importOriginal => {
  const { Storage } = await importOriginal<typeof import("@google-cloud/storage")>();
  return { Storage: class extends Storage {
    constructor(options: ConstructorParameters<typeof Storage>[0] = {}) {
      super({ ...options, apiEndpoint: fixture.endpoint, projectId: "fixture", useAuthWithCustomEndpoint: false,
        retryOptions: { autoRetry: false } });
    }
  } };
});
vi.mock("./googleCredentials.js", () => ({ defaultGoogleCredentialClient: () => ({
  getAccessToken: async () => "fixture-token", getCredentials: fixture.metadata, sign: fixture.sign,
}) }));
import { createGcsStorage, createVaultStorage, type StorageDeps } from "./vaultStorage.js";

it.each(["list", "read", "write", "delete"] as const)("closes the actual unfinished vault %s response before returning", async operation => {
  let closed = false;
  const sockets = new Set<Socket>();
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" }); response.write("{");
    response.once("close", () => { closed = true; });
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No vault fixture address");
  fixture.endpoint = `http://127.0.0.1:${address.port}`;
  let pending: Promise<unknown> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const factory = createGcsStorage as unknown as (options: { timeoutMs: number }) => Promise<StorageDeps>;
    const storage = createVaultStorage(await factory({ timeoutMs: 100 }));
    const scope = { bucket: "fixture", prefix: "fixture/", filename: "a.md" };
    pending = operation === "list" ? storage.list(scope)
      : operation === "read" ? storage.readText(scope)
      : operation === "write" ? storage.writeText({ ...scope, body: "shipping" })
      : storage.delete(scope);
    const completion = Promise.race([pending, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Vault body deadline missed")), 500);
    })]);
    await expect(completion).rejects.toMatchObject({ code: "timeout" });
    await vi.waitFor(() => expect(closed).toBe(true));
  } finally {
    clearTimeout(timer); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await pending?.catch(() => {});
    await vi.waitFor(() => expect(sockets.size).toBe(0));
  }
});

it("uses the actual vault factory for complete pages, exact text receipts, gzip reads and canonical signing", async () => {
  const key = "tenant/nested/a.md", body = "\ufeffshipping 🚀";
  const methods: string[] = [];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, "http://fixture.invalid"); methods.push(request.method!);
    expect(request.headers.authorization).toBe("Bearer fixture-token");
    if (request.method === "POST") {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const bytes = Buffer.concat(chunks);
      expect(url.searchParams.get("name")).toBe(key); expect(url.searchParams.get("ifGenerationMatch")).toBeNull();
      expect(request.headers["content-type"]).toBe("text/markdown"); expect(bytes.toString("utf8")).toBe(body);
      response.end(JSON.stringify({ bucket: "fixture", name: key, size: String(bytes.length), md5Hash: createHash("md5").update(bytes).digest("base64") }));
    } else if (request.method === "DELETE") { response.writeHead(204); response.end(); }
    else if (url.searchParams.get("alt") === "media") {
      response.writeHead(200, { "content-encoding": "gzip" }); response.end(gzipSync(Buffer.from(body)));
    } else {
      expect(url.searchParams.get("prefix")).toBe("tenant/"); expect(url.searchParams.get("maxResults")).toBe("100");
      const more = url.searchParams.get("pageToken") === "more";
      response.end(JSON.stringify({ items: [{ name: more ? key : "tenant/b.md", bucket: "fixture", size: "8",
        updated: "2026-10-06T00:00:00Z", generation: "1", metageneration: "1" }], ...(more ? {} : { nextPageToken: "more" }) }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No vault fixture address");
  fixture.endpoint = `http://127.0.0.1:${address.port}`; fixture.metadata.mockClear(); fixture.sign.mockClear();
  try {
    const storage = createVaultStorage(await createGcsStorage({ timeoutMs: 1000 }));
    const scope = { bucket: "fixture", prefix: "tenant/", filename: "nested/a.md" };
    expect((await storage.list(scope)).map(file => file.path)).toEqual(["tenant/b.md", key]);
    await storage.writeText({ ...scope, body }); expect(await storage.readText(scope)).toBe(body);
    await storage.delete(scope);
    const signed = new URL(await storage.signUpload({ ...scope, contentType: "text/markdown" }));
    expect(signed.pathname).toBe(`/fixture/${key}`); expect(signed.searchParams.get("X-Goog-Expires")).toBe("600");
    expect(fixture.metadata).toHaveBeenCalledOnce(); expect(fixture.sign).toHaveBeenCalledOnce();
    expect(fixture.sign.mock.calls[0]?.[0]).toMatch(/^GOOG4-RSA-SHA256\n/);
    expect(methods).toEqual(["GET", "GET", "POST", "GET", "DELETE"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

it.each(["oversized", "malformed"])("holds an actual %s cloud preview body", async kind => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-encoding": "gzip" });
    response.end(gzipSync(kind === "oversized" ? Buffer.alloc(4 * 1024 * 1024 + 1) : Buffer.from([255])));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No vault fixture address");
  fixture.endpoint = `http://127.0.0.1:${address.port}`;
  try {
    const storage = createVaultStorage(await createGcsStorage({ timeoutMs: 1000 }));
    const pending = storage.readText({ bucket: "fixture", prefix: "tenant/", filename: "a.md" });
    if (kind === "oversized") await expect(pending).rejects.toMatchObject({ code: "body_too_large" });
    else await expect(pending).rejects.toThrow(/encoding|UTF/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
