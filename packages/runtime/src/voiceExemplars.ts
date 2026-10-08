import type { VoiceExemplar } from "./priorReplies.js";

/**
 * Render the operator's own approved replies as POST → REPLY pairs.
 *
 * Deliberately different from the STYLE TARGETS block above, which is a frozen
 * list of reply snippets with no posts attached and an explicit "not their
 * content, never lift a phrase". That block can teach length and flatness; it
 * cannot teach the MOVE, because a reply with no post above it does not show
 * what the reply did with the post.
 *
 * These pairs do. Measured on three real leads, adding them turned
 *   "The reply work is where distribution gets built, respect"
 * into
 *   "4000 replies in 90 days is basically a second product, curious which
 *    experiment actually moved customers instead of just impressions?"
 * — the specific number lifted out of the post, and a question back.
 *
 * The no-lifting rule is restated here on purpose: pairs are a stronger pull
 * toward copying than orphan snippets, precisely because they look answerable.
 */
export function renderVoiceExemplars(exemplars: ReadonlyArray<VoiceExemplar>): string {
  if (exemplars.length === 0) return "";
  const pairs = exemplars
    .map((e) => `POST: ${truncateForPrompt(e.post, e.reply, 280)}\nYOU REPLIED: ${e.reply}`)
    .join("\n\n");
  return [
    "",
    "HOW YOU ACTUALLY REPLY",
    "Real replies of yours that the operator approved and sent, each under the post it answered.",
    "Read what the reply DID with the post — which detail it picked up, whether it asked something",
    "back, how little it explained itself. Match that move, not these words: never lift a phrase",
    "from them, and your reply must still make no sense under any post except the one you were given.",
    "",
    pairs,
  ].join("\n");
}

/** Keep both the post's setup and the detail the sent reply actually picked up. */
function truncateForPrompt(post: string, reply: string, max: number): string {
  const text = post.trim().replace(/\s+/g, " ");
  if (text.length <= max) return text;

  const initial = text.slice(0, max - 1);
  const visibleWords = new Set(words(initial).map(({ word }) => word));
  const missingReplyWords = new Set(words(reply).map(({ word }) => word).filter((word) =>
    (word.length >= 4 || /^\d+$/.test(word)) && !visibleWords.has(word) && !COMMON_WORDS.has(word),
  ));
  const tokens = words(text);
  const lateMatches = tokens.filter(({ word, at }) => at >= max - 1 && missingReplyWords.has(word));
  if (lateMatches.length === 0) return `${initial}…`;

  const openingCut = Math.min(96, max - 1);
  const lastSpace = text.lastIndexOf(" ", openingCut);
  const opening = text.slice(0, lastSpace > 0 ? lastSpace : openingCut);
  const excerptBudget = max - opening.length - 4; // " … " and a possible final ellipsis
  let bestStart = 0;
  let bestScore = -1;
  for (const match of lateMatches) {
    const start = Math.min(Math.max(opening.length, match.at - 40), text.length - excerptBudget);
    const end = start + excerptBudget;
    const distinct = new Set(tokens.filter(({ word, at }) =>
      at >= start && at < end && missingReplyWords.has(word),
    ).map(({ word }) => word));
    const score = [...distinct].reduce((sum, word) => sum + (/^\d+$/.test(word) ? 3 : 1), 0);
    if (score > bestScore) { bestScore = score; bestStart = start; }
  }
  // Start on a word boundary. This can shorten the excerpt, never lengthen it.
  if (bestStart > 0 && text[bestStart - 1] !== " ") {
    const nextSpace = text.indexOf(" ", bestStart);
    if (nextSpace !== -1 && nextSpace - bestStart < 20) bestStart = nextSpace + 1;
  }
  const excerpt = text.slice(bestStart, bestStart + excerptBudget).trimEnd();
  return `${opening} … ${excerpt}${bestStart + excerpt.length < text.length ? "…" : ""}`;
}

const COMMON_WORDS = new Set([
  "about", "after", "before", "from", "have", "into", "more", "that", "their",
  "there", "these", "this", "those", "through", "what", "when", "where", "which",
  "with", "would", "your", "just", "like", "only", "really", "than", "then",
]);

function words(text: string): Array<{ word: string; at: number }> {
  return [...text.matchAll(/[\p{L}\p{N}]+/gu)].map((match) => ({
    word: match[0].toLocaleLowerCase(), at: match.index,
  }));
}
