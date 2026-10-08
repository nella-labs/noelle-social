// Deterministic voice backstop for drafted bodies.
//
// Consolidated from three copies that were identical in every line of
// executable code:
//   apps/x-intern/src/lib/voice-sanitize.ts        (Vega)
//   apps/linkedin-intern/src/lib/voice-sanitize.ts (Lyra)
//   apps/reddit-intern/src/lib/voice-sanitize.ts   (Orion)
// linkedin and reddit were md5-identical to each other; x-intern differed only
// in the prose of this header (it cited the ~26% em-dash rate and "in two
// places"; the other two carried a "Mirrors apps/x-intern/..." pointer instead).
// The regex chain was byte-identical across all three, so this is a straight
// lift with no behaviour change for any intern.
//
// The operator's brand rules forbid em dashes (a top AI tell), and the prompt
// says so explicitly in two places, but LLMs emit them anyway (~26% of recent
// drafts when this was written). Prompt instructions can't guarantee this; a
// post-generation pass can. So after the model returns, we strip em/en/
// horizontal-bar dashes (and the "--" digraph) and glue the clauses with commas,
// which is exactly the operator's stated preference ("glue clauses with commas +
// connectors"). Real hyphens (U+002D, e.g. "one-person", "AST-aware") are left
// untouched.

/**
 * Replace em/en/horizontal-bar dashes (and spaced "--") with comma-glue.
 * Numeric ranges keep a hyphen ("400–700" → "400-700"). Idempotent.
 */
export function stripEmDashes(body: string): string {
  return body
    // numeric range with an en/em dash → hyphen, preserve meaning ("400–700")
    .replace(/(\d)\s*[–—]\s*(\d)/g, "$1-$2")
    // any em/en/horizontal-bar dash, or a spaced double-hyphen → ", "
    .replace(/\s*[—–―]\s*|\s+--\s+/g, ", ")
    // tidy up spacing/commas the substitution may have introduced
    .replace(/\s+,/g, ",")
    .replace(/,(?:\s*,)+/g, ",")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s*,\s*$/g, "")
    .trim();
}

/**
 * Remove SENTENCE-ENDING full stops. The operator does not want a single dot in
 * a public reply: a period is the punctuation of written prose, and these are
 * meant to read as someone typing on a phone.
 *
 * "Sentence-ending" is doing real work here, because a blind strip corrupts
 * meaning. A dot is only removed when what FOLLOWS it is whitespace, the end of
 * the string, or a closing bracket/quote before either. That leaves every dot
 * that lives INSIDE a token untouched:
 *
 *   decimals + versions   "$0.66", "9.0", "qwen 3.8", "3.5 stars"
 *   domains + URLs        "example.test", "https://x.com/foo"
 *   ellipsis              "…" (one character) and "..." (collapsed, not halved)
 *
 * Question marks and exclamation marks are retained; only sentence periods
 * are subject to this formatting rule.
 * Idempotent.
 */
export function stripSentencePeriods(body: string): string {
  // Closing punctuation a dot may hide behind: (like this.) or "like this."
  const CLOSERS = "[)\\]}\"'’”]*";
  return body
    // A run of 2+ dots at a sentence end is an ellipsis typed the long way.
    // Collapse the whole run, otherwise the single-dot rule below leaves "..".
    .replace(new RegExp(`\\.{2,}(?=${CLOSERS}(?:\\s|$))`, "g"), "")
    .replace(new RegExp(`\\.(?=${CLOSERS}(?:\\s|$))`, "g"), "")
    // The dot is gone but its space stays, so a mid-body strip leaves ONE space.
    // Only collapse what the substitution itself could have doubled.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+$/g, "")
    .trim();
}
