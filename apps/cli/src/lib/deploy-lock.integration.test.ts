import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLock, lockPath, releaseLock, updateStage } from "./deploy-lock.js";

const dirs: string[] = [];
afterEach(() => {
  releaseLock(process.pid);
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixtureHome() {
  const dir = mkdtempSync(join(tmpdir(), "noelle-deploy-lock-test-"));
  dirs.push(dir);
  vi.stubEnv("NOELLE_HOME", dir);
  return dir;
}
const info = () => ({ pid: process.pid, host: "fixture-host", sha: "fixture", stage: "build" });

describe("native deploy lock ownership", () => {
  it.each(["empty", "dead"])("admits only one of eight native processes at the same atomic claim boundary: %s", async (state) => {
    const dir = fixtureHome();
    if (state === "dead") {
      const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
      await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", () => resolve()); });
      writeFileSync(lockPath(), JSON.stringify({ ...info(), pid: child.pid, startedAt: Date.now(), nonce: "dead-owner" }));
    }
    const worker = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const target = process.env.NOELLE_HOME + '/deploy.lock';
      const barrier = () => {
        fs.writeFileSync(process.env.NOELLE_HOME + '/' + process.pid + '.ready', 'ready');
        const deadline = Date.now() + 5000;
        while (!fs.existsSync(process.env.NOELLE_HOME + '/go')) {
          if (Date.now() > deadline) throw new Error('fixture barrier timeout');
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
        }
      };
      const open = fs.openSync, link = fs.linkSync;
      fs.openSync = (...args) => { if (args[0] === target && args[1] === 'w') barrier(); return open(...args); };
      fs.linkSync = (...args) => { if (args[1] === target) barrier(); return link(...args); };
      syncBuiltinESMExports();
      const { acquireLock } = await import(${JSON.stringify(new URL("./deploy-lock.ts", import.meta.url).href)});
      const result = acquireLock({pid:process.pid, host:'fixture-host', sha:'fixture', stage:'build'});
      console.log(JSON.stringify(result));
      setTimeout(() => {}, 300);
    `;
    const children = Array.from({ length: 8 }, () => spawn(process.execPath, [
      "--import", createRequire(import.meta.url).resolve("tsx"), "--input-type=module", "-e", worker,
    ], { env: { ...process.env, NOELLE_HOME: dir }, stdio: ["ignore", "pipe", "pipe"] }));
    try {
      const results = children.map((child) => new Promise<{ ok: boolean }>((resolve, reject) => {
        let stdout = "", stderr = "";
        child.stdout.on("data", (data) => { stdout += data; });
        child.stderr.on("data", (data) => { stderr += data; });
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) reject(new Error(`fixture child failed: ${stderr}`));
          else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
        });
      }));
      const completed = Promise.all(results);
      void completed.catch(() => {});
      await vi.waitFor(() => {
        expect(children.every((child) => existsSync(join(dir, `${child.pid}.ready`)))).toBe(true);
      }, { timeout: 4500, interval: 10 });
      writeFileSync(join(dir, "go"), "go");
      expect((await completed).filter((result) => result.ok)).toHaveLength(1);
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    }
  }, 10_000);

  it("does not steal a live owner just because a build lasts over thirty minutes", () => {
    fixtureHome();
    expect(acquireLock(info(), Date.now() - 31 * 60_000).ok).toBe(true);
    expect(acquireLock(info()).ok).toBe(false);
  });

  it("does not rewrite or release a replacement owned by another claim of the same PID", () => {
    fixtureHome();
    expect(acquireLock(info()).ok).toBe(true);
    const replacement = { ...info(), stage: "replacement", startedAt: Date.now(), nonce: "different-claim" };
    writeFileSync(lockPath(), JSON.stringify(replacement));
    updateStage("rsync");
    releaseLock(process.pid);
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toEqual(replacement);
  });

  it("fails closed on a partial or corrupt lock rather than overwriting a possible holder", () => {
    fixtureHome();
    writeFileSync(lockPath(), '{"pid":');
    expect(acquireLock(info()).ok).toBe(false);
    expect(readFileSync(lockPath(), "utf8")).toBe('{"pid":');
  });

  it("recovers an interrupted dead-holder recovery without bypassing a live recovery", async () => {
    fixtureHome();
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    await new Promise<void>((resolve, reject) => { child.on("error", reject); child.on("close", () => resolve()); });
    const raw = JSON.stringify({ ...info(), pid: child.pid, startedAt: Date.now(), nonce: "dead-owner" });
    writeFileSync(lockPath(), raw);
    const recoveryPath = `${lockPath()}.reclaim-${createHash("sha256").update(raw).digest("hex")}`;
    writeFileSync(recoveryPath, JSON.stringify({ ...info(), startedAt: Date.now(), nonce: "live-recovery" }));
    expect(acquireLock(info()).ok).toBe(false);
    writeFileSync(recoveryPath, JSON.stringify({ ...info(), pid: child.pid, startedAt: Date.now(), nonce: "dead-recovery" }));
    expect(acquireLock(info()).ok).toBe(true);
    updateStage("rsync");
    expect(JSON.parse(readFileSync(lockPath(), "utf8"))).toMatchObject({ pid: process.pid, stage: "rsync" });
    expect(existsSync(recoveryPath)).toBe(false);
    releaseLock(process.pid);
    expect(existsSync(lockPath())).toBe(false);
  });
});
