import { describe, expect, it } from "vitest";
import { run } from "./platform.js";

describe("CLI child process outcomes", () => {
  it.each(["SIGTERM", "SIGKILL"])("rejects a child terminated by %s", async (signal) => {
    await expect(run(process.execPath, ["-e", `process.kill(process.pid, '${signal}')`]))
      .rejects.toThrow(/exited/);
  });

  it("returns a nonzero diagnostic for a signal when failure is allowed", async () => {
    expect(await run(process.execPath, ["-e", "process.kill(process.pid, 'SIGTERM')"], {
      allowFailure: true,
    })).toMatchObject({ code: 143, signal: "SIGTERM" });
  });

  it("does not expose command arguments or captured output in fatal errors", async () => {
    await expect(run(process.execPath, ["-e", "console.error('fixture-secret');process.exit(2)", "credential-argument"]))
      .rejects.toThrow(/^.* exited 2$/);
  });

  it("retains timeout failures and ordinary successful output", async () => {
    expect(await run(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
      timeoutMs: 10, allowFailure: true,
    })).toMatchObject({ code: 124 });
    expect(await run(process.execPath, ["-e", "console.log('ready')"]))
      .toMatchObject({ code: 0, stdout: "ready\n" });
  });
});
