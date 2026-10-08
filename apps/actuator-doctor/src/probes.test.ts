import { afterEach, describe, expect, it, vi } from "vitest";
import type { DoctorTarget, ProbeResult } from "@noelle/contracts";
import type { Env } from "./env.js";
import { applyArmAwareness, isInOperatingWindow, probeApiFreshness, probeChromeReachable, probeHeartbeat, probeStuckQueue, type ArmState } from "./probes.js";

const GRACE = 900_000;
const at = "2026-07-18T00:00:00.000Z";

function env(): Env {
  return {
    NOELLE_BRIDGE_URL: "http://127.0.0.1:18792",
    NOELLE_DOCTOR_HTTP_TIMEOUT_MS: 1000,
    NOELLE_BRIDGE_TOKEN: "t",
    NOELLE_DOCTOR_HEARTBEAT_GRACE_MS: GRACE,
  } as unknown as Env;
}

describe("probeStuckQueue", () => {
  function captureSql() {
    const fragments: string[] = [];
    const sql = Object.assign(
      vi.fn(async (strings: TemplateStringsArray) => {
        fragments.push(strings.join("?"));
        return [];
      }),
      { unsafe: vi.fn(), json: (x: unknown) => x },
    ) as never;
    return { sql, fragments };
  }

  it("also counts approvals with NO auto_send_target_at (the probe was dead system-wide)", async () => {
    // Regression: the X intern stopped stamping auto_send_target_at, so EVERY
    // pending approval is unstamped and the old `is not null` rule matched zero
    // rows on every lane — Vega sat days with 33 pending and the doctor never
    // faulted. Both arms must be present.
    const { sql, fragments } = captureSql();
    await probeStuckQueue(
      { NOELLE_DOCTOR_STUCK_QUEUE_MIN: 30, NOELLE_DOCTOR_STUCK_QUEUE_AGE_MIN: 120, NOELLE_DOCTOR_STUCK_QUEUE_DEPTH: 5 } as unknown as Env,
      sql,
      at,
    );
    const q = fragments[0]!;
    // arm 1 — stamped rows past their send target (unchanged behaviour)
    expect(q).toMatch(/auto_send_target_at is not null/);
    // arm 2 — unstamped rows judged on their own age, which is what revives it
    expect(q).toMatch(/auto_send_target_at is null/);
    expect(q).toMatch(/created_at < now\(\)/);
  });

  it("fails OPEN on a DB error — an unreadable DB must never look like a stuck queue", async () => {
    const sql = Object.assign(
      vi.fn(async () => { throw new Error("db down"); }),
      { unsafe: vi.fn(), json: (x: unknown) => x },
    ) as never;
    const out = await probeStuckQueue(
      { NOELLE_DOCTOR_STUCK_QUEUE_MIN: 30, NOELLE_DOCTOR_STUCK_QUEUE_AGE_MIN: 120, NOELLE_DOCTOR_STUCK_QUEUE_DEPTH: 5 } as unknown as Env,
      sql,
      at,
    );
    expect(out.length).toBeGreaterThan(0);
    expect(out.every((p) => p.ok)).toBe(true);
  });
});

function mockHeartbeats(
  sources: Array<{ source: string; stale: boolean; age_ms: number; state: string }>,
  status = 200,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ status, json: async () => ({ sources }) })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("infrastructure health receipts", () => {
  const settings = () => ({ ...env(), NOELLE_API_URL: "http://127.0.0.1:18791" });
  const sql = vi.fn(async () => []) as never;
  it.each([
    { status: 200, body: { ok: true }, healthy: true },
    { status: 503, body: { ok: false }, healthy: false },
    { status: 200, body: { ok: false }, healthy: false },
    { status: 401, body: {}, healthy: false },
  ])("retains the actual API health outcome $status/$healthy", async ({ status, body, healthy }) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status, json: async () => body })));
    const probes = await probeApiFreshness(settings(), sql, at, Date.parse(at));
    expect(probes.find(p => p.check === "api_freshness")?.ok).toBe(healthy);
  });
  it.each([503, 200])("retains an authenticated degraded status receipt %s", async status => {
    const fetchImpl = vi.fn(async () => ({ status, json: async () => ({ ok: false }) }));
    vi.stubGlobal("fetch", fetchImpl);
    const probes = await probeApiFreshness({ ...settings(), NOELLE_LOCAL_OPERATOR_JWT: "inert" }, sql, at, Date.parse(at));
    expect(probes.find(p => p.check === "api_freshness")?.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
  it("uses unauthenticated health when status rejects the optional token", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce({ status: 401, json: async () => ({}) })
      .mockResolvedValueOnce({ status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchImpl);
    const probes = await probeApiFreshness({ ...settings(), NOELLE_LOCAL_OPERATOR_JWT: "inert" }, sql, at, Date.parse(at));
    expect(probes.find(p => p.check === "api_freshness")?.ok).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([
    { status: 503, body: { ext_connected: true } },
    { status: 200, body: {} },
  ])("keeps an invalid bridge health receipt unhealthy ($status)", async ({ status, body }) => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ status, json: async () => body })));
    const probes = await probeChromeReachable(env(), at);
    const result = applyArmAwareness(probes, armState([]), { inWindow: false, inWarmup: true, pendingDue: {} });
    expect(result[0]?.ok).toBe(false);
  });
});

describe("probeHeartbeat", () => {
  it("probes the browser actuators (x + linkedin + reddit)", async () => {
    mockHeartbeats([]);
    const out = await probeHeartbeat(env(), at, GRACE + 1);
    const targets = out.map((p) => p.target).sort();
    expect(targets).toEqual(["linkedin-actuator", "reddit-intern", "x-actuator"]);
  });

  it("resolves a 'reddit-actuator'-sourced heartbeat onto the reddit-intern lane", async () => {
    mockHeartbeats([{ source: "reddit-actuator", stale: false, age_ms: 1000, state: "running" }]);
    const out = await probeHeartbeat(env(), at, GRACE + 1);
    const reddit = out.find((p) => p.target === "reddit-intern");
    expect(reddit?.ok).toBe(true);
    expect(reddit?.metrics.present).toBe(true);
    // and there is no lane target literally named "reddit-actuator"
    expect(out.some((p) => (p.target as string) === "reddit-actuator")).toBe(false);
  });

  it("tolerates a never-seen heartbeat DURING the warmup grace (ok, warmup)", async () => {
    mockHeartbeats([]); // nothing reporting yet
    const out = await probeHeartbeat(env(), at, GRACE - 1);
    expect(out.every((p) => p.ok)).toBe(true);
    expect(out.find((p) => p.target === "x-actuator")?.metrics.note).toBe("heartbeat-warmup");
  });

  it("faults on a never-seen heartbeat AFTER the warmup grace", async () => {
    mockHeartbeats([]);
    const out = await probeHeartbeat(env(), at, GRACE + 1);
    const x = out.find((p) => p.target === "x-actuator");
    expect(x?.ok).toBe(false);
    expect(x?.reason).toBe("heartbeat-absent");
  });

  it("faults on a STALE heartbeat even within the warmup grace (a live ext went silent)", async () => {
    mockHeartbeats([{ source: "x-actuator", stale: true, age_ms: 9_999_999, state: "idle" }]);
    const out = await probeHeartbeat(env(), at, 0); // just booted
    const x = out.find((p) => p.target === "x-actuator");
    expect(x?.ok).toBe(false);
    expect(x?.reason).toBe("heartbeat-stale");
  });

  it("passes a fresh heartbeat", async () => {
    mockHeartbeats([{ source: "x-actuator", stale: false, age_ms: 1000, state: "running" }]);
    const out = await probeHeartbeat(env(), at, GRACE + 1);
    expect(out.find((p) => p.target === "x-actuator")?.ok).toBe(true);
  });

  it("on 401 surfaces a bridge heartbeats-unauthorized fault and no lane faults", async () => {
    mockHeartbeats([], 401);
    const out = await probeHeartbeat(env(), at, GRACE + 1);
    const bridge = out.find((p) => p.target === "bridge");
    expect(bridge?.ok).toBe(false);
    expect(bridge?.reason).toBe("heartbeats-unauthorized");
    // every lane (x, linkedin, reddit) stays ok=true — we can't read them
    expect(out.filter((p) => p.target !== "bridge").every((p) => p.ok)).toBe(true);
  });
});

// Local-time-anchored epoch so getHours() is deterministic regardless of the
// test machine's timezone (both constructed and read in local time).
function atHour(h: number): number {
  return new Date(2026, 0, 1, h, 0, 0).getTime();
}

describe("isInOperatingWindow", () => {
  it("non-wrapping window [8,23)", () => {
    expect(isInOperatingWindow(atHour(10), 8, 23)).toBe(true);
    expect(isInOperatingWindow(atHour(8), 8, 23)).toBe(true);
    expect(isInOperatingWindow(atHour(23), 8, 23)).toBe(false); // end exclusive
    expect(isInOperatingWindow(atHour(2), 8, 23)).toBe(false); // overnight
  });
  it("wrapping window [22,6)", () => {
    expect(isInOperatingWindow(atHour(23), 22, 6)).toBe(true);
    expect(isInOperatingWindow(atHour(3), 22, 6)).toBe(true);
    expect(isInOperatingWindow(atHour(12), 22, 6)).toBe(false);
  });
  it("[0,24) is always in-window", () => {
    for (const h of [0, 6, 12, 23]) expect(isInOperatingWindow(atHour(h), 0, 24)).toBe(true);
  });
});

function armState(armedLanes: DoctorTarget[]): ArmState {
  const mk = (armed: boolean) => ({ armed, autoSend: false, instanceIds: armed ? ["i"] : [] });
  const s = {
    "x-actuator": mk(armedLanes.includes("x-actuator")),
    "linkedin-actuator": mk(armedLanes.includes("linkedin-actuator")),
    "reddit-intern": mk(armedLanes.includes("reddit-intern")),
    bridge: mk(false),
    "api-vm": mk(true),
  } as ArmState;
  s.bridge.armed = armedLanes.length > 0;
  return s;
}
function pr(target: DoctorTarget, check: string, ok: boolean, reason?: string): ProbeResult {
  return { target, check, ok, reason: ok ? undefined : reason ?? check + "-bad", metrics: {}, at: "t" };
}
// The bridge fault the idle gate is FOR: Chrome closed, extension disconnected.
const extDisconnected = () => pr("bridge", "chrome_reachable", false, "ext-disconnected");
const ok = (p: ProbeResult) => p.ok;

describe("applyArmAwareness operating-window guard", () => {
  const armedInWindow = { inWindow: true, inWarmup: false };

  it.each([
    { inWindow: false, inWarmup: false, armed: true },
    { inWindow: true, inWarmup: false, armed: false },
    { inWindow: true, inWarmup: true, armed: true },
  ])("keeps a dead bridge unhealthy during $inWindow/$inWarmup/$armed", ({ inWindow, inWarmup, armed }) => {
    const probes = [pr("bridge", "chrome_reachable", false, "bridge-unreachable")];
    expect(applyArmAwareness(probes, armState(armed ? ["x-actuator"] : []), { inWindow, inWarmup, pendingDue: {} })[0]?.ok).toBe(false);
  });

  it("KEEPS faults when a lane is armed, in-window, past warmup", () => {
    const arm = armState(["x-actuator"]);
    const probes = [pr("x-actuator", "heartbeat", false), extDisconnected()];
    const out = applyArmAwareness(probes, arm, armedInWindow);
    expect(out.every((p) => !ok(p))).toBe(true); // both still real faults
  });

  it("downgrades browser-actuation faults OFF-HOURS (Chrome closed overnight is expected)", () => {
    const arm = armState(["x-actuator"]);
    const probes = [pr("x-actuator", "heartbeat", false), extDisconnected()];
    const out = applyArmAwareness(probes, arm, { inWindow: false, inWarmup: false });
    expect(out.every(ok)).toBe(true);
    expect(out.find((p) => p.target === "bridge")?.metrics.downgraded_reason).toBe("off-hours");
  });

  it("downgrades during the post-deploy warmup", () => {
    const arm = armState(["x-actuator"]);
    const out = applyArmAwareness([extDisconnected()], arm, {
      inWindow: true,
      inWarmup: true,
    });
    expect(out.every(ok)).toBe(true);
    expect(out[0]?.metrics.downgraded_reason).toBe("warmup");
  });

  it("KEEPS a bridge ext-disconnect when the reddit lane is armed (it now drives a Chrome extension)", () => {
    // reddit-intern gained a browser extension (reddit-actuator): an armed reddit
    // lane now arms the bridge, so an ext-disconnect is a real fault it can page.
    const arm = armState(["reddit-intern"]);
    const out = applyArmAwareness([extDisconnected()], arm, armedInWindow);
    expect(out.every((p) => !ok(p))).toBe(true);
  });

  it("NEVER downgrades 24/7 infra faults (db_reachable) regardless of the window", () => {
    const arm = armState([]); // nothing armed, off-hours, warming up — worst case for suppression
    const out = applyArmAwareness([pr("api-vm", "db_reachable", false)], arm, {
      inWindow: false,
      inWarmup: true,
    });
    expect(out[0]?.ok).toBe(false); // a DB outage pages at 3am
  });
});

describe("applyArmAwareness idle gate", () => {
  // Armed, in-window, past warmup — the exact state that used to page hourly the
  // moment Chrome was closed, send queue or no send queue.
  const armedInWindow = { inWindow: true, inWarmup: false };

  it("downgrades connectivity faults on an armed lane with NO due sendable work (Chrome closed on purpose)", () => {
    const arm = armState(["x-actuator"]);
    const probes = [pr("x-actuator", "heartbeat", false), extDisconnected()];
    const out = applyArmAwareness(probes, arm, { ...armedInWindow, pendingDue: {} });
    expect(out.every(ok)).toBe(true);
    expect(out[0]?.metrics.downgraded_reason).toBe("idle");
    expect(out[0]?.metrics.armed).toBe(true); // downgraded for idleness, not disarmament
    expect(out[1]?.metrics.downgraded_reason).toBe("idle");
  });

  it("KEEPS connectivity faults when browser work is due (cannot-activate-when-needed still pages)", () => {
    // linkedin, not x: readBrowserDue can only ever produce linkedin/reddit due
    // counts (X's stamped rows are API-autosend-owned).
    const arm = armState(["linkedin-actuator"]);
    const probes = [pr("linkedin-actuator", "heartbeat", false), extDisconnected()];
    const out = applyArmAwareness(probes, arm, {
      ...armedInWindow,
      pendingDue: { "linkedin-actuator": 2 },
    });
    expect(out.every((p) => !ok(p))).toBe(true);
  });

  it("gates per lane: only the lane with due work keeps its fault (and it keeps the bridge urgent)", () => {
    const arm = armState(["x-actuator", "linkedin-actuator"]);
    const probes = [
      pr("x-actuator", "heartbeat", false),
      pr("linkedin-actuator", "heartbeat", false),
      extDisconnected(),
    ];
    const out = applyArmAwareness(probes, arm, {
      ...armedInWindow,
      pendingDue: { "linkedin-actuator": 1 },
    });
    expect(out.find((p) => p.target === "linkedin-actuator")?.ok).toBe(false);
    expect(out.find((p) => p.target === "x-actuator")?.ok).toBe(true);
    expect(out.find((p) => p.target === "bridge")?.ok).toBe(false);
  });

  it("due work on a DISARMED lane does not keep the bridge urgent", () => {
    // linkedin has due drafts but its send lane is disarmed — nothing can send,
    // so a closed Chrome is still the operator's choice.
    const arm = armState(["x-actuator"]);
    const out = applyArmAwareness([extDisconnected()], arm, {
      ...armedInWindow,
      pendingDue: { "linkedin-actuator": 3 },
    });
    expect(out[0]?.ok).toBe(true);
    expect(out[0]?.metrics.downgraded_reason).toBe("idle");
  });

  it("due reddit browser work KEEPS the bridge urgent (its actuator drains stamped rows via Chrome)", () => {
    // reddit never ARMS the bridge, but when a browser lane does, due reddit
    // work must still count against bridge idleness.
    const arm = armState(["x-actuator", "reddit-intern"]);
    const out = applyArmAwareness([extDisconnected()], arm, {
      ...armedInWindow,
      pendingDue: { "reddit-intern": 5 },
    });
    expect(out[0]?.ok).toBe(false);
  });

  it("NEVER idle-downgrades activity faults (send_failures / stuck_queue imply real send attempts)", () => {
    const arm = armState(["x-actuator"]);
    const probes = [pr("x-actuator", "send_failures", false), pr("x-actuator", "stuck_queue", false)];
    const out = applyArmAwareness(probes, arm, { ...armedInWindow, pendingDue: {} });
    expect(out.every((p) => !ok(p))).toBe(true);
  });

  it("NEVER idle-gates a dead bridge process: bridge-unreachable is 24/7 infra, not a closed Chrome", () => {
    // chrome_reachable is the ONLY paging path for a dead/hung chrome-bridge
    // (the seed has no bridge pm2 signature) — an idle queue must not hide it.
    const arm = armState(["x-actuator"]);
    const probes = [pr("bridge", "chrome_reachable", false, "bridge-unreachable")];
    const out = applyArmAwareness(probes, arm, { ...armedInWindow, pendingDue: {} });
    expect(out[0]?.ok).toBe(false);
  });

  it("NEVER idle-gates other bridge checks (heartbeats-unauthorized pages immediately)", () => {
    const arm = armState(["x-actuator"]);
    const probes = [pr("bridge", "heartbeat", false, "heartbeats-unauthorized")];
    const out = applyArmAwareness(probes, arm, { ...armedInWindow, pendingDue: {} });
    expect(out[0]?.ok).toBe(false);
  });

  it("idle is the LAST downgrade reason: disarmed / off-hours / warmup label first", () => {
    const heartbeatFault = () => [pr("x-actuator", "heartbeat", false)];
    const idle = { pendingDue: {} as const };
    const disarmed = applyArmAwareness(heartbeatFault(), armState([]), { ...armedInWindow, ...idle });
    expect(disarmed[0]?.metrics.downgraded_reason).toBe("disarmed");
    const offHours = applyArmAwareness(heartbeatFault(), armState(["x-actuator"]), {
      inWindow: false,
      inWarmup: false,
      ...idle,
    });
    expect(offHours[0]?.metrics.downgraded_reason).toBe("off-hours");
    const warmup = applyArmAwareness(heartbeatFault(), armState(["x-actuator"]), {
      inWindow: true,
      inWarmup: true,
      ...idle,
    });
    expect(warmup[0]?.metrics.downgraded_reason).toBe("warmup");
  });

  it("pendingDue null (NOELLE_DOCTOR_PAGE_WHEN_IDLE) restores always-page-while-armed", () => {
    const arm = armState(["x-actuator"]);
    const probes = [pr("x-actuator", "heartbeat", false), extDisconnected()];
    const out = applyArmAwareness(probes, arm, { ...armedInWindow, pendingDue: null });
    expect(out.every((p) => !ok(p))).toBe(true);
  });
});
