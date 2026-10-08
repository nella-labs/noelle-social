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
    }
    const pattern: GapPattern = patterned
      ? GAP_PATTERNS[o.rng.pickWeighted(weights)]!
      : "full";
    // A cooldown gap is a deliberate quiet pause: draw from the NORMAL band so it
    // is a real 1-2 min break (never the 20-60s short band), still inside the
    // [1s, normalBandMax] envelope. Every other pattern keeps the two-band draw.
    const gap = pattern === "cooldown"
      ? o.rng.int(60_000, normalBandMax)
      : drainGapMs(o.rng, shortProb, normalBandMax);
    // Likes scale to the gap: a very short gap (<15s) has no room for a like
    // sweep, a roomy 1-2 min gap carries the pattern's share. Offsets stay inside
    // the gap so a like never lands after the next reply.
    let nLikes: number;
    switch (pattern) {
      case "cooldown": nLikes = 0; break;
      case "light": nLikes = 1; break;
      case "frontload":
      case "backload": nLikes = o.rng.int(1, 2); break;
      default: nLikes = o.rng.int(lMin, lMax);
    }
    if (gap >= 15_000 && nLikes > 0) {
      const lo = Math.min(8_000, Math.floor(gap * 0.15));
      const hi = Math.max(lo + 1_000, gap - 3_000);
      let plo = lo;
      let phi = hi;
      if (pattern === "frontload") phi = Math.max(lo + 1_000, Math.min(hi, Math.floor(gap * 0.4)));
      if (pattern === "backload") plo = Math.min(Math.max(lo, Math.floor(gap * 0.6)), hi - 1_000);
      for (let k = 0; k < nLikes; k++) {
        actions.push({ kind: "like", atMs: t + o.rng.int(plo, phi) });
      }
    }
    t += gap;
  }
  return actions;
}

// Whether `nowMs` sits inside a drain gap the plan deliberately left QUIET —
// between two comment slots with no like slot scheduled between them (the
// cooldown pattern). Idle-liking consults this so the waiting-likes engine can't
// refill a pause the plan chose to leave empty. Slot times are PLAN times, so
// the answer is stable across the whole gap. Ported from the LinkedIn actuator.
export function inQuietDrainGap(
  actions: readonly { kind: ActionKind; atMs: number }[],
  nowMs: number,
): boolean {
  let prevComment = -Infinity;
  let nextComment = Infinity;
  for (const a of actions) {
    if (a.kind !== "comment") continue;
    if (a.atMs <= nowMs && a.atMs > prevComment) prevComment = a.atMs;
    if (a.atMs > nowMs && a.atMs < nextComment) nextComment = a.atMs;
  }
  for (const a of actions) {
    if (a.kind === "like" && a.atMs > prevComment && a.atMs < nextComment) return false;
  }
  return true;
}

// Curfew check lives in ./curfew.ts (isWriteCurfew) — the single switch every
// enforcement point shares. It is DISABLED BY DEFAULT (manual runs write at any
// hour) and enabled per-run for the unattended paths, which pass curfewEnabled.

// Density weight for an absolute time.
// Reduces action probability for deep-night hours.
// Strengthened: 01:00–06:00 band is now 0.05 (was 0.25).
function densityWeight(atMs: number, taper: boolean): number {
  if (!taper) return 1;
  const h = new Date(atMs).getHours();
  return h >= 1 && h < 6 ? 0.05 : 1;
}

// ---------------------------------------------------------------------------
// Hard-shift a curfew-landing action to the nearest allowed hour boundary.
// Returns null if the entire window is in curfew (caller drops it).
// ---------------------------------------------------------------------------
function shiftOutOfCurfew(
  atMs: number,
  startMs: number,
  endMs: number,
  curfewEnabled: boolean,
): number | null {
  // The flag is REQUIRED, not defaulted. It used to call isWriteCurfew(atMs)
  // with no second argument, which falls back to the global
  // WRITE_CURFEW_ENABLED = false — so plan-time curfew avoidance never ran on
  // any run, including the unattended ones that explicitly asked for it.
  if (!isWriteCurfew(atMs, curfewEnabled)) return atMs;

  // The shift targets are DERIVED from the curfew constants, never hardcoded.
  //
  // They used to be literal 06:00 and 22:59, left from the retired 23:00->06:00
  // band. Against the live 01:00-09:00 band that is catastrophic rather than
  // merely stale: 06:00 is INSIDE the band, so a shifted action is still
  // curfewed, and because planTimeline sets `cursor = atMs` after each shift,
  // the next action starts from 06:00 + gap, is curfewed again, and shifts back
  // to 06:00. Every remaining in-band action collapses onto the same
  // millisecond. Measured on a 00:30 start over a 12h window: 12 of 21 actions
  // landed at exactly 06:00:00.000, all still inside the curfew.
  //
  // Forward target is the END of the band (the first allowed instant), which is
  // outside it by construction, so `+ gap` cannot re-enter and the collapse is
  // impossible. Backward target is one minute before the START.
  const d = new Date(atMs);
  const h = d.getHours();
  const wraps = CURFEW_START_HOUR > CURFEW_END_HOUR;

  // Forward: the next CURFEW_END_HOUR at or after `atMs`. For a wrapping band
  // (e.g. 23->6) an hour before the end is on the FOLLOWING local day.
  const fwd = new Date(d);
  fwd.setHours(CURFEW_END_HOUR, 0, 0, 0);
  if (fwd.getTime() <= atMs) fwd.setDate(fwd.getDate() + 1);
  const candidate = fwd.getTime();
  if (candidate >= startMs && candidate <= endMs) return candidate;

  // Backward: one minute before CURFEW_START_HOUR. For a wrapping band an hour
  // after the start belongs to the same day; otherwise step back a day.
  const back = new Date(atMs);
  back.setHours(CURFEW_START_HOUR, 0, 0, 0);
  back.setTime(back.getTime() - 60_000);
  if (back.getTime() >= atMs || (!wraps && back.getTime() > atMs)) {
    back.setDate(back.getDate() - 1);
  }
  const backMs = back.getTime();
  if (backMs >= startMs && backMs <= endMs) return backMs;

  return null; // whole window is in curfew — drop
}

export function planTimeline(opts: PlanOpts): { actions: PlannedAction[]; clamps: ClampNote[] } {
  const { params, approvedDms, caps, startMs, deepNightTaper, rng } = opts;
  const maxWritesPerHour = opts.maxWritesPerHour ?? 0;
  const windowMs = params.windowHours * HOUR;
  const endMs = startMs + windowMs;

  const clamps: ClampNote[] = [];
  const clamp = (kind: ActionKind, requested: number, cap: number): number => {
    if (requested > cap) { clamps.push({ kind, requested, allowed: cap }); return cap; }
    return requested;
  };

  // ── 1. ±20% per-plan volume factor ────────────────────────────────────────
  // Draw once per plan; scale requested counts before clamping to caps. Floor
  // widened DOWN to 0.72 (fewer on average = safer) with the 1.2 cap unchanged.
  const volumeFactor = rng.float(0.72, 1.2);

  const rawComments = Math.round(params.targetComments * volumeFactor);
  const rawLikes    = Math.round(params.targetLikes    * volumeFactor);
  const rawDms      = Math.round(approvedDms           * volumeFactor);

  const nComments = clamp("comment", rawComments, caps.comments);
  const nLikes    = clamp("like",    rawLikes,    caps.likes);
  const nDms      = clamp("dm",      rawDms,      caps.dms);

  // ── 2. Build kind-list ─────────────────────────────────────────────────────
  const kinds: ActionKind[] = [];
  for (let i = 0; i < nComments; i++) kinds.push("comment");
  for (let i = 0; i < nLikes; i++) kinds.push("like");
  // Fisher–Yates shuffle with seeded RNG so likes/comments interleave.
  for (let i = kinds.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [kinds[i], kinds[j]] = [kinds[j]!, kinds[i]!];
  }
  // DMs spaced widest: insert at evenly-distributed indices.
  for (let d = 0; d < nDms; d++) {
    const idx = Math.floor(((d + 1) / (nDms + 1)) * kinds.length);
    kinds.splice(idx, 0, "dm");
  }

  const total = kinds.length;
  if (total === 0) return { actions: [], clamps };

  // ── 3. Per-burst Gamma intensity ───────────────────────────────────────────
  // Burst count: ~1 burst per 45–90 min.
  const burstCount = Math.max(1, Math.round(params.windowHours / rng.float(0.6, 2.2)));

  // Draw a Gamma weight per burst so intensity varies across bursts. The lower
  // shape (k=1.5, was 2) widens the between-burst intensity spread.
  const burstWeights: number[] = [];
  for (let b = 0; b < burstCount; b++) {
    burstWeights.push(rng.gamma(1.5, 1));
  }
  const totalWeight = burstWeights.reduce((s, w) => s + w, 0);

  // Distribute total action count across bursts proportionally to gamma weights.
  const burstSizes: number[] = burstWeights.map((w) =>
    Math.round((w / totalWeight) * total),
  );
  // Correct rounding drift — assign remainder to heaviest burst.
  const sizeSum = burstSizes.reduce((s, v) => s + v, 0);
  const drift = total - sizeSum;
  if (drift !== 0 && burstSizes.length > 0) {
    const heaviest = burstWeights.indexOf(Math.max(...burstWeights));
    burstSizes[heaviest] = (burstSizes[heaviest] ?? 0) + drift;
  }

  // Burst start times: evenly distributed across window with random jitter.
  // A LONE burst (short windows, burstCount===1) anchors at the window OPEN, not
  // its midpoint — otherwise the first half of a short window is dead and the
  // first real action lands ~50% of the way in (the "nothing happens for 15 min"
  // bug). Multi-burst windows keep the centered spacing unchanged.
