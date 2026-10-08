import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SignatureStoreSchema,
  type DoctorTarget,
  type ProbeResult,
  type Signature,
  type SignatureStore,
} from "@noelle/contracts";
import type { Env } from "./env.js";
import { LANE_TARGETS, isLaneTarget } from "./targets.js";

// ---------------------------------------------------------------------------
// Matching — PURE + unit-testable (src/signatures.test.ts). No fs, no clock.
//
// A signature fires when ALL its match clauses hold. A clause reads a probe by
// (target, check) and asserts on ok / reasonIncludes / metric-op-value.
//
// LANE SUBSTITUTION: the DoctorTarget enum has no "any lane" value, so a
// lane-agnostic signature (heartbeat-stale-armed, worker-offline, …) is written
// with ANY lane target as a placeholder and evaluated once per lane. When
// evaluating for a subject lane, every LANE-typed clause is resolved against the
// subject; clauses on a NON-lane target (bridge / api-vm) are literal
// cross-references (e.g. "…and the bridge is reachable"). A signature with no
// lane clause is global and evaluated once for its first clause's target.
// ---------------------------------------------------------------------------

export interface SignatureMatch {
  signature: Signature;
  target: DoctorTarget; // the concrete lane/target the incident is about
}

type MatchClause = Signature["match"][number];

function compare(
  metric: number | string | boolean | null | undefined,
  op: NonNullable<MatchClause["op"]>,
  value: number | string | boolean,
): boolean {
  if (metric === undefined || metric === null) return false;
  if (typeof metric === "number" && typeof value === "number") {
    switch (op) {
      case "gt":
        return metric > value;
      case "gte":
        return metric >= value;
      case "lt":
        return metric < value;
      case "lte":
        return metric <= value;
      case "eq":
        return metric === value;
      case "ne":
        return metric !== value;
    }
  }
  // Non-numeric operands only support equality.
  if (op === "eq") return metric === value;
  if (op === "ne") return metric !== value;
  return false;
}

function clauseHolds(clause: MatchClause, subject: DoctorTarget, probes: ProbeResult[]): boolean {
  const target = isLaneTarget(clause.target) ? subject : clause.target;
  const probe = probes.find((p) => p.target === target && p.check === clause.check);
  if (!probe) return false; // a required probe never ran -> the clause cannot hold
  if (clause.ok !== undefined && probe.ok !== clause.ok) return false;
  if (clause.reasonIncludes !== undefined) {
    if (!probe.reason || !probe.reason.includes(clause.reasonIncludes)) return false;
  }
  if (clause.metric !== undefined && clause.op !== undefined && clause.value !== undefined) {
    if (!compare(probe.metrics[clause.metric], clause.op, clause.value)) return false;
  }
  return true;
}

export function matchSignatures(store: SignatureStore, probes: ProbeResult[]): SignatureMatch[] {
  const out: SignatureMatch[] = [];
  const seen = new Set<string>();
  for (const signature of store.signatures) {
    const laneScoped = signature.match.some((c) => isLaneTarget(c.target));
    const subjects: DoctorTarget[] = laneScoped
      ? [...LANE_TARGETS]
      : signature.match[0]
        ? [signature.match[0].target]
        : [];
    for (const subject of subjects) {
      if (signature.match.every((c) => clauseHolds(c, subject, probes))) {
        const key = `${signature.id}::${subject}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push({ signature, target: subject });
        }
      }
    }
  }
  return out;
}

// When several signatures fire for the same target on one tick, remediate the
// highest-confidence one (ties: earliest in the store). Pure.
export function topMatchPerTarget(matches: SignatureMatch[]): Map<DoctorTarget, SignatureMatch> {
  const best = new Map<DoctorTarget, SignatureMatch>();
  for (const m of matches) {
    const cur = best.get(m.target);
    if (!cur || m.signature.confidence > cur.signature.confidence) best.set(m.target, m);
  }
  return best;
}

// ---------------------------------------------------------------------------
// Store load / persist / bookkeeping (impure — fs).
// ---------------------------------------------------------------------------

function seedPath(env: Env): string {
  if (env.NOELLE_DOCTOR_SEED_PATH) return env.NOELLE_DOCTOR_SEED_PATH;
  // signatures.seed.json ships at the app root, one level above BOTH src/ and
  // dist/, so this URL resolves whether we run compiled (dist) or via tsx (src).
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "signatures.seed.json");
}

export function readSeedStore(env: Env): SignatureStore {
  const raw = JSON.parse(readFileSync(seedPath(env), "utf8"));
  return SignatureStoreSchema.parse(raw); // fills timesSeen/timesResolved/etc defaults
}

function storePath(env: Env): string {
  return path.join(env.NOELLE_DOCTOR_STATE_DIR, "signatures.json");
}

// Load the learned store; seed-copy from signatures.seed.json on first run. A
// corrupt store falls back to the seed IN MEMORY without clobbering the file, so
// a human can inspect what broke.
export function loadSignatureStore(env: Env): SignatureStore {
  mkdirSync(env.NOELLE_DOCTOR_STATE_DIR, { recursive: true });
  const p = storePath(env);
  if (!existsSync(p)) {
    const seeded = readSeedStore(env);
    writeFileSync(p, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  try {
    return SignatureStoreSchema.parse(JSON.parse(readFileSync(p, "utf8")));
  } catch {
    return readSeedStore(env);
  }
}

export function persistStore(env: Env, store: SignatureStore): void {
  try {
    store.updatedAt = new Date().toISOString();
    const p = storePath(env);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    // rename is atomic on the same fs — a reader never sees a half-written store.
    renameSync(tmp, p);
  } catch {
    // A persist failure must not crash the loop; next tick retries.
  }
}

// Bump learn-bookkeeping when a signature matches. Mutates the store in place.
export function bumpSignatureOnMatch(store: SignatureStore, id: string, nowIso: string): void {
  const sig = store.signatures.find((s) => s.id === id);
  if (!sig) return;
  sig.timesSeen += 1;
  sig.lastSeen = nowIso;
}

export function markSignatureResolved(store: SignatureStore, id: string): void {
  const sig = store.signatures.find((s) => s.id === id);
  if (!sig) return;
  sig.timesResolved += 1;
  // Nudge confidence toward 1 as confirmed fixes accumulate (bounded).
  sig.confidence = Math.min(1, Math.round((sig.confidence + 0.02) * 1000) / 1000);
}
