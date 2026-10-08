import { z } from "zod";

/**
 * @noelle/contracts — agent brand config.
 *
 * Operator-set "who the agent speaks as + what it pitches + how it writes",
 * persisted to `noelle.agent_instances.brand_config` (jsonb). This externalises
 * what used to be hardcoded in the drafter's SYSTEM_X prompt (persona, product
 * pitch, reply/DM voice) so an operator can tailor Vega to their own business
 * without forking the prompt. Every field is optional — an empty `{}` config
 * reproduces the generic, product-agnostic peer behaviour.
 *
 * The drafter composes these into the system prompt via renderBrandBlock()
 * (apps/x-intern/src/lib/prompts.ts); the `noelle brand` CLI scaffolds +
 * validates the JSON against this schema before writing the column.
 */

const short = (max: number) => z.string().trim().max(max);

/** The configured identity and voice used for drafting. */
export const PersonaSchema = z.object({
  name: short(120).optional(),
  /** One or two lines: who they are, what they care about, how they sound. */
  bio: short(800).optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;

/** The product/offer the agent may pitch (replaces hardcoded Nella copy). */
export const ProductSchema = z.object({
  name: short(120).optional(),
  description: short(800).optional(),
  url: short(200).optional(),
  /** e.g. an install/CTA line dropped verbatim into a DM when pitching. */
  install: short(300).optional(),
  /** Public surfaces (site, docs, repo) the agent may reference. */
  surfaces: z.array(short(200)).max(12).default([]),
  /** Concrete pains the product fixes — the fit test for whether to pitch. */
  fits_when: z.array(short(200)).max(30).default([]),
});
export type Product = z.infer<typeof ProductSchema>;

/** When may the agent pitch the product? */
export const PitchPolicySchema = z.enum(["never", "when_relevant", "always"]);
export type PitchPolicy = z.infer<typeof PitchPolicySchema>;

export const ReplyStyleSchema = z.object({
  /** Free-form voice notes for public replies. */
  voice_notes: short(1200).optional(),
  /** Hard "never do this" rules layered onto the base never-do list. */
  never_do: z.array(short(160)).max(40).default([]),
});
export type ReplyStyle = z.infer<typeof ReplyStyleSchema>;

/** The "approach to DMs" — the surface the operator most wants to tailor. */
export const DmStyleSchema = z.object({
  greeting: short(80).optional(),
  closing: short(300).optional(),
  fragments_min: z.number().int().min(1).max(12).optional(),
  fragments_max: z.number().int().min(1).max(12).optional(),
  len_min: z.number().int().min(40).max(2000).optional(),
  len_max: z.number().int().min(40).max(2000).optional(),
  /** Free-form notes on DM tone/structure. */
  notes: short(1200).optional(),
});
export type DmStyle = z.infer<typeof DmStyleSchema>;

/** One brand question + its answer, injected as grounding for both replies+DMs. */
export const QaItemSchema = z.object({
  q: short(200),
  a: short(1200),
});
export type QaItem = z.infer<typeof QaItemSchema>;

export const BrandConfigSchema = z.object({
  persona: PersonaSchema.optional(),
  product: ProductSchema.optional(),
  pitch_policy: PitchPolicySchema.default("when_relevant"),
  reply_style: ReplyStyleSchema.optional(),
  dm_style: DmStyleSchema.optional(),
  /** Operator's brand Q&A — the "bunch of questions" answered for the agent. */
  qa: z.array(QaItemSchema).max(40).default([]),
});
export type BrandConfig = z.infer<typeof BrandConfigSchema>;

/** Parse unknown jsonb into a BrandConfig, tolerating an empty/missing column. */
export function parseBrandConfig(raw: unknown): BrandConfig {
  if (raw == null || (typeof raw === "object" && Object.keys(raw).length === 0)) {
    return BrandConfigSchema.parse({});
  }
  return BrandConfigSchema.parse(raw);
}

/** True when the config carries any operator-set signal worth injecting. */
export function brandConfigHasContent(b: BrandConfig): boolean {
  return Boolean(
    b.pitch_policy === "never" || b.pitch_policy === "always" ||
      b.persona?.name ||
      b.persona?.bio ||
      b.product?.name ||
      b.product?.description ||
      (b.qa && b.qa.length > 0) ||
      b.reply_style?.voice_notes ||
      (b.reply_style?.never_do && b.reply_style.never_do.length > 0) ||
      b.dm_style?.notes ||
      b.dm_style?.greeting,
  );
}
