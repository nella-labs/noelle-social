import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createGcsHttpRequest } from "./gcsHttp.js";
import { createGoogleCredentialClient } from "./googleCredentials.js";

afterEach(() => vi.useRealTimers());
const url = "https://storage.invalid/fixture";
it("does not prepare request bodies while busy or after expired credentials", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const getAccessToken = vi.fn(async (_timeoutMs: number) => { await gate; return "fixture-token"; });
  const fetchImpl = vi.fn(), prepare = vi.fn(() => ({ method: "POST", body: Buffer.from("fixture") }));
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const request = createGcsHttpRequest({ getAccessToken, fetchImpl, timeoutMs: 1000 });
  const pending = Array.from({ length: 32 }, () => request(url, prepare).catch(error => error));
  try {
    await expect(request(url, prepare)).rejects.toThrow("busy");
    expect(prepare).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000); release(); await Promise.all(pending);
    expect(fetchImpl).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  } finally { release(); await Promise.all(pending); vi.useRealTimers(); }
});
it.each([0, -1, 0.5, NaN, Infinity, 16 * 1024 * 1024 + 1])("rejects body budget %s before authentication", async maxBytes => {
  const getAccessToken = vi.fn(async () => "fixture-token"), fetchImpl = vi.fn();
  await expect(createGcsHttpRequest({ getAccessToken, fetchImpl })(url, {}, { maxBytes })).rejects.toThrow(RangeError);
  expect(getAccessToken).not.toHaveBeenCalled(); expect(fetchImpl).not.toHaveBeenCalled();
});
it("shares four active requests and thirty-two admissions across GCS request factories", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const getAccessToken = vi.fn(async (_timeoutMs: number) => { await gate; return "fixture-token"; });
  const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const pending = Array.from({ length: 32 }, () => createGcsHttpRequest({ getAccessToken, fetchImpl, timeoutMs: 1000 })(url).catch(error => error));
  try {
    await expect(createGcsHttpRequest({ getAccessToken, fetchImpl })(url)).rejects.toThrow("busy");
    expect(getAccessToken).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1000); release(); await Promise.all(pending);
    expect(getAccessToken).toHaveBeenCalledTimes(4); expect(fetchImpl).not.toHaveBeenCalled();
  } finally { release(); await Promise.all(pending); vi.useRealTimers(); }
  expect((await createGcsHttpRequest({ getAccessToken, fetchImpl })(url)).response.ok).toBe(true);
});
it("passes the remaining queued budget to the credential owner", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const getAccessToken = vi.fn(async (_timeoutMs: number) => { await gate; return "fixture-token"; });
  const fetchImpl = async () => Response.json({ ok: true });
  vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
  const request = createGcsHttpRequest({ getAccessToken, fetchImpl, timeoutMs: 1000 });
  const active = Array.from({ length: 4 }, () => request(url));
  const queued = request(url);
  try {
    await vi.advanceTimersByTimeAsync(400); release(); await Promise.all([...active, queued]);
    expect(getAccessToken.mock.calls.slice(0, 4).map(args => args[0])).toEqual([1000,1000,1000,1000]);
    expect(getAccessToken.mock.calls[4]?.[0]).toBe(600);
  } finally { release(); await Promise.all([...active, queued]); vi.useRealTimers(); }
});
it("awaits real credential socket termination and never dispatches object I/O after auth timeout", async () => {
  let stall = false, closed = false, admit!: () => void, requests = 0;
  const admitted = new Promise<void>(resolve => { admit = resolve; });
  const server = createServer((_request, response) => {
    requests++; response.writeHead(200, { "content-type": "application/json", "metadata-flavor": "Google" });
    if (stall) { response.once("close", () => { closed = true; }); response.write('{"access_token":'); admit(); }
    else response.end(JSON.stringify({ access_token: "fixture-token", expires_in: -1, token_type: "Bearer" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No credential fixture address");
  const client = createGoogleCredentialClient({ compute: true, metadataHost: `127.0.0.1:${address.port}`, authOptions: { projectId: "fixture" } });
  const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
  try {
    expect(await client.getAccessToken()).toBe("fixture-token"); stall = true;
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    const request = createGcsHttpRequest({ getAccessToken: timeout => client.getAccessToken(timeout), fetchImpl, timeoutMs: 80 });
    const pending = request(url).catch(error => error);
    await admitted; await vi.advanceTimersByTimeAsync(80);
    expect(await pending).toMatchObject({ name: "GcsAuthenticationError" });
    await vi.waitFor(() => expect(closed).toBe(true)); expect(fetchImpl).not.toHaveBeenCalled();
    vi.useRealTimers(); const count = requests; await delay(60); expect(requests).toBe(count);
    stall = false;
    expect((await createGcsHttpRequest({ getAccessToken: timeout => client.getAccessToken(timeout), fetchImpl })(url)).response.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers(); await client.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}, 10_000);
