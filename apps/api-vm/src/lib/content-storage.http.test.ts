import { createServer } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../env.js";

const state = vi.hoisted(() => ({ endpoint: "" }));
vi.mock("@noelle/runtime/google-credentials", () => ({ createGoogleCredentialClient: () => ({
  getAccessToken: async () => "fixture-token", getCredentials: async () => ({}),
  sign: async () => "", close: async () => {},
}) }));
vi.mock("@google-cloud/storage", async importOriginal => {
  const { Storage } = await importOriginal<typeof import("@google-cloud/storage")>();
  return { Storage: class extends Storage {
    constructor() {
      super({ apiEndpoint: state.endpoint, projectId: "fixture", timeout: 20,
        retryOptions: { autoRetry: false } });
      Object.defineProperty(this, "authClient", { value: { getAccessToken: async () => "fixture-token" } });
    }
  } };
});
import { getContentStorage, resetContentStorageForTests } from "./content-storage.js";

const env = { NOELLE_MEDIA_BACKEND: "gcs", NOELLE_MEDIA_BUCKET: "fixture-bucket" } as Env;
afterEach(async () => { await resetContentStorageForTests(); });
describe("content storage full-body cancellation", () => {
  it.each(["put", "delete"] as const)("closes stalled native %s body I/O before returning", async operation => {
    let admit!: () => void, receive!: () => void, close!: () => void;
    let requests = 0, bodyClosed = false, settled = false;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const received = new Promise<void>(resolve => { receive = resolve; });
    const requestClosed = new Promise<void>(resolve => { close = resolve; });
    const sockets = new Set<Socket>();
    const socketTails: Promise<void>[] = [];
    let requestSocket: Socket | undefined;
    const server = createServer((request, response) => {
      requests++;
      request.resume();
      requestSocket = request.socket;
      request.socket.once("close", close);
      response.once("close", () => { bodyClosed = true; });
      response.writeHead(200, { "content-type": "application/json" }); response.write("{");
      admit();
    });
    server.on("connection", socket => {
      sockets.add(socket);
      socketTails.push(new Promise<void>(resolve => {
        socket.once("close", () => { sockets.delete(socket); resolve(); });
      }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("missing server address");
    state.endpoint = `http://127.0.0.1:${address.port}`;
    const storage = getContentStorage(env);
    const cleanup = new AbortController();
    const guard = delay(2000, undefined, { signal: cleanup.signal }).then(() => {
      throw Error("native storage fixture admission or close timed out");
    });
    const nativeFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const response = await nativeFetch(input, init);
      receive();
      return response;
    });
    let pending: Promise<unknown> | undefined;
    try {
      vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
      const operationPending = operation === "put" ? storage.put({ key: "org/media/asset.png", bytes: new Uint8Array([1]), contentType: "image/png" })
        : storage.delete("org/media/asset.png");
      pending = operationPending.then(value => { settled = true; return value; }, error => { settled = true; return error; });
      await Promise.race([Promise.all([admitted, received]), guard]);
      expect(requests).toBe(1);
      expect(bodyClosed).toBe(false);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(20);
      const error = await Promise.race([pending, guard]);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/timed out|timeout/i);
      await Promise.race([requestClosed, guard]);
      expect(bodyClosed).toBe(true);
      expect(requestSocket?.destroyed).toBe(true);
      expect(requests).toBe(1);
    } finally {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(20);
      vi.useRealTimers();
      const serverClosed = new Promise<void>(resolve => server.close(() => resolve()));
      server.closeAllConnections();
      await serverClosed;
      await Promise.all(socketTails);
      await pending;
      cleanup.abort();
      await guard.catch(() => {});
      fetchSpy.mockRestore();
      expect(sockets.size).toBe(0);
    }
  });
});
