import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { jsonFile, live, modelCall, nativeBedrock, reply, serve, until } from "./bedrock.fixture.js";

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });
const keys = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_ROLE_ARN", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI", "AWS_CONTAINER_CREDENTIALS_FULL_URI"];
function environment(url: string) {
  vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", url); vi.stubEnv("BEDROCK_MOCK", "0");
  for (const key of keys) vi.stubEnv(key, "");
  vi.stubEnv("AWS_EC2_METADATA_DISABLED", "true");
}

it("stops actual AWS credential helpers and descendants before rejection, then recovers", async () => {
  const { createBedrockBackend } = await nativeBedrock();
  const dir = await mkdtemp(join(tmpdir(), "noelle-bedrock-native-"));
  const ids = join(dir, "pids.json"), beat = join(dir, "heartbeat"), mode = join(dir, "mode"), helper = join(dir, "credential.cjs");
  const config = join(dir, "config"), credentials = join(dir, "credentials");
  const descendant = `setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(beat)},'x'),10);`;
  await writeFile(helper, `const fs=require('node:fs');
    const cp=require('node:child_process');const child=cp.spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});
    fs.writeFileSync(${JSON.stringify(ids)},JSON.stringify({helper:process.pid,child:child.pid,group:Number(cp.execFileSync('ps',['-o','pgid=','-p',String(process.pid)],{encoding:'utf8'}).trim())}));
    if(fs.existsSync(${JSON.stringify(mode)})){process.stdout.write(JSON.stringify({Version:1,AccessKeyId:'fixture-access',SecretAccessKey:'fixture-secret'}));process.exit(0);}setInterval(()=>{},1000);`);
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(config, `[profile native-fixture]\ncredential_process = ${quote(process.execPath)} ${quote(helper)}\nregion = us-east-1\n`);
  await writeFile(credentials, "");
  let hits = 0;
  const server = await serve((_req, res) => { hits++; reply(res); });
  environment(server.url); vi.stubEnv("AWS_PROFILE", "native-fixture");
  vi.stubEnv("AWS_CONFIG_FILE", config); vi.stubEnv("AWS_SHARED_CREDENTIALS_FILE", credentials);
  const backend = createBedrockBackend({ mock: false, timeoutMs: 30_000 });
  let pids: { helper: number; child: number; group: number } | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    pending = backend.call(modelCall).catch(error => error);
    await until(async () => {
      pids = await jsonFile(ids);
      try { return !!pids && (await readFile(beat, "utf8")).length > 0; } catch { return false; }
    });
    expect(hits).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ name: "BedrockError", message: "bedrock call: timeout" });
    for (const pid of [pids!.helper, pids!.child, pids!.group]) expect(live(pid)).toBe(false);
    const before = await readFile(beat, "utf8"); await delay(60);
    expect(await readFile(beat, "utf8")).toBe(before); expect(hits).toBe(0);
    vi.useRealTimers(); await writeFile(mode, "healthy");
    expect(await backend.call(modelCall)).toMatchObject({ text: "Native fixture response", usage: { input_tokens: 3, output_tokens: 2 } });
    expect(hits).toBe(1);
    pids = await jsonFile(ids);
    for (const pid of [pids!.helper, pids!.child, pids!.group]) expect(live(pid)).toBe(false);
  } finally {
    if (pending) { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(30_000); await pending; }
    vi.useRealTimers();
    if (pids && live(pids.group)) { try { process.kill(-pids.group, "SIGKILL"); } catch { /* Fixture closed. */ } }
    await server.close(); await rm(dir, { recursive: true, force: true });
  }
}, 15_000);

it("bounds admission to32/four native requests and never dispatches expired queued calls", async () => {
  const { createBedrockBackend } = await nativeBedrock();
  let hits = 0, healthy = false;
  const server = await serve((_req, res) => { hits++; if (healthy) reply(res); });
  environment(server.url);
  const backend = createBedrockBackend({ accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", timeoutMs: 30_000 });
  const pending: Promise<unknown>[] = [];
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    for (let index = 0; index < 32; index++) pending.push(backend.call(modelCall).catch(error => error));
    await expect(backend.call(modelCall)).rejects.toThrow("busy");
    await until(() => hits === 4); expect(hits).toBe(4);
    await vi.advanceTimersByTimeAsync(30_000);
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ message: "bedrock call: timeout" });
    await until(() => server.sockets.size === 0); await delay(100); expect(hits).toBe(4);
    vi.useRealTimers(); healthy = true;
    expect((await backend.call(modelCall)).text).toBe("Native fixture response"); expect(hits).toBe(5);
  } finally {
    if (vi.isFakeTimers()) { await vi.advanceTimersByTimeAsync(30_000); await Promise.all(pending); }
    vi.useRealTimers(); await server.close();
  }
}, 15_000);

it("bounds real complete response bytes and suppresses ambiguous SDK retries", async () => {
  const { createBedrockBackend } = await nativeBedrock();
  let hits = 0;
  const server = await serve((_req, res) => { hits++; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ content: [{ type: "text", text: "x".repeat(4 * 1024 * 1024) }], usage: {} })); });
  environment(server.url);
  try {
    const backend = createBedrockBackend({ accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", timeoutMs: 10_000 });
    await expect(backend.call(modelCall)).rejects.toThrow("body_too_large"); expect(hits).toBe(1);
  } finally { await server.close(); }
});

it("shares native admission across invocation backends and token limits", async () => {
  const { BedrockProcess, createBedrockBackend } = await nativeBedrock();
  const processOwner = new BedrockProcess();
  let hits = 0, healthy = false;
  const server = await serve((_req, res) => { hits++; if (healthy) reply(res); });
  environment(server.url);
  const backend = (maxTokens: number) => createBedrockBackend({
    accessKeyId: "fixture-access", secretAccessKey: "fixture-secret",
    processOwner, maxTokens, timeoutMs: 30_000,
  });
  const pending: Promise<unknown>[] = [];
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    for (let index = 0; index < 32; index++) pending.push(backend(index + 1).call(modelCall).catch(error => error));
    await expect(backend(512).call(modelCall)).rejects.toThrow("busy");
    await until(() => hits === 4);
    await vi.advanceTimersByTimeAsync(30_000);
    for (const result of await Promise.all(pending)) expect(result).toMatchObject({ message: "bedrock call: timeout" });
    await until(() => server.sockets.size === 0); expect(hits).toBe(4);
    vi.useRealTimers(); healthy = true;
    expect((await backend(1024).call(modelCall)).text).toBe("Native fixture response");
    expect(hits).toBe(5);
  } finally {
    if (vi.isFakeTimers()) { await vi.advanceTimersByTimeAsync(30_000); await Promise.all(pending); }
    vi.useRealTimers(); await server.close();
  }
}, 15_000);

it("closes an unfinished native response even after valid JSON bytes were written", async () => {
  const { createBedrockBackend } = await nativeBedrock();
  let written = false, settled = false;
  const server = await serve((_req, res) => { res.setHeader("content-type", "application/json");
    res.write(JSON.stringify({ content: [{ type: "text", text: "Fixture complete JSON" }], usage: { input_tokens: 1, output_tokens: 1 } }), () => { written = true; }); });
  environment(server.url);
  const backend = createBedrockBackend({ accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", timeoutMs: 30_000 });
  let pending: Promise<unknown> | undefined;
  try {
    vi.useFakeTimers({ toFake: ["performance", "setTimeout", "clearTimeout"] });
    pending = backend.call(modelCall).then(value => { settled = true; return value; }, error => { settled = true; return error; });
    await until(() => written); await delay(100); expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ message: "bedrock call: timeout" });
    await until(() => server.sockets.size === 0);
  } finally {
    if (pending) { if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(30_000); await pending; }
    vi.useRealTimers(); await server.close();
  }
}, 15_000);

it("rejects excessive encoded prompt bytes before native provider I/O", async () => {
  const { createBedrockBackend } = await nativeBedrock();
  let hits = 0;
  const server = await serve((_req, res) => { hits++; reply(res); }); environment(server.url);
  try {
    const backend = createBedrockBackend({ accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", timeoutMs: 10_000 });
    await expect(backend.call({ ...modelCall, prompt: "é".repeat(2 * 1024 * 1024) })).rejects.toThrow("request_too_large");
    expect(hits).toBe(0);
  } finally { await server.close(); }
});

it("accepts complete requests and responses near the byte limit within the fixed SDK heap", async () => {
  const { createBedrockBackend } = await nativeBedrock();
  const length = 4 * 1024 * 1024 - 4096;
  let received = 0;
  const server = await serve((req, res) => {
    req.on("data", value => { received += Buffer.byteLength(value); });
    req.on("end", () => { res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ content: [{ type: "text", text: "x".repeat(length) }], usage: { input_tokens: 3, output_tokens: 2 } })); });
  }); environment(server.url);
  try {
    const backend = createBedrockBackend({ accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", timeoutMs: 10_000 });
    const result = await backend.call({ ...modelCall, prompt: "x".repeat(length) });
    expect(result.text).toHaveLength(length); expect(received).toBeGreaterThan(length); expect(received).toBeLessThan(4 * 1024 * 1024);
    expect(result.usage).toEqual({ input_tokens: 3, output_tokens: 2 });
  } finally { await server.close(); }
}, 15_000);

it.each([403, 429, 500])("never replays a native status%s cache error or leaks its content", async status => {
  const { createBedrockBackend } = await nativeBedrock();
  let hits = 0;
  const server = await serve((_req, res) => { hits++; res.statusCode = status; res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ message: "cache fixture-secret fixture-prompt" })); }); environment(server.url);
  try {
    const backend = createBedrockBackend({ accessKeyId: "fixture-access", secretAccessKey: "fixture-secret", timeoutMs: 10_000 });
    await expect(backend.call({ ...modelCall, cacheSystem: true })).rejects.toMatchObject({
      name: status === 403 ? "BedrockAuthError" : "BedrockError", status,
      message: status === 403 ? "bedrock auth: failed" : "bedrock call: failed",
    });
    expect(hits).toBe(1);
  } finally { await server.close(); }
});

it("keeps native model mapping/history/cache fallback and validated usage", async () => {
  const { createBedrockBackend } = await nativeBedrock();
  const bodies: Record<string, unknown>[] = [];
  const paths: string[] = [];
  const server = await serve((req, res) => {
    const chunks: Buffer[] = []; req.on("data", value => chunks.push(Buffer.from(value)));
    req.on("end", () => { bodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8"))); paths.push(req.url ?? "");
      if (bodies.length === 1) { res.statusCode = 400; res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ message: "system.0.cache_control: unsupported" })); }
      else reply(res);
    });
