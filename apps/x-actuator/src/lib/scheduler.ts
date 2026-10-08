import { makeRng, type Rng } from "./rng.js";
import { isWriteCurfew, CURFEW_START_HOUR, CURFEW_END_HOUR } from "./curfew.js";
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
  // Overnight write-curfew for THIS run (Full automatic / auto-start pass true;
  // manual Run/Drain pass false). Omitted keeps the old behaviour — no plan-time
  // avoidance — so existing callers and tests are unchanged.
  curfewEnabled?: boolean;
  rng: Rng;
}

const HOUR = 3600_000;
const MINUTE = 60_000;

// ── Drain mode ──────────────────────────────────────────────────────────────
// "Post ALL approved replies back-to-back, a short gap apart, filling each gap
// with likes + ambient browsing." A distinct schedule from planTimeline's
// window-spread pacing: one comment slot per approved reply, and each gap seeded
// with like slots at random offsets. The normal tick engine executes it
// unchanged. Ported from the LinkedIn actuator (planDrainTimeline) with X's
// time-variety modification below.
export interface DrainOpts {
  approvedComments: number;
  startMs: number;
  rng: Rng;
  // NOTE: setting EITHER knob means "exactly this many, uniformly" and DISABLES
  // the per-gap pattern draw (the legacy fill). Leave both unset for patterns.
  likesPerGapMin?: number; // default 1
  likesPerGapMax?: number; // default 3
  // Share of gaps drawn from the SHORT band (20–60s) vs the normal band (60–120s).
  // Default 0.55 ⇒ mostly-fast with some 1–2 min pauses ("random rates").
  shortBandProb?: number;
  // ── Session archetype (per-session "drain temperament") ────────────────────
  // Drawn once at startDrain (pickDrainArchetype), persisted on RunState, and
  // passed to BOTH plan call sites so every auto-continue round shares the mood.
  // Absent (the direct unit-test path) ⇒ today's exact defaults, byte-identical.
  patternWeights?: number[]; // per-session weight vector over the 5 GAP_PATTERNS
  // Per-session ceiling of the NORMAL band (default 120_000). Only ever RAISED
  // above the default (longer 1–2 min gaps = slower); never lowered, and the SHORT
  // (20–60s) band is NEVER widened — so the archetype can only calm the drain down.
  normalBandMaxMs?: number;
  // When >0, ONE between-reply gap becomes a quiet ~this-long "stepped away" pause
  // (zero likes → quiet per inQuietDrainGap, so idle-likes stay out with no extra
  // wiring). Only ever ADDS time. Absent ⇒ no long breaks (byte-identical default).
  longBreakMs?: number;
}

// Time-variety draw for the inter-reply gap. Instead of LinkedIn's flat
// rng.int(60s,120s), each gap is randomly EITHER a short band (20–60s) or the
// normal band (60–normalBandMaxMs), so the drain fires at genuinely random rates —
// some quick, some spaced — rather than a mechanical 1–2 min cadence. The SHORT
// band is fixed (never widened); a per-session archetype may only RAISE the
// normal-band ceiling (default 120s), which only ever slows the drain.
export function drainGapMs(rng: Rng, shortBandProb = 0.55, normalBandMaxMs = 120_000): number {
  return rng.next() < shortBandProb
    // SHORT band. The floor was 1s, which put 4.4% of planned gaps under 10s —
    // reply-to-reply spacing no human produces, and the tightest of any of the
    // three actuators (Lyra floors at 60s, Orion at 240s). Raised to 20s: still
    // genuinely brisk and clearly distinct from the normal band, but no longer
    // planning near-instant consecutive replies. Only ever RAISED, never widened.
    ? rng.int(20_000, 60_000) // ~20–60s (SHORT band)
    : rng.int(60_000, normalBandMaxMs); // ~1–2 min (normal band; ceiling ≥120s, only raised)
}

// Every drain gap used to look identical: reply → 4-8 likes scattered → reply.
// One rigid shape repeated all session is itself a fingerprint, so each gap now
// draws a BEHAVIOR PATTERN from the plan rng:
//   full      likes scattered through the whole gap (the legacy shape)
//   cooldown  zero likes AND a genuine quiet pause — the gap is drawn from the
//             NORMAL band (60-120s) regardless of shortBandProb, so it reads as
//             "reply → step away → reply"; ambient browsing still fills it
//   light     exactly 1 like
//   frontload likes bunched right after the reply, then quiet
//   backload  quiet first, likes just before the next reply
// There is deliberately NO cluster pattern on X: rapid like bursts are exactly
// the machine-cadence velocity signal X locks on (docs/x-account-safety.md §4).
// Every pattern acts the same or LESS than the legacy full fill and stays inside
// the [1s,120s] gap envelope, so this only ever slows the account down — never
// faster, never hotter.
type GapPattern = "full" | "cooldown" | "light" | "frontload" | "backload";
const GAP_PATTERNS: GapPattern[] = ["full", "cooldown", "light", "frontload", "backload"];
// Leans quieter than LinkedIn (X is the most ban-prone surface): cooldown is
// weighted up and cluster is absent.
// 2026-07-26 quiet re-tune (port of Lyra #497). Was [0.34, 0.26, 0.18, 0.11,
// 0.11] — full-dominant, which planned ~3.5x Lyra's drain likes per gap on the
// action class docs/x-account-safety.md flags highest-risk with no published
// cap. Now cooldown-dominant: the modal gap is a genuine quiet pause with ZERO
// likes. Because a cooldown gap draws from the NORMAL band (never the short
// band), making cooldown modal also strictly SLOWS the drain — the re-tune can
// only ever quiet the account down, never speed it up.
const GAP_PATTERN_WEIGHTS = [0.14, 0.46, 0.2, 0.1, 0.1];

// ── Per-session drain temperament ────────────────────────────────────────────
// Per-gap patterns break the "every gap looks identical" fingerprint; this
// breaks the "every SESSION looks identical" one. X's per-GAP drain still shares
// ONE mixture ([0.34,0.26,0.18,0.11,0.11]) + one fixed tempo across every
// session, a session-level fingerprint on the most ban-prone surface. Each drain
// now draws a named archetype once, then jitters it, so no two sessions share the
// same pattern mix, short/normal tempo split, or break-proneness.
//
// Safe by construction (X is CLUSTER-FREE — there is no rapid-burst pattern, the
// #1 lock signal per docs/x-account-safety.md §4): every archetype is a weight
// vector over the SAME 5 patterns (all of which act ≤ the legacy full fill, so no
// vector can exceed the legacy all-"full" like volume), a shortBandProb never
// ABOVE the 0.55 default (fewer short 20–60s gaps = slower; combined with the
// operator's cfg knob by MIN at the call site so it can only lower it), a
// normalBandMaxMs never BELOW the 120s default (never faster), and a long break
// that only ADDS time. So every archetype is same-or-slower than today.
export interface DrainArchetype {
  patternWeights: number[]; // over ["full","cooldown","light","frontload","backload"]
  shortBandProb: number;    // per-session SHORT-band share, always ≤ the 0.55 default
  normalBandMaxMs: number;  // per-session normal-band ceiling, always ≥ the 120s default
  longBreakMs: number;      // 0 = this session takes no long breaks
}

interface ArchetypeSpec {
  weight: number;                      // how often this temperament is drawn
  weights: [number, number, number, number, number];
  shortBand: [number, number];         // shortBandProb drawn uniformly here (both ≤ 0.55)
  normalMax: [number, number];         // normalBandMaxMs drawn uniformly here (both ≥ 120_000)
  longBreak: [number, number] | null;  // break-duration band, or null for none
}

// Order matches GAP_PATTERNS: [full, cooldown, light, frontload, backload].
// Every band respects the X safety envelope: shortBand ≤ 0.55, normalMax ≥ 150_000
// for the calmer archetypes (never < 120_000 default anywhere), longBreak ~2–4min.
const DRAIN_ARCHETYPES: ArchetypeSpec[] = [
  // steady — balanced, close to the base per-gap weights, near-default tempo, no breaks.
  { weight: 0.30, weights: [0.16, 0.44, 0.2, 0.1, 0.1], shortBand: [0.45, 0.55], normalMax: [120_000, 140_000], longBreak: null },
  // lurker — mostly reading, sparse liking; far fewer short gaps (slower), long "stepped away" breaks.
  { weight: 0.24, weights: [0.08, 0.54, 0.24, 0.08, 0.06], shortBand: [0.15, 0.30], normalMax: [150_000, 180_000], longBreak: [150_000, 240_000] },
  // engager — actively liking; full-leaning, brisk (but never above the default short-band share).
  { weight: 0.18, weights: [0.26, 0.34, 0.16, 0.12, 0.12], shortBand: [0.45, 0.55], normalMax: [120_000, 135_000], longBreak: null },
  // skimmer — shallow pass; light + front-loaded likes, moderate tempo, no breaks.
  { weight: 0.16, weights: [0.10, 0.40, 0.28, 0.14, 0.08], shortBand: [0.30, 0.45], normalMax: [130_000, 160_000], longBreak: null },
  // bursty — full/cooldown swing; break-prone, slower normal band (NO rapid cluster on X).
  { weight: 0.12, weights: [0.16, 0.48, 0.12, 0.12, 0.12], shortBand: [0.25, 0.40], normalMax: [150_000, 175_000], longBreak: [120_000, 210_000] },
];

export function pickDrainArchetype(rng: Rng): DrainArchetype {
  const spec = DRAIN_ARCHETYPES[rng.pickWeighted(DRAIN_ARCHETYPES.map((s) => s.weight))]!;
  // Jitter the weight vector so two sessions of the same temperament still differ,
  // with a small floor so every pattern stays reachable (a zeroed weight would
  // make pickWeighted skip that pattern entirely).
  const patternWeights = spec.weights.map((w) => Math.max(0.02, w * rng.float(0.8, 1.25)));
  const shortBandProb = rng.float(spec.shortBand[0], spec.shortBand[1]);
  const normalBandMaxMs = Math.round(rng.float(spec.normalMax[0], spec.normalMax[1]));
  const longBreakMs = spec.longBreak ? Math.round(rng.float(spec.longBreak[0], spec.longBreak[1])) : 0;
  return { patternWeights, shortBandProb, normalBandMaxMs, longBreakMs };
}

export function planDrainTimeline(o: DrainOpts): PlannedAction[] {
  // 2026-07-26 quiet re-tune (port of Lyra #497): the busiest a gap gets is now
  // 1-3 likes, was 4-8. Combined with the cooldown-modal weights this is what
  // takes X off ~3.5x Lyra's planned drain like volume. Explicit knobs still
  // mean "exactly this" and disable the pattern draw (legacy uniform fill).
  const lMin = o.likesPerGapMin ?? 1;
  const lMax = o.likesPerGapMax ?? 3;
  const shortProb = o.shortBandProb ?? 0.55;
  const normalBandMax = o.normalBandMaxMs ?? 120_000;
  const weights = o.patternWeights ?? GAP_PATTERN_WEIGHTS;
  // Explicit like knobs mean "exactly this" (the legacy uniform fill) and disable
  // the per-gap pattern draw — mirrors the LinkedIn actuator.
  const patterned = o.likesPerGapMin === undefined && o.likesPerGapMax === undefined;
  // Session long break: when the archetype enables it, ONE between-reply gap
  // becomes a quiet "stepped away" pause of ~longBreakMs (zero likes → quiet per
  // inQuietDrainGap, so idle-likes stay out with no extra wiring). The choice
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
  let t = o.startMs + o.rng.int(3_000, 9_000); // first reply lands soon, not instantly
  for (let i = 0; i < o.approvedComments; i++) {
    actions.push({ kind: "comment", atMs: t });
    // A session long break: this gap is a single quiet pause with no likes. Skips
    // the per-gap pattern/like draws entirely (only reached when longBreakMs is
    // set, so the default path never takes this branch).
    if (i === breakIdx) {
      t += longBreakMs;
      continue;
