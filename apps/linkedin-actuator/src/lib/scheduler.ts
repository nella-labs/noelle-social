import { makeRng, type Rng } from "./rng.js";
import { isWriteCurfew } from "./curfew.js";
import type { ActionKind, PlannedAction, RunParams } from "./types.js";

export interface Caps { likes: number; comments: number; dms: number; }
export interface ClampNote { kind: ActionKind; requested: number; allowed: number; }

interface PlanOpts {
  params: RunParams;
  approvedDms: number;
  caps: Caps;
  startMs: number;
  deepNightTaper: boolean;
  // Hard ceiling on write actions (comment + dm) per rolling hour. Omitted or 0
  // disables the pass (keeps existing callers/tests unchanged).
  maxWritesPerHour?: number;
  rng: Rng;
}

const HOUR = 3600_000;

// ── Drain mode ──────────────────────────────────────────────────────────────
// "Post ALL approved replies back-to-back, a short gap apart, each gap mostly
// QUIET (ambient browsing) with at most a few likes." A distinct schedule from
// planTimeline's window-spread pacing: one comment slot per approved draft,
// gapMin..gapMax apart, each gap shaped by a randomly drawn behavior pattern
// (see GAP_PATTERNS). The normal tick engine executes it unchanged.
export interface DrainOpts {
  approvedComments: number;
  startMs: number;
  rng: Rng;
  gapMinMs?: number; // gap before the next reply — default 60_000 (1 min) floor
  gapMaxMs?: number; // top of the gap BODY band — default 150_000 (2.5 min)
  // Explicit like knobs mean "exactly this": setting either one keeps the
  // legacy uniform fill (likes scattered through every gap) and disables the
  // gap-pattern draw. Leave both unset (the production path) for patterns.
  likesPerGapMin?: number; // default 1 (2026-07-23 quiet re-tune; was 4 under the old "≥3 + 1-5" ask)
  likesPerGapMax?: number; // default 3 — the operator now wants gaps mostly idle, never a ~10-like burst before a reply
  // ── Session archetype (per-session "drain temperament") ────────────────────
  // Drawn once at startDrain (pickDrainArchetype), persisted on RunState, and
  // passed to BOTH plan call sites so every extension round shares the mood.
  // Absent (the direct unit-test path) ⇒ today's exact defaults, byte-identical.
  patternWeights?: number[]; // per-session weight vector over the 6 GAP_PATTERNS
  longBreakMs?: number;      // when >0, one between-reply gap becomes a quiet ~this-long "stepped away" pause
}

// Every gap used to look identical: reply → 4-9 likes evenly scattered →
// reply. One rigid shape repeated all session is itself a fingerprint, so each
// gap draws a BEHAVIOR PATTERN from the plan rng. 2026-07-23 quiet re-tune:
// the operator wants the wait before a reply to look IDLE, not busy — a
// like-free gap is now the modal draw and no pattern places more than 3 likes
// (was 4-9 on "full"):
//   full      1-3 likes scattered through the gap (the busiest a gap gets)
//   cooldown  zero likes — a quiet flat pause, 60s up to ×1.2 of the session's
//             gapMax (1-3 min at the default tempo, longer for slow archetypes);
//             the ambient browse still scrolls, so the session looks alive
//             without acting
//   light     exactly 1 like somewhere in the gap
//   frontload 1-2 likes right after the reply, then quiet
//   backload  quiet first, 1-2 likes just before the next reply
//   cluster   a tight ≤30s pair (1-2 likes) somewhere in the gap
// Every pattern acts the same or LESS than the pre-2026-07-23 fill and every
// gap keeps the gapMin floor, so the re-tune only ever slows the account down.
type GapPattern = "full" | "cooldown" | "light" | "frontload" | "backload" | "cluster";
const GAP_PATTERNS: GapPattern[] = ["full", "cooldown", "light", "frontload", "backload", "cluster"];
const GAP_PATTERN_WEIGHTS = [0.14, 0.46, 0.2, 0.07, 0.07, 0.06];

// ── Per-session drain temperament ────────────────────────────────────────────
// Per-gap patterns break the "every gap looks identical" fingerprint; this
// breaks the "every SESSION looks identical" one. Each drain draws a named
// archetype once, then jitters it, so no two sessions share the same pattern
// mix, gap tempo, or break-proneness. Safe by construction: every archetype is a
// weight vector over the SAME 6 patterns (all of which place ≤3 likes, so no
// vector can exceed an all-"full" 1-3/gap volume), a gapMax that is never below
// the 150s default (never faster), and a long break that only ADDS time — so
// every archetype is same-or-slower than the base mix. All five vectors lean
// cooldown since the 2026-07-23 quiet re-tune; they differ in HOW quiet.
export interface DrainArchetype {
  patternWeights: number[]; // over ["full","cooldown","light","frontload","backload","cluster"]
  gapMaxMs: number;         // per-session gap tempo, always ≥ the 150s default
  longBreakMs: number;      // 0 = this session takes no long breaks
}

interface ArchetypeSpec {
  weight: number;                      // how often this temperament is drawn
  weights: [number, number, number, number, number, number];
  gapMax: [number, number];            // gapMaxMs drawn uniformly in this band (both ≥ 150_000)
  longBreak: [number, number] | null;  // break-duration band, or null for none
}

// Order matches GAP_PATTERNS: [full, cooldown, light, frontload, backload, cluster].
const DRAIN_ARCHETYPES: ArchetypeSpec[] = [
  // steady — balanced, matches the base per-gap weights, normal tempo, no breaks.
  { weight: 0.30, weights: [0.14, 0.46, 0.20, 0.07, 0.07, 0.06], gapMax: [150_000, 180_000], longBreak: null },
  // lurker — almost all reading, the odd single like; slower, takes long "stepped away" breaks.
  { weight: 0.22, weights: [0.05, 0.62, 0.20, 0.05, 0.04, 0.04], gapMax: [200_000, 255_000], longBreak: [420_000, 720_000] },
  // engager — the likiest temperament (still ≤3/gap, ~1/gap mean), brisk (but never below the floor).
  { weight: 0.20, weights: [0.24, 0.32, 0.22, 0.08, 0.07, 0.07], gapMax: [150_000, 175_000], longBreak: null },
  // skimmer — shallow pass; single + front-loaded likes between quiet gaps, no breaks.
  { weight: 0.16, weights: [0.10, 0.44, 0.24, 0.13, 0.05, 0.04], gapMax: [160_000, 200_000], longBreak: null },
  // bursty — a tight like-pair now and then, otherwise quiet; break-prone.
  { weight: 0.12, weights: [0.07, 0.50, 0.10, 0.05, 0.05, 0.23], gapMax: [180_000, 230_000], longBreak: [300_000, 600_000] },
];

export function pickDrainArchetype(rng: Rng): DrainArchetype {
  const spec = DRAIN_ARCHETYPES[rng.pickWeighted(DRAIN_ARCHETYPES.map((s) => s.weight))]!;
  // Jitter the weight vector so two sessions of the same temperament still
  // differ, with a small floor so every pattern stays reachable (a zeroed
  // weight would make pickWeighted skip that pattern entirely).
  const patternWeights = spec.weights.map((w) => Math.max(0.02, w * rng.float(0.8, 1.25)));
  const gapMaxMs = Math.round(rng.float(spec.gapMax[0], spec.gapMax[1]));
  const longBreakMs = spec.longBreak ? Math.round(rng.float(spec.longBreak[0], spec.longBreak[1])) : 0;
  return { patternWeights, gapMaxMs, longBreakMs };
}

export function planDrainTimeline(o: DrainOpts): PlannedAction[] {
  const gapMin = o.gapMinMs ?? 60_000;
  const gapMax = o.gapMaxMs ?? 150_000;
  const patterned = o.likesPerGapMin === undefined && o.likesPerGapMax === undefined;
  const weights = o.patternWeights ?? GAP_PATTERN_WEIGHTS;
  const lMin = o.likesPerGapMin ?? 1;
  const lMax = o.likesPerGapMax ?? 3;
  // Session long break: when the archetype enables it, ONE between-reply gap
  // becomes a quiet "stepped away" pause of ~longBreakMs (zero likes — and drain
  // mode never idle-likes at all, so the pause plays out untouched). The choice
  // rides a SEPARATE plan-derived rng so the main stream is untouched, and it is
  // only consulted when longBreakMs is present — so the default (no-opts) path is
  // byte-identical. Only ever ADDS time (never faster).
  const longBreakMs = o.longBreakMs ?? 0;
  let breakIdx = -1;
  if (longBreakMs > 0 && o.approvedComments >= 3) {
    const breakRng = makeRng((Math.trunc(o.startMs / 1000) ^ Math.imul(o.approvedComments, 0x9e3779b1)) >>> 0);
    // ~55% of eligible batches actually take a break, at a random reply boundary
    // (never the final slot — it has no following gap).
    if (breakRng.next() < 0.55) breakIdx = breakRng.int(0, o.approvedComments - 2);
  }
  const actions: PlannedAction[] = [];
  let t = o.startMs + o.rng.int(4_000, 14_000); // first reply lands soon, not instantly (widened session jitter)
  for (let i = 0; i < o.approvedComments; i++) {
    actions.push({ kind: "comment", atMs: t });
    // A session long break: this gap is a single quiet pause with no likes. Skips
    // the per-gap pattern/like draws entirely (only reached when longBreakMs is
    // set, so the default path never takes this branch).
    if (i === breakIdx) {
      t += longBreakMs;
      continue;
    }
    const pattern: GapPattern = patterned
      ? GAP_PATTERNS[o.rng.pickWeighted(weights)]!
      : "full";
    // Between-reply gap: a log-normal body (soft-edged, occasional longer)
    // instead of a flat uniform band, plus a ~1-in-4 longer "stepped away"
    // pause (heavy right tail). Widens the session-to-session spread ~2x so
    // repeated drains don't share one tight 60-120s uniform signature, while
    // never dropping below the gapMin floor and only slowing the drain slightly
    // (safer, never faster). A fixed-gap knob (gapMin===gapMax) stays exact.
    // A cooldown gap replaces the log-normal draw with a flat quiet pause
    // capped at 1.2× the session gapMax (~3 min at the default tempo, ~5 min
    // for a slow lurker) — the "reply → cooldown → reply" shape.
    let gap: number;
    if (gapMax <= gapMin) {
      gap = gapMin;
    } else if (pattern === "cooldown") {
      // The quiet-pause band scales with the session tempo: cap at gapMax × 1.2
      // (at the default 150s band that is exactly the old flat 180s cap, so the
      // stock draw is unchanged). A FIXED 180s ceiling made cooldown faster than
      // a slow archetype's log-normal+pause gaps once cooldown became the modal
      // draw (2026-07-23 re-tune) — speeding lurker/bursty up a few % on mean
      // and collapsing every temperament's quiet gap onto one uniform[60s,180s]
      // (the #471 "floor+ceiling intact ≠ same velocity" trap). Scaling the cap
      // keeps every archetype same-or-slower and lets slow sessions pause long.
      // The 180s term keeps the ceiling at least the old flat cap for ANY
      // caller (production gapMax is always ≥150s, but this makes never-faster
      // unconditional rather than convention-enforced — longer is always safe).
      gap = Math.round(o.rng.float(gapMin, Math.max(gapMin + 1_000, 180_000, gapMax * 1.2)));
    } else {
      const mid = Math.sqrt(gapMin * gapMax); // geometric centre of the band
      gap = Math.max(gapMin, Math.min(gapMax * 1.5, o.rng.logNormal(Math.log(mid), 0.32)));
      if (o.rng.next() < 0.25) gap += o.rng.int(0, gapMax - gapMin);
      gap = Math.round(gap);
    }
    let nLikes: number;
    switch (pattern) {
      case "cooldown": nLikes = 0; break;
      case "light": nLikes = 1; break;
      case "frontload":
      case "backload":
      case "cluster": nLikes = o.rng.int(1, 2); break;
      default: nLikes = o.rng.int(lMin, lMax);
    }
    // Placement band inside the gap: leave room right after the reply (we
    // navigate back to the feed) and just before the next reply.
    const bandLo = 10_000;
    const bandHi = Math.max(bandLo + 1_000, gap - 5_000);
    if (pattern === "cluster") {
      const anchor = o.rng.int(bandLo, Math.max(bandLo + 1_000, bandHi - 30_000));
      for (let k = 0; k < nLikes; k++) {
        actions.push({ kind: "like", atMs: t + Math.min(bandHi, anchor + o.rng.int(0, 30_000)) });
      }
    } else {
