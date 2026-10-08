import { afterEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { makeAlert } from "./alert.js";
import { loadEnv, resetEnvForTests } from "./env.js";
import type { Logger } from "./logger.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetEnvForTests();
});

describe("installation-owned doctor configuration", () => {
  it("records an unconfigured alert without invoking an external process", async () => {
    const warn = vi.fn();
    await makeAlert({ cmd: "", dryrun: false, logger: { warn } as unknown as Logger })("fixture", "connection failed");
    expect(execFile).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith({ category: "fixture", message: "connection failed" }, "alert (command not configured)");
  });

  it("preserves explicit reporter and process-manager paths", () => {
    vi.stubEnv("NOELLE_DATABASE_URL", "postgres://127.0.0.1/noelle_doctor_fixture");
    vi.stubEnv("NOELLE_ALERT_CMD", "/configured/notify");
    vi.stubEnv("NOELLE_PM2_BIN", "/configured/pm2");
    const env = loadEnv();
    expect(env.NOELLE_ALERT_CMD).toBe("/configured/notify");
    expect(env.NOELLE_PM2_BIN).toBe("/configured/pm2");
  });
});
