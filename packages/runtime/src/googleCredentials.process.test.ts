import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createGoogleCredentialClient } from "./googleCredentials.js";
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
function processState(pid: number): string | null {
  try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1000 }).trim() || null; }
  catch (error) { if ((error as { status?: number }).status === 1) return null; throw error; }
}
function alive(pid: number): boolean { const state = processState(pid); return state !== null && !state.startsWith("Z"); }
it("cancels default ADC gcloud discovery and leaves no live helper process", async () => {
  const directory = await mkdtemp(join(tmpdir(), "noelle-auth-gcloud-"));
  const pidsPath = join(directory, "pids.json"), heartbeat = join(directory, "heartbeat"), mode = join(directory, "mode");
  const credentials = join(directory, "adc.json");
  await writeFile(credentials, JSON.stringify({ type: "authorized_user", client_id: "synthetic-client", client_secret: "synthetic-secret", refresh_token: "synthetic-refresh" }));
  const helper = join(directory, "gcloud");
  await writeFile(helper, `#!${process.execPath}\nconst fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({pid:process.pid, parent:process.ppid}));
if(fs.existsSync(${JSON.stringify(mode)})) process.stdout.write(JSON.stringify({configuration:{properties:{core:{project:'fixture-project'}}}}));
else {
const child = require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`setInterval(()=>require('node:fs').appendFileSync(${JSON.stringify(heartbeat)},'x'),20);`)}],{stdio:'ignore'});
fs.writeFileSync(${JSON.stringify(pidsPath)}, JSON.stringify({pid:process.pid, parent:process.ppid, descendant:child.pid}));
}\n`);
  await chmod(helper, 0o700);
  vi.stubEnv("PATH", `${directory}:${process.env["PATH"] ?? ""}`);
  vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", credentials);
  for (const key of ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT", "google_cloud_project", "gcloud_project"]) vi.stubEnv(key, "");
  const server = createServer((_req, res) => { res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ access_token: "synthetic-token", expires_in: 3600, token_type: "Bearer" })); });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw Error("fixture listen failed");
  const client = createGoogleCredentialClient({ authOptions: { clientOptions: { endpoints: { oauth2TokenUrl: `http://127.0.0.1:${address.port}` } } } });
  let fixturePids: { pid: number; parent: number; descendant: number } | undefined;
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const result = client.getAccessToken(600).catch(error => error);
    const until = Date.now() + 8000;
    let heartbeatStarted = false;
    while ((!fixturePids?.descendant || !heartbeatStarted) && Date.now() < until) {
      try { fixturePids = JSON.parse(await readFile(pidsPath, "utf8")); } catch { /* Helper has not started yet. */ }
      try { heartbeatStarted = (await readFile(heartbeat, "utf8")).length > 0; } catch { /* Descendant has not started yet. */ }
      if (!fixturePids?.descendant || !heartbeatStarted) await delay(10);
    }
    expect(fixturePids?.descendant, "actual GoogleAuth must reach the synthetic gcloud helper and its child").toBeDefined();
    expect(heartbeatStarted).toBe(true);
    await vi.advanceTimersByTimeAsync(600);
    expect(await result).toMatchObject({ code: "timeout" });
    await delay(30);
    for (const pid of [fixturePids!.pid, fixturePids!.descendant]) {
      const state = processState(pid);
      expect(state === null || state.startsWith("Z"), `owned helper ${pid} OS state: ${state ?? "gone"}`).toBe(true);
    }
    const before = await readFile(heartbeat, "utf8"); await delay(60);
    expect(await readFile(heartbeat, "utf8")).toBe(before);
    vi.useRealTimers();
    await writeFile(mode, "normal"); expect(await client.getAccessToken()).toBe("synthetic-token");
  } finally {
    vi.useRealTimers();
    await client.close();
    if (fixturePids) for (const pid of [fixturePids.pid, fixturePids.descendant]) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch { /* Fixture already exited. */ } }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
}, 10000);
