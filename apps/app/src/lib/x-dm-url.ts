/**
 * Build an X (Twitter) DM-compose deep link.
 *
 * `https://x.com/messages/compose?recipient_id=<numericId>&text=<text>` — opens
 * the X web DM composer addressed to the recipient with the message prefilled,
 * in the operator's already-logged-in browser session (so "send" is one click,
 * no copy-paste). `recipient_id` is the author's NUMERIC X id (leads.author_id),
 * not the @handle. Both params optional: with no recipient it just opens the DM
 * composer; with no text it opens it empty.
 *
 * Note: X cannot pre-open a DM to an account that doesn't allow DMs from you —
 * that's a recipient-side setting, nothing we can do here.
 */
export function buildXDmUrl(
  recipientId?: string | null,
  text?: string | null,
): string {
  const parts: string[] = [];
  if (recipientId) parts.push(`recipient_id=${encodeURIComponent(recipientId)}`);
  if (text) parts.push(`text=${encodeURIComponent(text)}`);
  return parts.length
    ? `https://x.com/messages/compose?${parts.join("&")}`
    : "https://x.com/messages/compose";
}
