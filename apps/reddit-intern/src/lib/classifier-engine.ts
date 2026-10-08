import { z } from "zod";
import { isBudgetAdmissionError, evaluateJevChoice, type EngineBackend } from "@noelle/runtime";

// LinkedIn quality classifier ("Lyra"). Mirrors apps/x-intern/src/lib/classifier-engine.ts
// but specialised for LinkedIn + the operator's specific volume rules: instead
// of a velocity estimate it returns a reply-worthiness score `q` (0-100) plus a
// `reply_kind` that routes the lead down one of three paths in the drafter:
//
//   - 'substantial' (q >= REDDIT_Q_THRESHOLD): worth a real, value-adding
//     reply. tier follows q bands: q>=90 → T1, 80-89 → T2, threshold-89 → T3.
//   - 'light' (below the threshold but still worth a SHORT supportive comment):
//     wins, launches, milestones, "I shipped / joined / started" posts. tier null.
//   - 'skip' (off-brand, pure promo, news, reposts, generic motivational): nothing
//     to add.
//
// Backend-agnostic: the worker injects an `EngineBackend` — Vertex Gemini Flash
// via ADC (the Noelle-billed default) when the org has no key of its own, a
// per-org Google AI Studio key backend when it brought one, or Bedrock Claude on
// the self-host box. The engine just parses strict JSON, so any backend works.
//
// Fail-open philosophy (identical to Vega): the classifier is a cost-saver, not a
// hard gate. A backend error / unparseable response lets the lead through as a
// 'substantial' T3 so nothing high-signal is ever silently lost. A fail-open
// carries `q = null` so an unscored lead is honestly distinguishable from a
// genuine zero downstream (the worker writes NULL to noelle.leads.classifier_score).

const ReplyKind = z.enum(["substantial", "light", "skip"]);

const ClassifierOutput = z.object({
  q: z.number().int().min(0).max(100),
  reply_kind: ReplyKind,
  tier: z.enum(["T1", "T2", "T3"]).nullable().optional(),
  reason: z.string(),
  /**
   * True when the post is engagement-bait designed to FARM low-value comments
   * via a CTA ("comment WORD below", "drop a LINK", "type X to receive Y",
   * giveaway-for-comment). Optional + defaulted false so a model that omits the
   * field still parses (and is treated as genuine discussion). Feeds the
   * drafter's Opus tiering: a high comment count is only trustworthy when the
   * comments are genuine, so a bait post's comment count is ignored.
   */
  comment_bait: z.boolean().optional().default(false),
});

export type ReplyKindValue = z.infer<typeof ReplyKind>;

export interface ClassifyInput {
  postText: string;
  /** The author's display name, when known. */
  authorName?: string | null;
  /** The author's Reddit username, when known. */
  authorHeadline?: string | null;
}

export interface ClassifyOutput {
  /** Reply-worthiness 0-100, or null when scoring failed (NULL, not a fake 0). */
  q: number | null;
  reply_kind: ReplyKindValue;
  tier: "T1" | "T2" | "T3" | null;
  reason: string;
  /**
   * True when the post farms low-value comments via a CTA (giveaway / "comment
   * WORD below" / "drop a LINK"). The drafter ignores the post's comment count
   * for Opus tiering when this is set. Defaults false on every fail-open path —
   * an unscored lead is treated as genuine discussion (the conservative choice).
   */
  comment_bait: boolean;
  /**
   * Token usage for the backend call, so the worker can record the Gemini /
   * Bedrock spend. Zero on every fail-open path (backend error / unparseable /
   * schema miss) — those cost nothing billable, so the worker records no spend.
   */
  usage: { inputTokens: number; outputTokens: number };
  raw: unknown;
}

/**
 * Default Vertex Gemini handle. Dashed form — `createVertexBackend` maps it to
 * the dotted `gemini-2.5-flash` the Vertex API expects.
 */
export const DEFAULT_CLASSIFIER_MODEL = "gemini-2-5-flash";

/**
 * Map a `q` score to a tier band for a SUBSTANTIAL lead. Only meaningful when
 * `reply_kind === 'substantial'`; light/skip leads carry a null tier.
 */
export function tierForQ(q: number): "T1" | "T2" | "T3" {
  if (q >= 90) return "T1";
  if (q >= 80) return "T2";
  return "T3";
}

const BASE_SYSTEM = [
  "You triage Reddit posts for an indie founder's growth intern (Noelle).",
  "Your job: decide whether a post is worth ENGAGING the author with a comment, and how heavy that engagement should be. You are protecting the founder's time and reputation — only genuinely engageable, high-signal posts from real people deserve a substantial reply.",
  "GOOD signal (engageable): a founder/builder/operator sharing a real opinion, a pain, a lesson, a question, a technical thread, a launch with substance, a win or milestone. The author is a real person you could have a peer conversation with.",
  "BAD signal (skip): reposts/shares with no added commentary, job postings / hiring promos, pure product ads, news links, generic motivational/inspirational fog ('grind never stops', 'here are 10 lessons'), engagement-bait, AI-written slop, anything political or off-topic.",
  "SCORE q (0-100): how reply-worthy is this for a thoughtful, value-adding comment from a peer founder? 90-100 = exceptional, must engage; 80-89 = strong; 75-79 = worth a real reply; 50-74 = thin but maybe a short supportive note; under 50 = skip.",
  "REPLY_KIND — choose exactly one:",
  "  - 'substantial' when q is high enough to justify a real, value-adding reply (the founder would write a genuine, specific comment). Set tier by band: q>=90 → T1, 80-89 → T2, otherwise T3.",
  "  - 'light' when the post is NOT substantial-grade but is still worth a SHORT, warm, supportive comment — wins, launches, milestones, 'I shipped / joined / started / raised' posts, the kind you answer with a brief genuine 'congrats' or 'love it, excited to see where it goes'. Set tier=null.",
  "  - 'skip' otherwise (off-brand, pure promo, news, reposts, generic motivational, nothing to add). Set tier=null.",
  "Be strict: when in doubt between 'substantial' and 'light', pick 'light'. When in doubt between 'light' and 'skip', and the post is a genuine personal win/launch from a real person, pick 'light'; if it's promo or fog, pick 'skip'.",
  "COMMENT_BAIT — set true ONLY when the post is engagement-bait designed to FARM low-value comments via a call-to-action: 'comment WORD below', 'drop a LINK / your handle', 'type X to get/receive Y', 'comment to enter' giveaways, 'tag 3 people', or any post whose main ask is to leave a comment in exchange for something. These inflate the comment count with low-value replies that are NOT real discussion. Set false for normal posts — including ones that simply pose a genuine question or invite real discussion. When unsure, set false.",
  "Return STRICT JSON, no preamble, no markdown fences: {\"q\": <0-100 int>, \"reply_kind\": \"substantial\"|\"light\"|\"skip\", \"tier\": \"T1\"|\"T2\"|\"T3\"|null, \"comment_bait\": true|false, \"reason\": \"<one short sentence>\"}.",
].join(" ");

/**
 * Compose the classifier system prompt for an agent instance, appending the
 * operator's objective (agent_instances.objective) when set so the triage is
 * biased toward the founder's actual mission. With no objective, returns
 * BASE_SYSTEM unchanged.
 */
export function buildClassifierSystem(objective?: string | null, qThreshold = 75): string {
  const threshold = [
    BASE_SYSTEM,
    `The reply-worthiness threshold for 'substantial' is q >= ${qThreshold}. A post scoring at or above it should be 'substantial'; below it is 'light' (if a genuine win/launch worth a short note) or 'skip'.`,
  ].join(" ");
  const mission = objective?.trim();
  if (!mission) return threshold;
  return [
    threshold,
    `The founder's mission for this agent is: "${mission}". Weight your judgement toward it: posts that relate to this mission are more reply-worthy and should score higher; posts unrelated to both this mission and the engageable-founder ICP above score lower. Do not invent relevance — only count a genuine connection.`,
  ].join(" ");
}

export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassifyOutput>;
}

export function createClassifier(opts: {
  /** LLM backend — Vertex Gemini in managed prod, Bedrock Claude on self-host. */
  backend: EngineBackend;
  model?: string;
  /** Operator mission (agent_instances.objective) — steers the triage. */
  objective?: string | null;
  /** The substantial threshold woven into the prompt (default 75). */
  qThreshold?: number;
  evaluate?: typeof evaluateJevChoice;
}): Classifier {
  const backend = opts.backend;
  const model = opts.model ?? DEFAULT_CLASSIFIER_MODEL;
  const qThreshold = opts.qThreshold ?? 75;
  const system = buildClassifierSystem(opts.objective, qThreshold);
  return {
    async classify(input) {
      try {
        const decision = await (opts.evaluate ?? evaluateJevChoice)({
          state: JSON.stringify({ ...input, objective: opts.objective ?? null }),
          instructions: "Classify whether this Reddit post deserves a specific substantial reply, a short warm reply, or no reply from a peer founder.",
          criteria: {
            substantial: "A genuine question or pain where a useful, specific reply can add value.",
            light: "A real personal win or launch worth a brief warm reaction, but not a substantial reply.",
            skip: "Off-topic, generic promo, engagement bait, news, or nothing useful to add.",
          },
        });
        const choice = decision.kind === "choice" ? decision.choice : null;
        const confidence = decision.kind === "choice" ? decision.probability : null;
        if (decision.kind === "choice" && (choice === "substantial" || choice === "light" || choice === "skip") &&
            typeof confidence === "number" && confidence >= 0.8) {
          const q = choice === "substantial" ? Math.max(qThreshold, Math.round(confidence * 100))
            : choice === "light" ? Math.max(0, Math.min(qThreshold - 1, 50)) : 0;
          return {
            q,
            reply_kind: choice,
            tier: choice === "substantial" ? tierForQ(q) : null,
            reason: `Jev classified this post as ${choice}`,
            comment_bait: false,
            usage: { inputTokens: 0, outputTokens: 0 },
            raw: { judge: "jev", choice, probability: confidence },
          };
        }
      } catch {
        // Use the current classifier below when Jev is unavailable.
      }
      try {
        const { text, usage } = await backend.call({
          system,
          prompt: JSON.stringify(input),
          model,
        });
        const callUsage = {
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
        };
        // unparseable / schema-miss still consumed tokens (the call succeeded),
        // so carry the real usage through — only a thrown call records nothing.
        const obj = extractJson(text);
        if (obj == null) return failOpen("unparseable", callUsage);
        const parsed = ClassifierOutput.safeParse(obj);
        if (!parsed.success) return failOpen("schema", callUsage);
        // Normalise the tier to the kind: only 'substantial' leads carry a tier,
        // and we recompute it from q so the band is authoritative even if the
        // model put a tier on a light/skip lead or picked the wrong band.
        const replyKind = parsed.data.reply_kind;
        const tier = replyKind === "substantial" ? tierForQ(parsed.data.q) : null;
        return {
          q: parsed.data.q,
          reply_kind: replyKind,
          tier,
