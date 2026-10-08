import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { importAfterOperatorEnv } from "./recheck-env.js";

const originalProbe = process.env.NOELLE_RECHECK_ENV_PROBE;
const originalBudget = process.env.NOELLE_BUDGET_PERIOD;
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalProbe === undefined) delete process.env.NOELLE_RECHECK_ENV_PROBE;
  else process.env.NOELLE_RECHECK_ENV_PROBE = originalProbe;
  if (originalBudget === undefined) delete process.env.NOELLE_BUDGET_PERIOD;
  else process.env.NOELLE_BUDGET_PERIOD = originalBudget;
});

describe("pending reply CLI environment bootstrap", () => {
  it("loads the operator file before importing runtime and preserves explicit environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "noelle-recheck-env-"));
    dirs.push(dir);
    const path = join(dir, ".env");
    writeFileSync(path, "NOELLE_RECHECK_ENV_PROBE=from-file\nNOELLE_BUDGET_PERIOD=week\n");
    process.env.NOELLE_RECHECK_ENV_PROBE = "explicit";
    delete process.env.NOELLE_BUDGET_PERIOD;

    const imported = await importAfterOperatorEnv(async () => ({
      probeSeenByModule: process.env.NOELLE_RECHECK_ENV_PROBE,
      budgetSeenByModule: process.env.NOELLE_BUDGET_PERIOD,
    }), path);

    expect(imported).toEqual({ probeSeenByModule: "explicit", budgetSeenByModule: "week" });
  });

  it("continues when the operator file is absent", async () => {
    const imported = await importAfterOperatorEnv(async () => "runtime loaded", join(tmpdir(), "noelle-no-such-env-file"));
    expect(imported).toBe("runtime loaded");
  });
});
