// Shared emoji policy for the drafters (Vega on X, Lyra on LinkedIn). The
// product rule: a drafted reply/comment/DM may use an emoji ONLY when the
// original post itself uses emoji, and ONLY from a tiny allowlist. The prompt
// asks the model to follow this; stripDisallowedEmoji is the hard backstop that
// guarantees nothing outside the allowlist ever ships, regardless of the model.

/** The only emoji a drafter may ever ship. */
export const ALLOWED_EMOJI = new Set(["💀", "😭", "😛"]);

// Strip complete pictographic, flag, tag-flag and keycap clusters so removing an
// emoji cannot leave selectors, joiners, tag letters or keycap marks behind.
const EMOJI_GRAPHEME =
  /(?:\p{Regional_Indicator}{1,2}|[0-9#*]\u{FE0F}?\u{20E3}|\p{Extended_Pictographic}(?:\u{FE0F}|[\u{1F3FB}-\u{1F3FF}]|\u{200D}\p{Extended_Pictographic})*(?:[\u{E0020}-\u{E007E}]+\u{E007F})?)/gu;

// What counts as "this post is using emoji". DELIBERATELY NARROWER than
// EMOJI_GRAPHEME, which is the strip pattern.
//
// `\p{Extended_Pictographic}` alone also matches ™ © ® ‼ ↔ ♥ ✔ — ordinary
// typography that appears in perfectly emoji-free prose. Using it as the gate
// meant a post reading "Acme™ just shipped v2" was read as setting an emoji
// register, which re-opened the very hole the postText gate was added to close.
//
// So the gate requires a character that is emoji BY DEFAULT
// (`\p{Emoji_Presentation}`, i.e. 🚀 💀 😭), or a text-default character that
// was explicitly given the emoji variation selector (✔️, ❤️). A bare ✔ or ™ is
// typography and does not open the gate.
const EMOJI_INTENT = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️|[0-9#*]\u{FE0F}?\u{20E3})/u;

/**
 * True when `text` deliberately uses emoji — the gate for "may the reply use
 * one". Not the same question as "does this contain a pictographic codepoint",
 * which is what EMOJI_GRAPHEME answers for stripping.
 */
export function hasEmoji(text: string): boolean {
  return EMOJI_INTENT.test(text ?? "");
}

export interface StripEmojiOpts {
  /**
   * The post being replied to. When given and it contains NO emoji, every emoji
   * is stripped, including allowlisted ones.
   *
   * The product rule has always had two clauses — an emoji only when the post
   * itself uses one, and only from the allowlist — but only the allowlist half
   * had a deterministic backstop; the "match the post" half was prompt-only.
   * It does get broken: a 💀 landing under a post with no emoji at all is a
   * tell, and exactly the kind of tell the rest of this work is removing.
   *
   * Omit it and behaviour is unchanged (allowlist enforcement only), so every
   * existing caller keeps working.
   */
  postText?: string | null;
}

/**
 * Strip every emoji that isn't in {@link ALLOWED_EMOJI} — and, when `postText`
 * is supplied and carries no emoji of its own, every emoji full stop. An allowed
 * emoji is kept by its base code point (any variation selector is dropped).
 * Tidies the spacing a removed emoji leaves behind (double spaces, a space
 * before punctuation, a space hugging a newline) without collapsing newlines
 * themselves — DM bodies are multi-chunk and depend on their blank lines.
 */
export function stripDisallowedEmoji(text: string, opts: StripEmojiOpts = {}): string {
  const postAllowsEmoji = opts.postText == null || hasEmoji(opts.postText);
  return text
    .replace(EMOJI_GRAPHEME, (m) => {
      if (!postAllowsEmoji) return "";
      const base = [...m][0] ?? "";
      return ALLOWED_EMOJI.has(base) ? base : "";
    })
    .replace(/ {2,}/g, " ")
    .replace(/ +([,.!?])/g, "$1")
    .replace(/ +\n/g, "\n")
    .replace(/\n +/g, "\n")
    .trim();
}

/**
 * Apply the reply emoji policy to a SET of drafts, keeping the result non-empty
 * whenever ANY input body has content that survives the allowlist.
 *
 * The post-match clause can empty a body outright: a reply that is only an
 * allowlisted emoji, under a post with no emoji, strips to "". That is a real
 * case and every naive handling of it is worse than the problem:
 *
 *   - shipping "" violates OutboundInSchema's body.min(1) and THROWS. On
 *     LinkedIn's batched light path that throw aborts the distribution loop
 *     mid-batch and sets batchFellBack, and the fallback re-runs every lead in
 *     the batch with no already-drafted check — duplicate approvals plus a
 *     second paid model call for every lead already posted.
 *   - filtering to an empty list throws the same way, one step later.
 *   - filtering and letting the caller's "no replies left" branch handle it
 *     kills the lead and discards the DM drafted in the same call, over one
 *     degenerate angle, and misattributes the reason to whatever guard happens
 *     to own that branch.
 *
 * So: drop the bodies the gate empties, but if that would leave NOTHING, keep
 * the first draft under allowlist-only stripping instead. The post-match clause
 * is a polish rule. Enforcing it must never cost a lead, a DM, or a duplicated
 * batch — a lone "💀" queued for review is the cheapest of these outcomes by a
 * wide margin.
 *
 * IT CAN STILL RETURN []. The last resort strips the ALLOWLIST too, so a draft
 * that is only a NON-allowlisted emoji (a lone "🎉") has nothing left either.
 * That is a garbage draft with no text in it at all, and there is no honest
 * body to invent for it — so callers MUST handle the empty case explicitly,
 * with their own accurate skip, rather than passing it to a schema that
 * requires min(1). An earlier version of this doc promised a non-empty result
 * unconditionally and three callers relied on that promise.
 */
export function applyReplyEmojiPolicy<T extends { body: string }>(
  drafts: readonly T[],
  postText: string | null | undefined,
  isReply: (d: T) => boolean = () => true,
): T[] {
  const gated = drafts.map((d) => ({
    ...d,
    body: stripDisallowedEmoji(d.body, isReply(d) ? { postText: postText ?? null } : {}),
  }));
  const kept = gated.filter((d) => d.body.trim().length > 0);

  // The rescue is about the REPLY rows specifically, not about the set being
  // empty. A DM is exempt from the post-match clause, so a lead whose replies
  // all cleaned to nothing but which carries a DM leaves `kept = [dmRow]` —
  // non-empty, rescue skipped, and the lead is marked drafted with a DM and no
  // public comment at all. Ask the question that actually matters: is there a
  // sendable REPLY left?
  const hadReply = drafts.some((d) => isReply(d));
  const keptReply = kept.some((d) => isReply(d));
  if (!hadReply || keptReply) return kept;

  // Every reply emptied. Keep the first one under allowlist-only stripping,
  // alongside whatever non-reply rows survived.
  const firstReply = drafts.find((d) => isReply(d))!;
  const rescued = { ...firstReply, body: stripDisallowedEmoji(firstReply.body) };

  // …unless the rescue is ALSO empty, which happens when that body was only a
  // NON-allowlisted emoji (a lone "🎉"): the allowlist strip removes it too.
  // Returning it anyway is what made every caller's empty-check dead code — the
  // array was length 1 with an empty body inside, so `length === 0` never fired
  // and body.min(1) threw downstream exactly as if there were no guard at all.
  if (rescued.body.trim().length === 0) return kept.filter((d) => !isReply(d));
  return [rescued, ...kept.filter((d) => !isReply(d))];
}
