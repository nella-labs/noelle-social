import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { MAX_CLI_OUTPUT_BYTES, readCliAnswer, runCliProcess } from "./cliProcess.js";

const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "noelle-cli-owner-fixture-")); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { force: true, recursive: true }); vi.restoreAllMocks(); });
const options = { command: process.execPath, argv: [], prompt: "", cwd: tmpdir(), env: process.env, timeoutMs: 3000 };

it.each([0, -1, 1.5, NaN, Infinity, 1_800_001])("rejects deadline %s before dispatch", async timeoutMs => {
  const spawnImpl = vi.fn() as unknown as typeof spawn;
  await expect(runCliProcess({ ...options, timeoutMs, spawnImpl })).rejects.toMatchObject({ code: "invalid_request" });
  expect(spawnImpl).not.toHaveBeenCalled();
});

it("bounds actual stdout plus stderr bytes and waits for its child close barrier", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end() {} }), kill: vi.fn() });
  const spawnImpl = (() => child) as unknown as typeof spawn;
  let settled = false;
  const result = runCliProcess({ ...options, spawnImpl }).catch(error => { settled = true; return error; });
  child.stdout.emit("data", Buffer.alloc(MAX_CLI_OUTPUT_BYTES - 2, "a"));
  child.stderr.emit("data", "é");
  child.stdout.emit("data", "x");
  await Promise.resolve();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL"); expect(settled).toBe(false);
  child.emit("close", null, "SIGKILL");
  expect(await result).toMatchObject({ code: "output_too_large", stderr: "é" });
});

it("terminates an owned native process after a streamed output overflow", async () => {
  let child: ReturnType<typeof spawn> | undefined;
  const spawnImpl = ((command: string, argv: string[], opts: import("node:child_process").SpawnOptions) => {
    child = spawn(command, argv, opts); return child;
  }) as typeof spawn;
  const argv = ["-e", 'process.stdin.resume();const bytes=Buffer.alloc(65536,"x");setInterval(()=>process.stdout.write(bytes),1);'];
  const error = await runCliProcess({ ...options, argv, timeoutMs: 10_000, spawnImpl }).catch(error => error);
  expect(error).toMatchObject({ code: "output_too_large" });
  expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
});

it("preserves native stdin, UTF8 output and exit status", async () => {
  expect(await runCliProcess({ ...options, prompt: "payload é", argv: ["-e",
    'let text="";process.stdin.on("data",d=>text+=d);process.stdin.on("end",()=>{process.stdout.write(text);process.stderr.write("diagnostic");});'] }))
    .toMatchObject({ stdout: "payload é", stderr: "diagnostic", code: 0 });
});

it("settles a native missing binary only after its error and close", async () => {
  await expect(runCliProcess({ ...options, command: join(directory(), "missing") })).rejects.toMatchObject({ code: "spawn_failed" });
});

it("removes helpers left by a successfully exiting native parent", async () => {
  const dir = directory(), heartbeat = join(dir, "heartbeat"), pidFile = join(dir, "pid");
  const helper = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(heartbeat)},"ready");setInterval(()=>fs.appendFileSync(${JSON.stringify(heartbeat)},"."),10);`;
  const parent = `const fs=require("node:fs");const child=require("node:child_process").spawn(process.execPath,["-e",${JSON.stringify(helper)}],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));child.unref();const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(heartbeat)})){clearInterval(timer);process.stdout.write("done");}},10);`;
  let helperPid: number | undefined;
  try {
    expect(await runCliProcess({ ...options, argv: ["-e", parent], timeoutMs: 10_000 })).toMatchObject({ code: 0, stdout: "done" });
    helperPid = Number(readFileSync(pidFile, "utf8"));
    const before = readFileSync(heartbeat, "utf8"); await delay(100);
    expect(readFileSync(heartbeat, "utf8")).toBe(before);
    expect(() => process.kill(helperPid!, 0)).toThrow();
  } finally { if (helperPid) { try { process.kill(helperPid, "SIGKILL"); } catch { /* Fixture already exited. */ } } }
});

it("reads a bounded regular final answer and rejects oversized, linked and nonregular files", () => {
  const dir = directory(), path = join(dir, "answer"), link = join(dir, "link");
  writeFileSync(path, "  final é\n"); expect(readCliAnswer(path)).toBe("final é");
  symlinkSync(path, link); expect(() => readCliAnswer(link)).toThrow();
  expect(() => readCliAnswer(dir)).toThrow();
  truncateSync(path, MAX_CLI_OUTPUT_BYTES + 1);
  expect(() => readCliAnswer(path)).toThrow(expect.objectContaining({ code: "output_too_large" }));
  expect(existsSync(path)).toBe(true);
});
