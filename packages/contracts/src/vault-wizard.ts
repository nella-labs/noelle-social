import { z } from "zod";

/**
 * Wizard answer contracts for the general Mars vault onboarding flow.
 * See docs/vault.md for the context onboarding contract.
 *
 * The three schemas form a chain: Medium extends Light, Rich extends
 * Medium. The renderer in @noelle/runtime accepts any of the three —
 * fields absent at a given stage just don't get rendered.
 */

const NonEmpty = z.string().trim().min(1, "required").max(280);

export const LightAnswersSchema = z.object({
  personName: NonEmpty,
  oneLineWhat: NonEmpty,
  audience: NonEmpty,
});
export type LightAnswers = z.infer<typeof LightAnswersSchema>;

const ThreeShortRules = z.array(NonEmpty).length(3, "exactly 3 required");
const Pillars = z.array(NonEmpty).min(3).max(5);

export const MediumAnswersSchema = LightAnswersSchema.extend({
  voiceDos: ThreeShortRules,
  voiceDonts: ThreeShortRules,
  bannedPhrases: z.array(NonEmpty).max(20).default([]),
  contentPillars: Pillars,
});
export type MediumAnswers = z.infer<typeof MediumAnswersSchema>;

const Snippet = z.string().trim().min(1).max(2000);
const ThreeSnippets = z.array(Snippet).length(3);
const SamplePosts = z.array(Snippet).min(3).max(5);

export const RichAnswersSchema = MediumAnswersSchema.extend({
  cadenceExamples: ThreeSnippets,
  samplePosts: SamplePosts,
});
export type RichAnswers = z.infer<typeof RichAnswersSchema>;

export const VaultWizardStageSchema = z.enum(["light", "medium", "rich"]);
export type VaultWizardStage = z.infer<typeof VaultWizardStageSchema>;
