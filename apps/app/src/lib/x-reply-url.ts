/**
 * Build an X (Twitter) reply/compose intent URL.
 *
 * `https://x.com/intent/tweet?in_reply_to=<postId>&text=<text>` — both
 * params optional. With `in_reply_to` the composer opens as a threaded
 * reply to that post; with `text` it is prefilled. Used by the approvals
 * speedrun row (click-to-send a drafted reply) and the Vega chat (surface
 * a direct "reply to this lead" link).
 *
 * Param order (in_reply_to, then text) matches the original inline
 * construction in SpeedrunRow so the produced URL is byte-identical.
 */
export function buildXReplyUrl(
  postId?: string | null,
  text?: string | null,
): string {
  const parts: string[] = [];
  if (postId) parts.push(`in_reply_to=${encodeURIComponent(postId)}`);
  if (text) parts.push(`text=${encodeURIComponent(text)}`);
  return parts.length
    ? `https://x.com/intent/tweet?${parts.join("&")}`
    : "https://x.com/intent/tweet";
}
