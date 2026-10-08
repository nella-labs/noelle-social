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
