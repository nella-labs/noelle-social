// Pinned style source — the PURE, portable half of the "write in this exact
// person's style" lever. Shared by api-vm (resolve a name typed in the drafter
// chat) and the intern workers. No DB, no LLM, no framework imports, so it's
// trivially unit-testable and importable anywhere.
//
//   - extractStyleDirective(text)      — pull a person's name out of a chat line
//                                        ("Follow Kaia Tham style, use her posts").
//   - resolveStyleSourceHandle(name, sources) — map a name (or a picker value) to a
//                                        source account's CANONICAL handle.
//
// The stored pin (account_feeder_config.pinnedStyleHandle) is read + shaped by the
// selection-side helpers (readPinnedHandle / pinnedSelectConfig) at the bottom of
// this file — they depend only on the config schema (not on any DB/loader), so both
// interns (Lyra + Vega) share one pin implementation.

import { AccountFeederConfigSchema } from "@noelle/contracts";
import { makeSeededRng } from "./styleSelect.js";

/** The minimal source shape the resolver matches against (handle + display name). */
export interface StyleSourceRef {
  handle: string;
  displayName?: string | null;
}

/**
 * Normalise a handle / display name / typed name to a comparable form: lowercase,
 * drop a trailing LinkedIn-style hex id suffix (`-7bb065343`), collapse any run of
 * non-alphanumerics to a single space, trim. So "Kaia Tham",
 * "kaia-tham-7bb065343", and "kaia   tham" all normalise to "kaia tham".
 */
export function normalizeStyleName(s: string): string {
  return (s ?? "")
    .toLowerCase()
    .replace(/-[0-9a-f]{6,}$/i, "") // LinkedIn vanity-slug hex suffix
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function styleTokens(s: string): string[] {
  return normalizeStyleName(s).split(" ").filter(Boolean);
}

/**
 * Resolve a free-text name (from the chat or a picker) to a source account's
 * CANONICAL handle. Matches against both the handle and the display name of every
 * source, progressively looser but always requiring a real signal so the wrong
 * person is never pinned:
 *   1. exact normalised match (handle or display) — the picker path.
 *   2. one side's tokens are a subset of the other's ("kaia" → "kaia tham").
 *   3. otherwise the best Jaccard token-overlap ≥ 0.5.
 * Returns the source's stored `handle` (what the corpus is keyed by), or null.
 */
export function resolveStyleSourceHandle(
  name: string,
  sources: StyleSourceRef[],
): string | null {
  const q = normalizeStyleName(name);
  if (!q || sources.length === 0) return null;
  const qTokens = new Set(styleTokens(name));
  if (qTokens.size === 0) return null;

  const labelsFor = (s: StyleSourceRef): string[] =>
    [s.handle, s.displayName ?? ""].filter(Boolean);

  // 1. Exact normalised match.
  for (const s of sources) {
    for (const label of labelsFor(s)) {
      if (normalizeStyleName(label) === q) return s.handle;
    }
  }

  // 2 + 3. Subset or best token-overlap.
  let best: { handle: string; score: number } | null = null;
  for (const s of sources) {
    for (const label of labelsFor(s)) {
      const lTokens = new Set(styleTokens(label));
      if (lTokens.size === 0) continue;
      const inter = [...qTokens].filter((t) => lTokens.has(t)).length;
      if (inter === 0) continue;
      const subset = inter === qTokens.size || inter === lTokens.size;
      const union = new Set([...qTokens, ...lTokens]).size;
      const jaccard = inter / union;
      const score = subset ? 1 + jaccard : jaccard; // subset always beats partial
      if (!best || score > best.score) best = { handle: s.handle, score };
    }
  }
  return best && best.score >= 0.5 ? best.handle : null;
}

// Verbs/prepositions that introduce a style directive, then the style noun that
// closes it. Captures the name between: "follow Kaia Tham's style", "write like
// Kaia", "use Kaia Tham's posts", "in the style of Kaia Tham".
const DIRECTIVE_RE = new RegExp(
  "(?:follow|use|write\\s+(?:in|like)|copy|channel|emulate|mimic|match|in\\s+the\\s+(?:style|voice)\\s+of)" +
    "\\s+([a-z0-9][a-z0-9 .'’\\-]{0,60}?)" +
    "(?:['’]s)?\\s*(?:style|voice|posts?|tone|writing|hooks?|words?)\\b",
  "i",
);
// Bare "<Name>'s style" with no leading verb ("Kaia's style, keep it dry").
const POSSESSIVE_RE =
  /\b([a-z0-9][a-z0-9 .'’\-]{0,60}?)['’]s\s+(?:style|voice|posts?|tone|writing|hooks?)\b/i;

// A STRONG style verb ("write like X", "in the style of X", "channel X") whose
// object is unambiguously a person even without a trailing style-noun. Captures up
// to 4 name-like tokens; trailing filler ("please") is trimmed by cleanName.
const STRONG_VERB_RE =
  /(?:write\s+(?:in|like)|in\s+the\s+(?:style|voice)\s+of|channel|emulate|mimic)\s+([a-z][a-z0-9.'’\-]*(?:\s+[a-z][a-z0-9.'’\-]*){0,3})/i;

const DIRECTIVE_STOPWORDS = /^(?:the|her|his|their|my|your|our|this|that|it|its|a|an|same)$/i;
// Words that may trail a captured name and are not part of it ("... please").
const TRAILING_FILLER =
  /^(?:please|pls|plz|thanks|thanx|thx|thank|now|today|too|instead|here|for|to|and|but|so|the|a|an|it|this|that|ok|okay|yeah)$/i;

/** Trim a raw capture to a clean person-name (drop leading articles / trailing filler / possessive). */
function cleanName(raw: string): string | null {
  let name = raw.trim().replace(/^["'“”]|["'“”]$/g, "").replace(/['’]s$/i, "").trim();
  const tokens = name.split(/\s+/).filter(Boolean);
  while (tokens.length && /^(?:the|a|an)$/i.test(tokens[0]!)) tokens.shift();
  while (tokens.length && TRAILING_FILLER.test(tokens[tokens.length - 1]!)) tokens.pop();
  name = tokens.join(" ");
  if (!name || (tokens.length === 1 && DIRECTIVE_STOPWORDS.test(name))) return null;
  return name.length >= 2 ? name : null;
}

/**
 * Pull a candidate person-name out of a drafter-chat line asking to adopt a
 * style. Returns the trimmed name ("Kaia Tham") or null when it isn't a style
 * directive. Heuristic + fail-open: a null just means "treat as a normal note".
 */
export function extractStyleDirective(text: string): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  // Noun-anchored patterns first (most precise), then the strong-verb fallback.
  const m = DIRECTIVE_RE.exec(t) ?? POSSESSIVE_RE.exec(t) ?? STRONG_VERB_RE.exec(t);
  if (!m || !m[1]) return null;
  return cleanName(m[1]);
}

// ---- Pinned-style SELECTION helpers -----------------------------------------
// Turn the stored pin (account_feeder_config.pinnedStyleHandle) into the drafter's
// loader + selector inputs. Only depend on AccountFeederConfigSchema, so they live
// here next to the resolver and are shared by both interns (Lyra + Vega) rather than
// duplicated per app.

// How many of the pinned account's posts to inject in "exact" mode. The automatic
// blend defaults to 1 exemplar (so no single source overpowers the operator); when
// the operator NAMES a person they want that voice to actually land, so the pin
// floors the exemplar count higher. The operator's own vault voice still grounds the
// CONTENT — these fix the FORM (structure, rhythm, and hook shape). At 3 the named
// voice barely moved the opening line, so we floor higher to give the model a real
// spread of that account's hooks to emulate.
export const PIN_MIN_EXEMPLARS = 6;

/**
 * Which corpus kinds shape the drafter's FORM for this instance. Reads
 * account_feeder_config.styleExemplarKinds; defaults to POSTS ONLY (`['post']`)
 * so a source's original posts — their considered voice — drive replies, not
 * their sloppy authored comments. A null/garbage/unset config also yields
 * `['post']`. Both interns can share this, but only the loaders that honour it
 * change behaviour (today: Lyra's reply drafter).
 */
export function readStyleExemplarKinds(config: unknown): ("post" | "comment")[] {
  const parsed = AccountFeederConfigSchema.safeParse(
    config && typeof config === "object" ? config : {},
  );
  const kinds = parsed.success ? parsed.data.styleExemplarKinds : undefined;
  return kinds && kinds.length ? kinds : ["post"];
}

/**
 * The faithful-voice handle list for this instance: an explicit faithfulVoices
 * list wins; otherwise a single pinnedStyleHandle becomes a 1-element list;
 * otherwise []. Empty ⇒ faithful mode off (blend path).
 */
export function readFaithfulVoices(config: unknown): string[] {
  const parsed = AccountFeederConfigSchema.safeParse(
    config && typeof config === "object" ? config : {},
  );
  if (!parsed.success) return [];
  const list = parsed.data.faithfulVoices;
  if (list && list.length) return list.map((h) => h.trim()).filter(Boolean);
  const pin = parsed.data.pinnedStyleHandle?.trim();
  return pin ? [pin] : [];
}

/**
 * Deterministically pick ONE voice for a given lead so the choice is stable
 * per lead but rotates across the feed. Uses the same seeded PRNG as the style
 * selector (makeSeededRng) over the lead text. A 1-element list returns that
 * element; an empty list returns null.
 *
 * `weights` (optional, parallel to `voices`) biases the draw: e.g. voices
 * ["kaia","henry"] with weights [0.6, 0.4] returns kaia ~60% of the time across
 * the feed. Weights are relative (need not sum to 1); a missing, length-
 * mismatched, or non-positive-sum weight list falls back to a uniform draw so
 * existing single- and multi-voice pins are unaffected.
 */
export function pickFaithfulVoice(
  voices: string[],
  seed: string,
  weights?: number[],
): string | null {
  if (!voices || voices.length === 0) return null;
  if (voices.length === 1) return voices[0]!;
  const r = makeSeededRng(seed)();
  if (weights && weights.length === voices.length) {
    const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 0));
    const total = safe.reduce((s, w) => s + w, 0);
    if (total > 0) {
      const target = r * total;
      let acc = 0;
      for (let i = 0; i < voices.length; i++) {
        acc += safe[i]!;
        if (target < acc) return voices[i]!;
      }
      return voices[voices.length - 1]!; // float-rounding guard
    }
  }
  const idx = Math.min(voices.length - 1, Math.floor(r * voices.length));
  return voices[idx]!;
}

/**
 * The per-voice weights parallel to readFaithfulVoices, or undefined when unset
 * or length-mismatched (pickFaithfulVoice then draws uniformly). Only meaningful
 * alongside an explicit faithfulVoices list of the same length.
 */
export function readFaithfulVoiceWeights(config: unknown): number[] | undefined {
  const parsed = AccountFeederConfigSchema.safeParse(
    config && typeof config === "object" ? config : {},
  );
  if (!parsed.success) return undefined;
  const voices = parsed.data.faithfulVoices;
  const weights = parsed.data.faithfulVoiceWeights;
  if (!voices || !weights || weights.length !== voices.length) return undefined;
  return weights;
}

/** Read the pinned handle off an instance's account_feeder_config (or null). */
export function readPinnedHandle(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const parsed = AccountFeederConfigSchema.safeParse(config);
  const handle = parsed.success ? parsed.data.pinnedStyleHandle : undefined;
  return handle && handle.trim() ? handle.trim() : null;
}

/**
 * Shape the feeder config for the PINNED selection: parse the base config (bad /
 * missing → schema defaults) and floor maxStyleExemplars at PIN_MIN_EXEMPLARS so the
 * named voice actually transfers. Variety drops to 0 — with the pool already
 * restricted to one account we want its best-fit posts, not a shuffled sample.
 * Returns a plain object the selector re-parses cleanly.
 */
export function pinnedSelectConfig(config: unknown): Record<string, unknown> {
  const base = AccountFeederConfigSchema.safeParse(
    config && typeof config === "object" ? config : {},
  );
  const cfg = base.success ? base.data : AccountFeederConfigSchema.parse({});
  return {
    ...cfg,
    maxStyleExemplars: Math.max(cfg.maxStyleExemplars, PIN_MIN_EXEMPLARS),
    varietyTemperature: 0,
  };
}
