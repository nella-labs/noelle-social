import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { killProcessGroup } from "./processGroup.js";

afterEach(() => vi.restoreAllMocks());
it.each([0, 1, -1, 0.5, NaN, Infinity, 2_147_483_648])("rejects group %s before signaling", pid => {
  const signal = vi.spyOn(process, "kill");
  expect(() => killProcessGroup(pid)).toThrow(RangeError);
  expect(signal).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== "darwin")("recognizes a native unreaped exited group", async () => {
  const supervisor = spawn("python3", ["-u", "-c", [
    "import os,sys", "pid=os.fork()", "if pid==0:", " os.setsid()",
    " print(os.getpid(),flush=True)", " os._exit(0)",
    "sys.stdin.readline()", "os.waitpid(pid,0)",
  ].join("\n")], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(supervisor, "close");
  try {
    const pid = Number((await once(supervisor.stdout, "data"))[0].toString().trim());
    expect(Number.isSafeInteger(pid) && pid > 1).toBe(true);
    await vi.waitFor(() => {
      const state = execFileSync("/bin/ps", ["-g", String(pid), "-o", "stat="], {
        encoding: "utf8", timeout: 1000, maxBuffer: 65536,
      }).trim();
      expect(state.startsWith("Z")).toBe(true);
    });
    expect(() => process.kill(-pid, "SIGKILL")).toThrow(expect.objectContaining({ code: "EPERM" }));
    expect(() => killProcessGroup(pid)).not.toThrow();
  } finally { supervisor.stdin.end("release\n"); await closed; }
});
it.skipIf(process.platform === "win32")("preserves a permission failure while the owned native group remains alive", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  await once(child.stdout!, "data");
  const original = process.kill.bind(process);
  const error = Object.assign(new Error("Owned group permission failure"), { code: "EPERM" });
  const fault = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
    if (pid === -child.pid!) throw error;
    return original(pid, signal);
  });
  try { expect(() => killProcessGroup(child.pid!)).toThrow(error); }
  finally { fault.mockRestore(); original(-child.pid!, "SIGKILL"); await closed; }
});
it.skipIf(process.platform === "win32")("keeps native group closure and absent-group cleanup idempotent", async () => {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('ready');setInterval(()=>{},1000)"], {
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  try {
    await once(child.stdout!, "data");
    killProcessGroup(child.pid!); await closed;
    await delay(10);
    expect(() => killProcessGroup(child.pid!)).not.toThrow();
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; } }
});
