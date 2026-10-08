import { z } from "zod";

/**
 * VIP / relationship-scout signal attached to a lead (noelle.leads.vip_signal).
 *
 * The classifier (Lyra for LinkedIn, Vega for X) judges, in the SAME LLM call it
 * already makes per lead, whether the post's AUTHOR is a high-leverage person to
 * build a relationship with: an ICP match, a founder/investor (e.g. a YC founder),
 * or simply someone whose connection would be unusually impactful. When it flags
 * one it also pre-drafts a short, genuine intro DM opener (a real question or a
 * coffee-chat ask — never a pitch) so the approvals page can surface it instantly.
 *
 * Why precomputed: api-vm has no LLM path (drafting lives only in the intern
 * workers), so the suggested DM cannot be generated on button-click — it rides
 * along on the classifier verdict and is persisted to the lead.
 *
 * Fail-open: a lead with no vip_signal (NULL) or `vip: false` shows no banner.
 */
export const VipSignalSchema = z.object({
  /** True when the author is a high-leverage person worth a relationship. */
  vip: z.boolean(),
  /** One short sentence on WHY they're high-leverage. Empty when vip is false. */
  reason: z.string().max(400).default(""),
  /**
   * Coarse labels for the kind of VIP, for chips/filtering — e.g.
   * "yc-founder", "founder", "investor", "icp", "operator", "creator".
   * Free-form (the model picks), lower-kebab-case, capped to keep the row small.
   */
  tags: z.array(z.string().max(40)).max(6).default([]),
  /** The scout suggests adding this person to the agent's watchlist. */
  add_to_watchlist: z.boolean().default(false),
  /** The scout suggests sending them a DM soon (they're worth reaching out to). */
  dm_soon: z.boolean().default(false),
  /**
   * A ready-to-send intro DM opener: genuine, specific to their post, a real
   * question or coffee-chat ask, NO pitch and NO link. Null when no DM is
   * warranted (vip but better engaged via a public reply, or scout declined).
   */
  suggested_dm: z.string().max(700).nullable().default(null),
});
export type VipSignal = z.infer<typeof VipSignalSchema>;

/**
 * Parse an unknown jsonb value (the raw noelle.leads.vip_signal column) into a
 * VipSignal, returning null when absent or malformed. Use this on read paths so
 * a stale/garbage row never throws — the banner simply doesn't render.
 */
export function parseVipSignal(value: unknown): VipSignal | null {
  if (value == null) return null;
  const parsed = VipSignalSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
