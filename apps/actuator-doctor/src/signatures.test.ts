import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SignatureStoreSchema,
  type DoctorTarget,
  type ProbeResult,
  type SignatureStore,
} from "@noelle/contracts";
import { matchSignatures, topMatchPerTarget } from "./signatures.js";

// The shipped seed store — matching is validated against the real signatures.
const SEED_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "signatures.seed.json");
const SEED: SignatureStore = SignatureStoreSchema.parse(JSON.parse(readFileSync(SEED_PATH, "utf8")));

type Metrics = Record<string, number | string | boolean | null>;

function probe(
  target: DoctorTarget,
  check: string,
  ok: boolean,
  opts: { reason?: string; metrics?: Metrics } = {},
): ProbeResult {
  const r: ProbeResult = { target, check, ok, metrics: opts.metrics ?? {}, at: "2026-07-17T00:00:00.000Z" };
  if (opts.reason) r.reason = opts.reason;
  return r;
}

// A fully-healthy probe set covering every (target, check) the seeds reference.
// Tests flip individual probes to fault and assert the matcher's reaction.
function baseProbes(): ProbeResult[] {
  const lanes: DoctorTarget[] = ["x-actuator", "linkedin-actuator", "reddit-intern"];
  const out: ProbeResult[] = [];
  for (const t of lanes) {
    out.push(probe(t, "pm2", true));
    out.push(probe(t, "heartbeat", true));
    out.push(probe(t, "stuck_queue", true, { metrics: { depth: 0 } }));
    out.push(probe(t, "send_failures", true, { metrics: { skips: 0 } }));
  }
  out.push(probe("bridge", "pm2", true));
  out.push(probe("bridge", "chrome_reachable", true));
  out.push(probe("api-vm", "pm2", true));
  out.push(probe("api-vm", "api_freshness", true));
  return out;
}

function set(
  probes: ProbeResult[],
  target: DoctorTarget,
  check: string,
  ok: boolean,
  opts: { reason?: string; metrics?: Metrics } = {},
): ProbeResult[] {
  return probes.map((p) => (p.target === target && p.check === check ? probe(target, check, ok, opts) : p));
}

function ids(probes: ProbeResult[]) {
  return matchSignatures(SEED, probes).map((m) => `${m.signature.id}@${m.target}`);
}

describe("seed store", () => {
  it("ships exactly the eight seed signatures at version 1", () => {
    expect(SEED.version).toBe(1);
    expect(SEED.signatures.map((s) => s.id).sort()).toEqual([
      "api-vm-down",
      "db-unreachable",
      "ext-disconnected-while-armed",
      "heartbeat-stale-armed",
      "heartbeats-unauthorized",
      "queue-stuck-armed",
      "send-failures-spike",
      "worker-offline",
    ]);
    for (const s of SEED.signatures) {
      expect(s.ladder.length).toBeGreaterThan(0);
      expect(s.ladder.at(-1)).toBe("page_human"); // every ladder ends at a human page
      expect(s.maxPerHour).toBeGreaterThan(0);
    }
  });

  it("heartbeat-stale-armed never restarts a worker (heartbeat is from the ext, not pm2)", () => {
    const sig = SEED.signatures.find((s) => s.id === "heartbeat-stale-armed")!;
    expect(sig.ladder).toEqual(["reconnect_bridge", "page_human"]);
    expect(sig.ladder).not.toContain("restart_worker");
  });

  it("db-unreachable fires on an api-vm db_reachable fault (break-the-silence)", () => {
    const probes = [probe("api-vm", "db_reachable", false, { reason: "db-unreachable" })];
    expect(ids(probes)).toContain("db-unreachable@api-vm");
  });

  it("heartbeats-unauthorized fires only on a 401/403 (reason 'unauthorized'), not a normal stale heartbeat", () => {
    const unauth = [probe("bridge", "heartbeat", false, { reason: "heartbeats-unauthorized" })];
    expect(ids(unauth)).toContain("heartbeats-unauthorized@bridge");
    // a lane heartbeat fault must NOT trip the bridge-target unauthorized signature
    const laneStale = [probe("x-actuator", "heartbeat", false, { reason: "heartbeat-stale" })];
    expect(ids(laneStale)).not.toContain("heartbeats-unauthorized@bridge");
  });
});

describe("matchSignatures", () => {
  it("fires nothing when every probe is healthy", () => {
    expect(ids(baseProbes())).toEqual([]);
  });

  it("worker-offline fires only for the faulting lane", () => {
    const probes = set(baseProbes(), "x-actuator", "pm2", false, { reason: "pm2-offline" });
    expect(ids(probes)).toEqual(["worker-offline@x-actuator"]);
  });

  it("heartbeat-stale-armed fires for the lane whose heartbeat is stale (lane substitution)", () => {
    const probes = set(baseProbes(), "linkedin-actuator", "heartbeat", false, { reason: "heartbeat-stale" });
    expect(ids(probes)).toEqual(["heartbeat-stale-armed@linkedin-actuator"]);
  });

  it("ext-disconnected-while-armed is a global bridge signature", () => {
    const probes = set(baseProbes(), "bridge", "chrome_reachable", false, { reason: "ext-disconnected" });
    // The chrome_reachable fault ALSO invalidates queue-stuck-armed's cross-ref
    // clause, so only the ext signature fires.
    expect(ids(probes)).toEqual(["ext-disconnected-while-armed@bridge"]);
  });

  it("queue-stuck-armed requires BOTH a stuck queue AND a reachable extension", () => {
    // Both conditions hold -> fires for that lane.
    let probes = set(baseProbes(), "x-actuator", "stuck_queue", false, { reason: "queue-stuck", metrics: { depth: 9 } });
    expect(ids(probes)).toEqual(["queue-stuck-armed@x-actuator"]);

    // Extension NOT reachable -> queue-stuck-armed must NOT fire (ext signature does).
    probes = set(probes, "bridge", "chrome_reachable", false, { reason: "ext-disconnected" });
    const fired = ids(probes);
    expect(fired).toContain("ext-disconnected-while-armed@bridge");
    expect(fired).not.toContain("queue-stuck-armed@x-actuator");
  });

  it("send-failures-spike fires for the lane with the skip spike", () => {
    const probes = set(baseProbes(), "reddit-intern", "send_failures", false, { reason: "send-failures-spike" });
    expect(ids(probes)).toEqual(["send-failures-spike@reddit-intern"]);
  });

  it("api-vm-down fires on an api_freshness fault", () => {
    const probes = set(baseProbes(), "api-vm", "api_freshness", false, { reason: "unreachable" });
    expect(ids(probes)).toEqual(["api-vm-down@api-vm"]);
  });

  it("a missing referenced probe makes a clause fail closed (no spurious match)", () => {
    // Drop the bridge chrome_reachable probe entirely: queue-stuck-armed can't
    // confirm its cross-ref, so it must not fire even with a stuck queue.
    const probes = set(baseProbes(), "x-actuator", "stuck_queue", false, { reason: "queue-stuck" }).filter(
      (p) => !(p.target === "bridge" && p.check === "chrome_reachable"),
    );
    expect(ids(probes)).not.toContain("queue-stuck-armed@x-actuator");
  });
});

describe("matchSignatures clause operators", () => {
  it("evaluates a metric/op/value clause", () => {
    const store = SignatureStoreSchema.parse({
      version: 1,
      updatedAt: "2026-07-17T00:00:00.000Z",
      signatures: [
        {
          id: "deep-queue",
          title: "deep queue",
          description: "depth >= 10",
          match: [{ target: "x-actuator", check: "stuck_queue", metric: "depth", op: "gte", value: 10 }],
          ladder: ["page_human"],
        },
      ],
    });
    const deep = [probe("x-actuator", "stuck_queue", false, { metrics: { depth: 12 } })];
    const shallow = [probe("x-actuator", "stuck_queue", false, { metrics: { depth: 5 } })];
    expect(matchSignatures(store, deep).map((m) => m.signature.id)).toEqual(["deep-queue"]);
    expect(matchSignatures(store, shallow)).toEqual([]);
  });

  it("evaluates a reasonIncludes clause as a substring match", () => {
    const store = SignatureStoreSchema.parse({
      version: 1,
      updatedAt: "2026-07-17T00:00:00.000Z",
      signatures: [
        {
          id: "disc",
          title: "disconnected",
          description: "reason contains 'disconnected'",
          match: [{ target: "bridge", check: "chrome_reachable", reasonIncludes: "disconnected" }],
          ladder: ["page_human"],
        },
      ],
    });
    const hit = [probe("bridge", "chrome_reachable", false, { reason: "ext-disconnected" })];
    const miss = [probe("bridge", "chrome_reachable", false, { reason: "bridge-unreachable" })];
    expect(matchSignatures(store, hit).map((m) => m.signature.id)).toEqual(["disc"]);
    expect(matchSignatures(store, miss)).toEqual([]);
  });
});

describe("topMatchPerTarget", () => {
  it("keeps the highest-confidence signature per target", () => {
    const store = SignatureStoreSchema.parse({
      version: 1,
      updatedAt: "2026-07-17T00:00:00.000Z",
      signatures: [
        { id: "low", title: "l", description: "d", match: [{ target: "api-vm", check: "api_freshness", ok: false }], ladder: ["page_human"], confidence: 0.3 },
        { id: "high", title: "h", description: "d", match: [{ target: "api-vm", check: "api_freshness", ok: false }], ladder: ["page_human"], confidence: 0.9 },
      ],
    });
    const top = topMatchPerTarget(matchSignatures(store, [probe("api-vm", "api_freshness", false)]));
    expect(top.get("api-vm")?.signature.id).toBe("high");
  });
});
