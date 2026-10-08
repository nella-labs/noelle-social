import { afterEach, describe, expect, it, vi } from "vitest";
import type { RemediationAction } from "@noelle/contracts";
import type { Env } from "./env.js";
import type { Logger } from "./logger.js";
import {
  canRemediate,
  decideAction,
  isMutating,
  makeBridgeRemediator,
  nextRung,
  remediate,
  RollingCounter,
  type RemediateCtx,
  type RemediateDeps,
} from "./remediate.js";

const HOUR = 3_600_000;

function testEnv(over: Partial<Env> = {}): Env {
  return {
    NODE_ENV: "test",
    NOELLE_DATABASE_URL: "postgres://x",
    NOELLE_DOCTOR_INTERVAL_MS: 60_000,
    NOELLE_BRIDGE_URL: "http://127.0.0.1:18792",
    NOELLE_API_URL: "http://127.0.0.1:18791",
    NOELLE_DOCTOR_STATE_DIR: "/tmp/doctor-test",
    NOELLE_DOCTOR_DRYRUN: false,
    NOELLE_DOCTOR_AUTOFIX: false,
    NOELLE_ALERT_CMD: "/bin/true",
    NOELLE_DOCTOR_ALERT_CATEGORY: "actuator-down",
    NOELLE_DOCTOR_MAX_REMEDIATIONS_PER_HOUR: 6,
    NOELLE_PM2_BIN: "pm2",
    NOELLE_BRIDGE_APP: "chrome-bridge",
    NOELLE_API_APP: "noelle-api-vm",
    NOELLE_DOCTOR_STUCK_QUEUE_MIN: 30,
    NOELLE_DOCTOR_STUCK_QUEUE_DEPTH: 5,
    NOELLE_DOCTOR_SEND_FAIL_MAX: 8,
    NOELLE_DOCTOR_SEND_FAIL_WINDOW_MIN: 60,
    NOELLE_DOCTOR_HTTP_TIMEOUT_MS: 5_000,
    NOELLE_DOCTOR_STATE_MAX_BYTES: 5_000_000,
    ...over,
  } as Env;
}

const noopLogger = { warn() {}, info() {}, error() {} } as unknown as Logger;

function makeDeps(env: Env) {
  const alerts: Array<[string, string]> = [];
  const pm2 = { restartApp: vi.fn(async (_name: string) => ({ ok: true })) };
  const bridge = { reloadExtension: vi.fn(async () => ({ ok: true, fallback: false })) };
  const db = { engageKillSwitch: vi.fn(async (_ids: string[]) => ({ ok: true, count: 1 })) };
  const deps: RemediateDeps = {
    env,
    logger: noopLogger,
    alert: async (c, m) => {
      alerts.push([c, m]);
    },
    pm2,
    bridge,
    db,
  };
  return { deps, alerts, pm2, bridge, db };
}

const ctx: RemediateCtx = {
  target: "x-actuator",
  signatureId: "worker-offline",
  appsToRestart: ["noelle-drafter"],
  instanceIds: ["11111111-1111-1111-1111-111111111111"],
};

afterEach(() => vi.unstubAllGlobals());

describe("targeted extension reload receipts", () => {
  const targets = [
    ["x-actuator", "Noelle X Actuator"],
    ["linkedin-actuator", "Noelle LinkedIn Actuator"],
    ["reddit-intern", "Noelle Reddit Actuator"],
  ] as const;
  function realBridge(entries: unknown[], acknowledged = "lane-extension") {
    const operations: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, options) => {
      const op = JSON.parse(options.body);
      operations.push(op);
      const value = op.op === "ext.list" ? entries : op.op === "meta.info" ? { extId: "bridge-extension" }
        : { reloaded: acknowledged, self: acknowledged === "bridge-extension" };
      return { status: 200, json: async () => ({ ok: true, value }) };
    }));
    const result = makeDeps(testEnv()); result.deps.bridge = makeBridgeRemediator(result.deps.env);
    return { ...result, operations };
  }
  it.each(targets)("reloads only the actual %s extension", async (target, name) => {
    const s = realBridge([{ id: "bridge-extension", name: "Noelle Chrome Bridge", enabled: true },
      { id: "lane-extension", name, enabled: true, installType: "development", mayDisable: true }]);
    const result = await remediate("reload_extension", { ...ctx, target }, s.deps);
    expect(s.operations).toEqual([{ op: "ext.list" }, { op: "ext.reload", extId: "lane-extension" }]);
    expect(result).toMatchObject({ ok: true, mutated: true });
    expect(s.pm2.restartApp).not.toHaveBeenCalled();
  });
  it.each([
    { entries: [] },
    { entries: [{ id: "disabled", name: "Noelle X Actuator", enabled: false, installType: "development", mayDisable: true }] },
    { entries: [{ id: "a", name: "Noelle X Actuator", enabled: true, installType: "development", mayDisable: true },
      { id: "b", name: "Noelle X Actuator", enabled: true, installType: "development", mayDisable: true }] },
  ])("refuses an absent, disabled or ambiguous lane without touching another extension", async ({ entries }) => {
    const s = realBridge(entries);
    const result = await remediate("reload_extension", ctx, s.deps);
    expect(result).toMatchObject({ ok: false, mutated: false });
    expect(s.operations).toEqual([{ op: "ext.list" }]);
    expect(s.pm2.restartApp).not.toHaveBeenCalled();
  });
  it("requires the reload receipt to acknowledge the selected extension", async () => {
    const s = realBridge([{ id: "lane-extension", name: "Noelle X Actuator", enabled: true,
      installType: "development", mayDisable: true }], "other-extension");
    expect(await remediate("reload_extension", ctx, s.deps)).toMatchObject({ ok: false, mutated: true });
    expect(s.pm2.restartApp).not.toHaveBeenCalled();
  });
  it("preserves the bridge's own reload path", async () => {
    const s = realBridge([], "bridge-extension");
    expect(await remediate("reload_extension", { ...ctx, target: "bridge" }, s.deps)).toMatchObject({ ok: true, mutated: true });
    expect(s.operations).toEqual([{ op: "meta.info" }, { op: "ext.reload", extId: "bridge-extension" }]);
  });
});

describe("RollingCounter", () => {
  it("counts events within the window and prunes older ones", () => {
    const c = new RollingCounter(HOUR);
    const now = 1_000_000_000;
    c.record("a", now - 2 * HOUR); // outside window
    c.record("a", now - 100);
    c.record("a", now - 50);
    expect(c.count("a", now)).toBe(2);
  });

  it("total() sums across keys within the window", () => {
    const c = new RollingCounter(HOUR);
    const now = 5_000;
    c.record("a", now - 10);
    c.record("b", now - 20);
    c.record("b", now - 30);
    expect(c.total(now)).toBe(3);
  });
});

describe("canRemediate", () => {
  it("blocks once a signature hits its per-hour cap", () => {
    const c = new RollingCounter();
    const now = Date.now();
    for (let i = 0; i < 3; i++) c.record("sig", now);
    expect(canRemediate(c, "sig", 3, 100, now)).toBe(false);
    expect(canRemediate(c, "other", 3, 100, now)).toBe(true);
  });

  it("blocks once the global cap is hit even for a fresh signature", () => {
    const c = new RollingCounter();
    const now = Date.now();
    for (let i = 0; i < 6; i++) c.record(`s${i}`, now); // 6 distinct sigs
    expect(canRemediate(c, "fresh", 10, 6, now)).toBe(false);
  });
});

describe("nextRung", () => {
  const ladder: RemediationAction[] = ["reload_extension", "reconnect_bridge", "page_human"];
  it("starts at the first rung for a new fault", () => {
    expect(nextRung(ladder, null)).toBe("reload_extension");
  });
  it("advances one rung for a continuing fault", () => {
    expect(nextRung(ladder, "reload_extension")).toBe("reconnect_bridge");
  });
  it("clamps at the final rung", () => {
    expect(nextRung(ladder, "page_human")).toBe("page_human");
  });
});

describe("decideAction (cap logic)", () => {
  const ladder: RemediationAction[] = ["restart_worker", "page_human"];

  it("takes the first rung for a fresh fault", () => {
    const c = new RollingCounter();
    const d = decideAction({ ladder, lastAction: null, counter: c, signatureId: "s", maxPerHour: 3, globalCap: 6, now: Date.now() });
    expect(d).toEqual({ action: "restart_worker", capped: false });
  });

  it("swaps a mutating rung for a one-shot page_human when the per-hour cap is hit", () => {
    const c = new RollingCounter();
    const now = Date.now();
    for (let i = 0; i < 3; i++) c.record("s", now);
    const d = decideAction({ ladder, lastAction: null, counter: c, signatureId: "s", maxPerHour: 3, globalCap: 100, now });
    expect(d).toEqual({ action: "page_human", capped: true });
  });

  it("never caps a non-mutating rung", () => {
    const c = new RollingCounter();
    const now = Date.now();
    for (let i = 0; i < 50; i++) c.record("s", now);
    // lastAction is the top rung -> proposed is page_human (non-mutating) -> not capped.
    const d = decideAction({ ladder, lastAction: "page_human", counter: c, signatureId: "s", maxPerHour: 3, globalCap: 6, now });
    expect(d).toEqual({ action: "page_human", capped: false });
  });
});
