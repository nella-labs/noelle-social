import { afterEach, describe, expect, it, vi } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { createServer, type Server, type RequestListener } from "node:http";
import { generateKeyPairSync, verify } from "node:crypto";
import type { GoogleAuthOptions } from "google-auth-library";

type Client = { getAccessToken(timeoutMs?: number): Promise<string>; getCredentials(timeoutMs?: number): Promise<Record<string, string>>;
  sign(data: string, endpoint?: string, timeoutMs?: number): Promise<string>; close(): Promise<void> };
const clients: Client[] = [];
const servers: Server[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(clients.splice(0).map(c => c.close()));
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); });
async function create(options: { authOptions?: GoogleAuthOptions; compute?: boolean; metadataHost?: string; timeoutMs?: number; maxQueue?: number; idleMs?: number }): Promise<Client> {
  const path = "./googleCredentials.js";
  const api = await import(path).catch(() => ({}));
  expect(api.createGoogleCredentialClient, "bounded credential owner must exist").toBeTypeOf("function");
  const client = api.createGoogleCredentialClient(options); clients.push(client); return client;
}
async function endpoint(handler: RequestListener) {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture listen failed");
  return `http://127.0.0.1:${address.port}`;
}
function oauth(url: string): GoogleAuthOptions { return { projectId: "fixture-project", credentials: {
  type: "authorized_user", client_id: "synthetic-client", client_secret: "synthetic-secret", refresh_token: "synthetic-refresh" },
  clientOptions: { endpoints: { oauth2TokenUrl: url } } }; }

describe("owned Google credential operations", () => {
  it("keeps its fixed worker independent of parent module flags", async () => {
    const url = await endpoint((_req, res) => { res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600, token_type: "Bearer" })); });
    const args = [...process.execArgv];
    process.execArgv.push("--input-type=module");
    try { expect(await (await create({ authOptions: oauth(url) })).getAccessToken()).toBe("synthetic-token"); }
    finally { process.execArgv.splice(0, process.execArgv.length, ...args); }
  });
  it("returns all eight parallel token requests through actual GoogleAuth", async () => {
    let requests = 0;
    const url = await endpoint((_req, res) => { requests++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600, token_type: "Bearer" })); });
    const client = await create({ authOptions: oauth(url), timeoutMs: 3000 });
    expect(await Promise.all(Array.from({ length: 8 }, () => client.getAccessToken()))).toEqual(Array(8).fill("synthetic-token"));
    expect(requests).toBe(1);
  });
  it.each(["oauth", "compute"])("terminates %s body I/O before returning a deadline error and recovers", async kind => {
    let requests = 0, stall = false;
    let admit!: () => void, close!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const closed = new Promise<void>(resolve => { close = resolve; });
    const url = await endpoint((_req, res) => {
      requests++; if (stall) { res.once("close", close); admit(); }
      res.writeHead(200, { "content-type": "application/json", "metadata-flavor": "Google" });
      if (stall) res.write('{"access_token":"synthetic-token",');
      else res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: -1, token_type: "Bearer" }));
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const client = await create({ timeoutMs: 3000, ...(kind === "oauth" ? { authOptions: oauth(url) }
      : { compute: true, metadataHost: url.slice(7), authOptions: { projectId: "fixture-project" } }) });
    expect(await client.getAccessToken()).toBe("synthetic-token");
    stall = true;
    const pending = client.getAccessToken(80).catch(error => error);
    await admitted;
    await vi.advanceTimersByTimeAsync(80);
    expect(await pending).toMatchObject({ name: "GoogleCredentialError", code: "timeout", operation: "token" });
    await closed;
    vi.useRealTimers();
    const after = requests;
    await new Promise(resolve => setTimeout(resolve, 100)); expect(requests).toBe(after);
    stall = false; expect(await client.getAccessToken()).toBe("synthetic-token");
  });
  it("expires queued work before SDK dispatch and rejects excess admission", async () => {
    let requests = 0;
    let received!: () => void; const requested = new Promise<void>(resolve => { received = resolve; });
    const url = await endpoint((_req, res) => { requests++; res.write('{"access_token":'); received(); });
    const client = await create({ authOptions: oauth(url), timeoutMs: 3000, maxQueue: 2 });
    const active = client.getAccessToken(1000).catch(error => error);
    await requested;
    const queued = client.getCredentials(30);
    await expect(client.sign("data")).rejects.toMatchObject({ code: "busy" });
    await expect(queued).rejects.toMatchObject({ code: "timeout", operation: "metadata" });
    expect(requests).toBe(1);
    await client.close(); expect(await active).toMatchObject({ code: "closed" });
  });
  it("rejects overdue queued work even when the timer callback has not run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finish!: () => void, received!: () => void;
    const requested = new Promise<void>(resolve => { received = resolve; });
    let client: Client | undefined;
    try {
      const url = await endpoint((_req, res) => { received(); finish = () => {
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600, token_type: "Bearer" })); }; });
      client = await create({ authOptions: oauth(url) });
      const active = client.getAccessToken(); await requested;
      const queued = client.getCredentials(10).catch(error => error);
      await delay(30); finish();
      expect(await active).toBe("synthetic-token"); expect(await queued).toMatchObject({ code: "timeout", operation: "metadata" });
    } finally { await client?.close(); vi.useRealTimers(); }
  });
  it("rejects an overdue SDK result even when the timer callback has not run", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let client: Client | undefined;
    try {
      const url = await endpoint(async (_req, res) => { await delay(30); res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600, token_type: "Bearer" })); });
      client = await create({ authOptions: oauth(url) });
      await expect(client.getAccessToken(10)).rejects.toMatchObject({ code: "timeout" });
    } finally { await client?.close(); vi.useRealTimers(); }
  });
  it("keeps private keys inside the worker while preserving SDK signing", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const client = await create({ authOptions: { projectId: "fixture-project", credentials: { type: "service_account",
      client_email: "fixture@project.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() } } });
    expect(await client.getCredentials()).toEqual({ client_email: "fixture@project.iam.gserviceaccount.com" });
    const signature = await client.sign("canonical signing input");
    expect(verify("RSA-SHA256", Buffer.from("canonical signing input"), publicKey, Buffer.from(signature, "base64"))).toBe(true);
  });
  it("sanitizes SDK failures", async () => {
    const url = await endpoint((_req, res) => { res.statusCode = 400; res.end(JSON.stringify({ error: "synthetic-secret should stay private" })); });
    const client = await create({ authOptions: oauth(url) });
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: "failed", message: "Google credential token failed" });
  });
  it("rejects a successful numeric Compute token receipt", async () => {
    const url = await endpoint((_req, res) => { res.writeHead(200, { "content-type": "application/json", "metadata-flavor": "Google" });
      res.end(JSON.stringify({ access_token: 123, expires_in: 3600, token_type: "Bearer" })); });
    const client = await create({ compute: true, metadataHost: url.slice(7), authOptions: { projectId: "fixture-project" } });
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: "invalid_response" });
  });
  it("rejects invalid credential metadata without returning private fields", async () => {
    const client = await create({ authOptions: { projectId: "fixture-project", credentials: { type: "authorized_user",
      client_id: "synthetic-client", client_secret: "synthetic-secret", refresh_token: "synthetic-refresh", client_email: 123 as unknown as string } } });
    await expect(client.getCredentials()).rejects.toMatchObject({ code: "invalid_response", operation: "metadata" });
  });
  it("cancels actual SDK IAM signing body I/O and preserves normal signing", async () => {
    let stall = true;
    let admit!: () => void, close!: () => void;
    const admitted = new Promise<void>(resolve => { admit = resolve; });
    const closed = new Promise<void>(resolve => { close = resolve; });
    const url = await endpoint((req, res) => {
      res.setHeader("content-type", "application/json");
      if (!req.url?.includes(":signBlob")) { res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600, token_type: "Bearer" })); return; }
      if (stall) { res.once("close", close); admit(); }
      if (stall) res.write('{"signedBlob":'); else res.end(JSON.stringify({ signedBlob: "c2ln" }));
    });
    const options = oauth(url); options.credentials = { ...options.credentials, client_email: "fixture@project.iam.gserviceaccount.com" };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const client = await create({ authOptions: options });
    expect(await client.getAccessToken()).toBe("synthetic-token");
    const pending = client.sign("canonical input", `${url}/`, 80).catch(error => error);
    await admitted;
    await vi.advanceTimersByTimeAsync(80);
    expect(await pending).toMatchObject({ code: "timeout", operation: "sign" });
    await closed;
    vi.useRealTimers();
    stall = false; expect(await client.sign("canonical input", `${url}/`)).toBe("c2ln");
  });
  it("rejects overlarge signing input before credential dispatch", async () => {
    let requests = 0;
    const url = await endpoint((_req, res) => { requests++; res.end("{}"); });
    const client = await create({ authOptions: oauth(url) });
    await expect(client.sign("x".repeat(65537))).rejects.toMatchObject({ code: "invalid_request", operation: "sign" }); expect(requests).toBe(0);
  });
  it("does not close an independent owner when another times out", async () => {
    const healthy = await endpoint((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ access_token: "healthy", expires_in: 3600, token_type: "Bearer" })); });
    const stalled = await endpoint((_req, res) => res.write('{"access_token":'));
    const one = await create({ authOptions: oauth(healthy) }); const two = await create({ authOptions: oauth(stalled) });
    expect(await one.getAccessToken()).toBe("healthy");
    await expect(two.getAccessToken(300)).rejects.toMatchObject({ code: "timeout" });
    expect(await one.getAccessToken()).toBe("healthy");
  });
  it("reports process-group cleanup failure and closes admission", async () => {
    const { GoogleCredentialsOwner } = await import("./googleCredentialsOwner.js");
    let stall = false;
    let received!: () => void; const requested = new Promise<void>(resolve => { received = resolve; });
    const url = await endpoint((_req, res) => { res.setHeader("content-type", "application/json");
      if (stall) { res.write('{"access_token":'); received(); } else res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: -1, token_type: "Bearer" })); });
    const owner = new GoogleCredentialsOwner({ authOptions: oauth(url) });
    expect(await owner.request("token", [])).toBe("synthetic-token");
    const groupPid = (owner as unknown as { worker?: { pid?: number } }).worker?.pid;
    expect(groupPid).toBeGreaterThan(0);
    const independent = await create({ authOptions: oauth(url) });
    expect(await independent.getAccessToken()).toBe("synthetic-token");
    stall = true; const pending = owner.request("token", []).catch(error => error); await requested;
    const original = process.kill.bind(process);
    const fault = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -groupPid!) throw Object.assign(new Error("synthetic group fault"), { code: "EPERM" }); return original(pid, signal);
    });
    try {
      await independent.close();
      await expect(owner.close()).rejects.toMatchObject({ code: "cleanup_failed" });
      expect(await pending).toMatchObject({ code: "cleanup_failed" });
      await expect(owner.request("token", [])).rejects.toMatchObject({ code: "closed" });
    } finally { fault.mockRestore(); await owner.close(); }
  });
  it("closes idle workers and can serve a later request", async () => {
    let requests = 0;
    const url = await endpoint((_req, res) => { requests++; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600, token_type: "Bearer" })); });
    const client = await create({ authOptions: oauth(url), idleMs: 20 });
    expect(await client.getAccessToken()).toBe("synthetic-token");
    await new Promise(resolve => setTimeout(resolve, 80));
    expect(await client.getAccessToken()).toBe("synthetic-token"); expect(requests).toBe(2);
  });
});
