import { afterEach, expect, it, vi } from "vitest";
import cp, { type ChildProcess } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { createGoogleCredentialClient } from "./googleCredentials.js";
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); });
it("stops a created credential process before returning a synchronous IPC send failure", async () => {
  const original = cp.spawn;
  let pid: number | undefined;
  const fault = vi.spyOn(cp, "spawn").mockImplementation((...args: Parameters<typeof original>) => {
    const child: ChildProcess = original(...args); pid = child.pid;
    child.send = () => { throw new Error("synthetic IPC channel failure"); };
    return child;
  });
  syncBuiltinESMExports();
  const client = createGoogleCredentialClient({ authOptions: { projectId: "fixture-project" } });
  try {
    await expect(client.getAccessToken()).rejects.toMatchObject({ code: "failed" });
    expect(pid).toBeDefined(); await delay(20);
    let alive = false; try { process.kill(pid!, 0); alive = true; } catch { /* Owned process has exited. */ }
    expect(alive).toBe(false);
  } finally { fault.mockRestore(); syncBuiltinESMExports(); await client.close(); }
});
