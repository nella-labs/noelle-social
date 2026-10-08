import { makeRng, type Rng } from "./rng.js";
import { isWriteCurfew } from "./curfew.js";
import type { ActionKind, PlannedAction, RunParams } from "./types.js";
import { REDDIT_DEFAULTS } from "./types.js";

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
const MINUTE = 60_000;

// ── Drain mode ──────────────────────────────────────────────────────────────
// "Post ALL approved replies a gap apart, filling each gap with ambient browsing."
// A distinct schedule from planTimeline's window-spread pacing: one comment slot
// per approved reply, spaced by drainGapMs (4 min + 0–900s on Reddit). The normal
// tick engine executes it unchanged. Ported from the LinkedIn actuator, but the
// per-gap like slots are INERT on Reddit (likesPerGap fed 0 — voting only ever
// happens via the idle-upvote path, never as a scheduled drain slot).
export interface DrainOpts {
  approvedComments: number;
  startMs: number;
  rng: Rng;
  likesPerGapMin?: number; // default 4 (INERT on Reddit — always fed 0, no voting via slots)
  likesPerGapMax?: number; // default 8 (INERT on Reddit — always fed 0)
  // INERT: the inter-reply gap is drawn by drainGapMs as a quick/normal/cooldown
  // timing archetype inside [base, base+rand]; there is no short/normal band to
  // bias. Retained only so existing callers that still pass it keep type-checking.
  shortBandProb?: number;
  // ── Session archetype (per-session "drain temperament") — TIMING-ONLY ───────
  // Drawn once at startDrain (pickDrainArchetype), persisted on RunState, and
  // passed to BOTH plan call sites so every extension round shares the mood.
  // Absent (the direct unit-test path) ⇒ today's exact defaults, byte-identical.
  // Reddit's drain is REPLY-ONLY, so the archetype carries ONLY timing knobs — the
  // per-band gap mix + one optional long break — never a like/upvote knob (there
  // are no like slots to shape).
  bandWeights?: number[]; // per-session weight vector over [quick, normal, cooldown]
  longBreakMs?: number;   // when >0, one inter-reply gap becomes a quiet ~this-long "stepped away" pause
}

// Inter-reply gap for the Reddit drain. Reddit posts no like slots, so the only
// per-gap variety a reply-only drain can carry is the gap TIMING itself. This
// used to be a flat uniform [base, base+rand] — but a perfectly uniform band has
// hard, readable edges (an analyst reads the exact 4-min and 19-min bounds and
// the even density straight off a session). So each gap now draws a TIMING
// ARCHETYPE instead:
//   quick     near the floor — an occasional quick reply-after-reply (~4-7.6 min)
//   normal    the middle band, the mode (~7.6-13.3 min)
//   cooldown  a long "stepped away" pause between replies (~13.3-19 min)
// The weights are deliberately UPPER-TAIL-HEAVY (cooldown > quick): this breaks
// the flat-uniform fingerprint while keeping the MEAN gap equal-or-SLOWER than
// the old uniform (~11.9 min vs 11.5 min) — reply velocity never rises. That
// direction is mandatory because drain bypasses BOTH the runtime replySpacingOk
// floor and maxWritesPerHour, so the planned gap is the SOLE spacing backstop; a
// quick-heavy mixture (mass shifted toward the floor) would be a real velocity
// regression even though no single gap dips below 240s. Every band stays strictly
// inside [base, base+rand], so the 240s floor and the 19-min ceiling are
// untouched. Same base+rand envelope as the scheduled-mode min-spacing floor
// (REDDIT_DEFAULTS.minReplySpacingMs === replyBaseGapMs), so drain and scheduled
// pacing still agree.
// The default per-band mixture — quick 0.20 / normal 0.38 / cooldown 0.42.
// Upper-tail-heavy so the mean is equal-or-slower than the legacy flat uniform
// (mean 690_000ms), never faster. A per-session archetype (pickDrainArchetype)
// may pass its OWN vector, but only ever an equal-or-slower one (see the mean
// invariant on DRAIN_ARCHETYPES). Absent ⇒ this exact default, so the direct
// (no-archetype) drain path stays byte-identical.
const DEFAULT_DRAIN_BANDS = [0.2, 0.38, 0.42]; // quick / normal / cooldown

export function drainGapMs(rng: Rng, bandWeights: number[] = DEFAULT_DRAIN_BANDS): number {
  const base = REDDIT_DEFAULTS.replyBaseGapMs; // 240_000 — hard floor
  const rand = REDDIT_DEFAULTS.replyRandGapMs; // 900_000 — top of the tail
  const band = rng.pickWeighted(bandWeights); // quick / normal / cooldown
  if (band === 0) return base + rng.int(0, Math.round(rand * 0.24));
  if (band === 1) return base + rng.int(Math.round(rand * 0.24), Math.round(rand * 0.62));
  return base + rng.int(Math.round(rand * 0.62), rand);
}

// ── Per-session drain temperament (TIMING-ONLY) ──────────────────────────────
// Per-gap band draws break the "every gap looks identical" fingerprint; this
// breaks the "every SESSION looks identical" one. Each drain draws a named
// archetype once, then jitters it, so no two sessions share the same band mix or
// break-proneness. Reddit's drain is REPLY-ONLY (no like slots), so — unlike the
// LinkedIn archetype — this carries ONLY timing: a weight vector over the SAME
// three drainGapMs bands [quick, normal, cooldown], plus one optional long break.
// Safe by construction: every archetype's band mixture keeps a mean gap ≥ the
// current default (~11.9 min) — the jitter is MEAN-MONOTONE (it only ever moves
// weight from a faster band toward a slower one), the bands themselves are
// unchanged so every gap stays inside [240s, 1140s], and the long break only ADDS
// time (a top-of-envelope "stepped away" pause). So every archetype is
// same-or-slower than today — reply velocity can never rise, which is mandatory
// because drain bypasses BOTH replySpacingOk and maxWritesPerHour (the planned
// gap is the sole spacing backstop).
export interface DrainArchetype {
  bandWeights: number[]; // over [quick, normal, cooldown]; mean gap ≥ the default mix
  longBreakMs: number;   // 0 = this session takes no long break
}

interface ArchetypeSpec {
  weight: number;                      // how often this temperament is drawn
  bands: [number, number, number];     // base [quick, normal, cooldown] weights (mean ≥ default)
  longBreak: [number, number] | null;  // break-duration band (top of the envelope), or null for none
}

// Every spec's base mixture has a mean gap ≥ the default mix's (~714_840ms /
// ~11.9 min): mass is only ever shifted from the quick band toward normal/cooldown
// relative to the default, never the reverse. Break bands sit at the TOP of the
// [240s, 1140s] envelope, so a break is always longer than the archetype's own
// mean gap — it can only raise the session mean, never lower it.
const DRAIN_ARCHETYPES: ArchetypeSpec[] = [
  // steady — the default mix, normal tempo, no breaks (the "equal" baseline).
  { weight: 0.30, bands: [0.20, 0.38, 0.42], longBreak: null },
  // measured — a touch more cooldown; slightly slower, no breaks.
  { weight: 0.22, bands: [0.16, 0.40, 0.44], longBreak: null },
  // deliberate — cooldown-leaning, slower, no breaks.
  { weight: 0.18, bands: [0.14, 0.36, 0.50], longBreak: null },
  // lurker — mostly long "stepped away" gaps; slowest, and takes a long break.
  { weight: 0.16, bands: [0.10, 0.30, 0.60], longBreak: [960_000, 1_140_000] },
  // bursty-then-quiet — cooldown-heavy with a mid-session long break.
  { weight: 0.14, bands: [0.12, 0.34, 0.54], longBreak: [900_000, 1_080_000] },
];

export function pickDrainArchetype(rng: Rng): DrainArchetype {
  const spec = DRAIN_ARCHETYPES[rng.pickWeighted(DRAIN_ARCHETYPES.map((s) => s.weight))]!;
  // Mean-monotone jitter: only ever shift weight from a FASTER band toward a
  // slower one, so a jittered session's mean gap can never drop below the spec's
  // (already ≥-default) base mean. quick sheds up to 40% of its mass into normal;
  // normal sheds up to 30% into cooldown. The bands are unchanged (envelope
  // intact) and each keeps a positive floor, so every band stays reachable.
  let [q, n, c] = spec.bands;
  const qToSlow = rng.float(0, q * 0.4);
  const nToSlow = rng.float(0, n * 0.3);
  q -= qToSlow;
  n += qToSlow - nToSlow;
  c += nToSlow;
  const longBreakMs = spec.longBreak ? Math.round(rng.float(spec.longBreak[0], spec.longBreak[1])) : 0;
  return { bandWeights: [q, n, c], longBreakMs };
}

export function planDrainTimeline(o: DrainOpts): PlannedAction[] {
  const lMin = o.likesPerGapMin ?? 4;
  const lMax = o.likesPerGapMax ?? 8;
  const bandWeights = o.bandWeights ?? DEFAULT_DRAIN_BANDS;
  // Session long break: when the archetype enables it, ONE inter-reply gap becomes
  // a quiet "stepped away" pause of ~longBreakMs (no like slots inside it → quiet
  // per inQuietDrainGap, so idle-upvotes stay out with no extra wiring). The choice
  // rides a SEPARATE plan-derived rng so the main gap stream is untouched, and it is
  // only consulted when longBreakMs is present — so the default (no-opts) path is
  // byte-identical. longBreakMs sits at the top of the [240s, 1140s] envelope, so
  // the break is inside the same spacing bounds and only ever ADDS time.
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
    // the per-gap band/like draws entirely (only reached when longBreakMs is set,
    // so the default path never takes this branch).
    if (i === breakIdx) {
      t += longBreakMs;
      continue;
    }
    const gap = drainGapMs(o.rng, bandWeights);
    // Likes scale to the gap: a very short gap has no room for a like sweep, a
    // roomy 1–2 min gap carries the usual 4–8. Offsets stay inside the gap so a
    // like never lands after the next reply. (On Reddit lMin/lMax are fed 0, so
    // this loop runs zero times — voting is idle-only, never a drain slot.)
    if (gap >= 15_000) {
      const nLikes = o.rng.int(lMin, lMax);
      const lo = Math.min(8_000, Math.floor(gap * 0.15));
      const hi = Math.max(lo + 1_000, gap - 3_000);
      for (let k = 0; k < nLikes; k++) {
        actions.push({ kind: "like", atMs: t + o.rng.int(lo, hi) });
      }
    }
    t += gap;
  }
  return actions;
}

// The inter-reply gap width above which the drawn gap is a COOLDOWN band — the
// "stepped away between replies" pause the timing archetype deliberately left
// long. = replyBaseGapMs + 0.62·replyRandGapMs, the exact floor drainGapMs uses
