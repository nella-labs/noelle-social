import { describe, expect, it, vi } from "vitest";
import { parseLock, pidAlive } from "./deploy-lock.js";

const base = { pid: 4242, host: "fixture-host", sha: "abc", stage: "build", startedAt: 1000 };

describe("deploy lock identity", () => {
  it("parses a valid legacy lock payload", () => {
    expect(parseLock(JSON.stringify(base))).toEqual(base);
  });
  it("returns null on garbage or missing fields", () => {
    expect(parseLock("not json")).toBeNull();
    expect(parseLock(JSON.stringify({ pid: 1 }))).toBeNull();
  });
  it.each([0, -1, 1.5, null])("rejects an invalid PID %s before a liveness probe", (pid) => {
    expect(parseLock(JSON.stringify({ ...base, pid }))).toBeNull();
  });
  it("treats permission denial as possibly live and only ESRCH as dead", () => {
    const probe = vi.spyOn(process, "kill");
    try {
      probe.mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
      expect(pidAlive(4242)).toBe(true);
      probe.mockImplementationOnce(() => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); });
      expect(pidAlive(4242)).toBe(false);
    } finally { probe.mockRestore(); }
  });
});
