import { type IcpHeadlineGate } from "@noelle/runtime";

/**
 * Read the ICP author gate from agent_instances.icp_config (mig 0043 — a SHARED
 * column Vega always had and, until the parity pass, never read).
 *
 * Two consumers, deliberately one reader: the CLASSIFIER uses it to drop an
 * off-ICP author before the LLM call, and person-first DISCOVERY uses it to
 * decide who is worth retaining as a candidate. If they read the config
 * differently, "who counts as in-ICP" would mean two things.
 *
 * Tolerates any shape — the live LinkedIn config carries unrelated keys
 * (postQueries, searchQuery, minReactions) alongside the keyword lists, so
 * unknown keys are ignored rather than treated as a parse failure. No usable
 * include keyword ⇒ null, which every caller treats as "gate off".
 */
export function readIcpGate(cfg: unknown): IcpHeadlineGate | null {
  if (!cfg || typeof cfg !== "object") return null;
  const raw = cfg as { headlineKeywords?: unknown; headlineExcludeKeywords?: unknown };
  const asList = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const headlineKeywords = asList(raw.headlineKeywords);
  if (headlineKeywords.length === 0) return null;
  return { headlineKeywords, headlineExcludeKeywords: asList(raw.headlineExcludeKeywords) };
}
