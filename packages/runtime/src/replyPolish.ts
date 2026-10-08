// The reply-surface polish pass: the deterministic transforms every public
// reply gets on its way out, in one place so the live path (outboundClient) and
// the backfill script (scripts/backfill-reply-polish.mjs) cannot drift apart.
//
// Order matters, and it is: periods first, typos second. The typo pass measures
// against a platform character cap and picks a token to mutate, so it has to see
// the FINAL text — running it before the period strip would let it budget for
// characters that are about to be deleted.
//
// Replies only. A DM is a cold first touch: it is longer, it is written as
// flowing prose, and neither of these transforms belongs there.

import { stripSentencePeriods } from "./voiceSanitize.js";
import { humanizeTypos, type TypoKind } from "./humanTypos.js";

/**
 * X hard-rejects a reply over 280 characters. LinkedIn and Reddit have no
 * comparable ceiling in the send path.
 */
export const PLATFORM_CHAR_CAP: Record<string, number | undefined> = { x: 280 };

/**
 * The prompt-side half of the no-dots rule. A deterministic strip guarantees the
 * output, but a sentence WRITTEN to end in a period and then shaved reads
 * differently from one written without: the clause structure is still prose.
 * Same two-layer shape as the em-dash rule.
 */
export const NO_PERIODS_RULE = `NO FULL STOPS (hard rule, the public reply only, never a DM)
Do not use a single period anywhere in the reply. Not between sentences, not at the end. The operator does not write them and a stripped one still leaves the sentence SHAPED like written prose, so write without them from the start.
What to do instead: let the line break do the work, or glue the clauses with a comma and a connector (and, but, so, because, yep, honestly), which is how the operator actually talks. Two thoughts that genuinely need separating can sit either side of a comma.
Question marks and exclamation marks are untouched, so ask the question you actually have. Dots INSIDE a word are not full stops and are fine: decimals ("$0.66", "9.0"), versions ("qwen 3.8"), and any domain or URL. An ellipsis is fine.`;

export interface PolishResult {
  body: string;
  /** The typo kind that landed, or null when the body was left clean. */
  typo: TypoKind | null;
  /** Whether the period strip changed anything. */
  periodsStripped: boolean;
}

export interface PolishOptions {
  /** Lead platform, for the character cap. */
  platform: string;
  /** Share of replies that receive one typing slip. */
  typoRate: number;
  /** Injectable rng for deterministic tests. */
  rng?: () => number;
}

/**
 * Run the full reply polish. Returns the finished body plus what happened, so
 * callers can log it and recompute their own char counts.
 */
export function polishReplyBody(body: string, opts: PolishOptions): PolishResult {
  const stripped = stripSentencePeriods(body);
  const maxLength = PLATFORM_CHAR_CAP[opts.platform];
  const typed = humanizeTypos(stripped, {
    rate: opts.typoRate,
    ...(opts.rng ? { rng: opts.rng } : {}),
    ...(maxLength != null ? { maxLength } : {}),
  });
  return {
    body: typed.body,
    typo: typed.applied,
    periodsStripped: stripped !== body,
  };
}
