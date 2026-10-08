import { describe, expect, it, vi } from "vitest";
import { runBootChecks, EX_CONFIG, EX_TEMPFAIL } from "./boot.js";

describe("runBootChecks", () => {
  it("returns ok when every check resolves", async () => {
    const log = { info: vi.fn(), error: vi.fn(), fatal: vi.fn() } as never;
    const res = await runBootChecks({
      log,
      checks: [
        { name: "a", run: async () => {} },
        { name: "b", run: async () => {} },
      ],
    });
    expect(res.ok).toBe(true);
  });

  it("returns EX_CONFIG when a 'config' check throws", async () => {
    const log = { info: vi.fn(), error: vi.fn(), fatal: vi.fn() } as never;
    const res = await runBootChecks({
      log,
      checks: [
        { name: "bad-token", kind: "config", run: async () => { throw new Error("missing"); } },
      ],
    });
    if (res.ok) throw new Error("expected failure");
    expect(res.exitCode).toBe(EX_CONFIG);
  });

  it("returns EX_TEMPFAIL on transient failures", async () => {
    const log = { info: vi.fn(), error: vi.fn(), fatal: vi.fn() } as never;
    const res = await runBootChecks({
      log,
      checks: [
        { name: "db", kind: "transient", run: async () => { throw new Error("connect ECONNREFUSED"); } },
      ],
    });
    if (res.ok) throw new Error("expected failure");
    expect(res.exitCode).toBe(EX_TEMPFAIL);
  });
});
