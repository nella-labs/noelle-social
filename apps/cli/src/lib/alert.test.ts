import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { alertInvocation, resolveAlertCmd, sendDeployAlert } from "./alert.js";

function tmpEnvFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "noelle-alert-"));
  const p = join(dir, ".env");
  writeFileSync(p, contents);
  return p;
}

describe("alertInvocation", () => {
  it("spawns the documented contract: -c deploy-failure -m <message>", () => {
    expect(alertInvocation("/x/notify.sh", "smoke failed")).toEqual({
      cmd: "/x/notify.sh",
      args: ["-c", "deploy-failure", "-m", "smoke failed"],
    });
  });

  it("keeps configured flags ahead of the contract args (value may carry flags)", () => {
    expect(alertInvocation("/x/notify.sh --quiet", "msg")).toEqual({
      cmd: "/x/notify.sh",
      args: ["--quiet", "-c", "deploy-failure", "-m", "msg"],
    });
  });

  it("is null for a blank value", () => {
    expect(alertInvocation("   ", "msg")).toBeNull();
  });
});

describe("resolveAlertCmd", () => {
  it("prefers the process env over the .env file", () => {
    const envFile = tmpEnvFile("NOELLE_ALERT_CMD=/from/file.sh\n");
    expect(resolveAlertCmd(envFile, { NOELLE_ALERT_CMD: "/from/env.sh" })).toBe("/from/env.sh");
  });

  it("falls back to ~/.noelle/.env (launchd does not source it)", () => {
    const envFile = tmpEnvFile("NOELLE_ALERT_CMD=/from/file.sh\n");
    expect(resolveAlertCmd(envFile, {})).toBe("/from/file.sh");
  });

  it("is null when unset everywhere (alerting is opt-in)", () => {
    const envFile = tmpEnvFile("OTHER_KEY=x\n");
    expect(resolveAlertCmd(envFile, {})).toBeNull();
  });

  it("is null when the env file is missing", () => {
    expect(resolveAlertCmd("/nonexistent/.env", {})).toBeNull();
  });
});

describe("sendDeployAlert", () => {
  it("is unconfigured (no-op) when NOELLE_ALERT_CMD is unset", async () => {
    const envFile = tmpEnvFile("OTHER_KEY=x\n");
    await expect(sendDeployAlert(envFile, "msg", {})).resolves.toBe("unconfigured");
  });

  it("is sent when the alert command exits 0", async () => {
    const envFile = tmpEnvFile("NOELLE_ALERT_CMD=/bin/echo\n");
    await expect(sendDeployAlert(envFile, "msg", {})).resolves.toBe("sent");
  });

  it("supports a value with flags (whitespace-split, not one ENOENT path)", async () => {
    const envFile = tmpEnvFile('NOELLE_ALERT_CMD="/bin/echo -n"\n');
    await expect(sendDeployAlert(envFile, "msg", {})).resolves.toBe("sent");
  });

  it("fails open when the command does not exist", async () => {
    const envFile = tmpEnvFile("NOELLE_ALERT_CMD=/nonexistent/notify.sh\n");
    await expect(sendDeployAlert(envFile, "msg", {})).resolves.toBe("failed");
  });

  it("SIGKILLs a hung notifier at the timeout and reports failed", async () => {
    const envFile = tmpEnvFile("NOELLE_ALERT_CMD=/bin/sleep 30\n");
    const started = Date.now();
    await expect(sendDeployAlert(envFile, "msg", {}, 300)).resolves.toBe("failed");
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
