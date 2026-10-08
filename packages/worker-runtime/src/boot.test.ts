import { describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { EX_CONFIG, EX_TEMPFAIL, runBootChecks } from "./boot.js";

function silentLogger() {
  const log = createLogger({ kind: "test", workerId: "t0" });
  log.level = "silent";
  return log;
}

describe("runBootChecks", () => {
  it("passes when every check passes", async () => {
    const result = await runBootChecks({
      log: silentLogger(),
      checks: [
        { name: "a", run: async () => {} },
        { name: "b", kind: "transient", run: async () => {} },
      ],
    });
    expect(result).toEqual({ ok: true });
  });

  it("maps a config failure to exit 78 and reports the failed check", async () => {
    const result = await runBootChecks({
      log: silentLogger(),
      checks: [{ name: "secret.load", run: async () => { throw new Error("no token"); } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(EX_CONFIG);
    expect(result.failedCheck).toBe("secret.load");
    expect(result.error.message).toBe("no token");
  });

  it("maps a transient failure to exit 75", async () => {
    const result = await runBootChecks({
      log: silentLogger(),
      checks: [
        { name: "db.ping", kind: "transient", run: async () => { throw new Error("refused"); } },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.exitCode).toBe(EX_TEMPFAIL);
  });

  it("stops at the first failure without running later checks", async () => {
    let ranLater = false;
    const result = await runBootChecks({
      log: silentLogger(),
      checks: [
        { name: "first", run: async () => { throw new Error("nope"); } },
        { name: "second", run: async () => { ranLater = true; } },
      ],
    });
    expect(result.ok).toBe(false);
    expect(ranLater).toBe(false);
  });

  it("wraps non-Error throws", async () => {
    const result = await runBootChecks({
      log: silentLogger(),
      checks: [{ name: "weird", run: async () => { throw "string failure"; } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBeInstanceOf(Error);
    expect(result.error.message).toBe("string failure");
  });
});
