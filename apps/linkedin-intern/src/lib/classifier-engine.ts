import { z } from "zod";
import { isBudgetAdmissionError, evaluateJevBoolean, evaluateJevChoice, type EngineBackend } from "@noelle/runtime";
import { VipSignalSchema, type VipSignal } from "@noelle/contracts";

// LinkedIn quality classifier ("Lyra"). Mirrors apps/x-intern/src/lib/classifier-engine.ts
// but specialised for LinkedIn + the operator's specific volume rules: instead
// of a velocity estimate it returns a reply-worthiness score `q` (0-100) plus a
// `reply_kind` that routes the lead down one of three paths in the drafter:
//
//   - 'substantial' (q >= LINKEDIN_Q_THRESHOLD): worth a real, value-adding
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
  /**
   * Relationship-scout verdict (only present when the scout is enabled). The
   * model judges whether the post's author is a high-leverage person to build a
   * relationship with and, if so, pre-drafts a genuine intro DM. Optional so a
   * scout-off run (or a model that omits it) still parses. Reuses the shared
   * VipSignalSchema so the wire shape matches noelle.leads.vip_signal exactly.
   */
  relationship: VipSignalSchema.optional(),
});

export type ReplyKindValue = z.infer<typeof ReplyKind>;

export interface ClassifyInput {
  postText: string;
  /** Visible engagement counts from the feed card, when LinkedIn shows them. */
  reactionCount?: number;
  commentCount?: number;
  /** The author's display name, when known. */
  authorName?: string | null;
  /** The author's LinkedIn headline (role/company line), when known. */
  authorHeadline?: string | null;
}

export interface ClassifyOutput {
  /** Judge that produced the usable verdict. */
  provider: "jev" | "legacy" | "legacy-fail-open";
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
   * Relationship-scout verdict, or null when the scout was off / failed / the
   * model omitted it. Persisted to noelle.leads.vip_signal so the approvals page
   * can flag high-leverage authors and surface a precomputed intro DM.
   */
  vip: VipSignal | null;
  /**
   * Token usage for the backend call (classifier fallback or VIP metadata), so
   * the worker can record Gemini / Bedrock spend. Zero when no billed call ran.
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
  "You triage LinkedIn posts for an indie founder's growth intern (Noelle).",
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

// Appended to the legacy classifier prompt when the relationship scout is on.
// Adds a `relationship` key to the SAME JSON object, judging
// whether the post's author is a high-leverage person to build a relationship
// with. It decides WHO is worth a DM and WHETHER — it does NOT write the DM. The
// actual intro DM is drafted afterward with Opus (claude -p → Bedrock) in
// lib/vip-dm.ts, because a DM written here would inherit this cheap gemini-flash
// call's house style and read as AI ("Curious: … Would love to hear …").
const RELATIONSHIP_SCOUT_RULES = [
  "High-leverage = someone in the founder's ICP, a founder/CEO/builder of a notable or venture-backed company (e.g. a YC founder), an investor/VC/angel, or a respected operator/creator in the space — anyone whose connection would be unusually impactful. Judge from the author's name + headline (role/company) and the substance of the post.",
  "Be SELECTIVE: most authors are NOT high-leverage. Do NOT flag generic 'thought leaders', large accounts on follower count alone, or anyone whose headline gives no real signal. When unsure, set vip=false.",
  "The `relationship` object fields:",
  "  - \"vip\": true ONLY for a genuinely high-leverage person, else false.",
  "  - \"reason\": one short sentence on why they're high-leverage, citing the headline signal (e.g. 'YC W24 founder building AI devtools'); \"\" when vip is false.",
  "  - \"tags\": up to 4 lower-kebab-case labels from {\"yc-founder\",\"founder\",\"investor\",\"operator\",\"creator\",\"icp\"}.",
  "  - \"add_to_watchlist\": true when they're worth tracking over time (true for most vips).",
  "  - \"dm_soon\": true when a direct, personal outreach is warranted now (not just a public reply).",
  "Do NOT write the DM itself — a separate Opus step drafts it. Only decide vip / reason / tags / add_to_watchlist / dm_soon.",
  "When vip is false, set `relationship` to {\"vip\": false, \"reason\": \"\", \"tags\": [], \"add_to_watchlist\": false, \"dm_soon\": false}.",
];
const RELATIONSHIP_SCOUT_BLOCK = [
  "RELATIONSHIP SCOUT — in the SAME JSON response, ALSO add a `relationship` object judging whether the post's AUTHOR is a HIGH-LEVERAGE person for the founder to build a relationship with.",
  ...RELATIONSHIP_SCOUT_RULES,
].join(" ");
const RELATIONSHIP_SCOUT_ONLY_SYSTEM = [
  "Judge ONLY whether this LinkedIn author's relationship is high-leverage; do not assess reply quality.",
  ...RELATIONSHIP_SCOUT_RULES,
  "Return STRICT JSON with only a `relationship` object containing vip, reason, tags, add_to_watchlist, and dm_soon.",
].join(" ");

/**
 * Compose the classifier system prompt for an agent instance, appending the
 * operator's objective (agent_instances.objective) when set so the triage is
 * biased toward the founder's actual mission. With no objective, returns
 * BASE_SYSTEM unchanged. When `vipScout` is set, also appends the relationship
 * scout block so the model returns a `relationship` verdict in the same call.
 */
export function buildClassifierSystem(
  objective?: string | null,
  qThreshold = 75,
  vipScout = false,
): string {
  const threshold = [
    BASE_SYSTEM,
    `The reply-worthiness threshold for 'substantial' is q >= ${qThreshold}. A post scoring at or above it should be 'substantial'; below it is 'light' (if a genuine win/launch worth a short note) or 'skip'.`,
  ].join(" ");
  const mission = objective?.trim();
  const withMission = !mission
    ? threshold
    : [
        threshold,
        `The founder's mission for this agent is: "${mission}". Weight your judgement toward it: posts that relate to this mission are more reply-worthy and should score higher; posts unrelated to both this mission and the engageable-founder ICP above score lower. Do not invent relevance — only count a genuine connection.`,
      ].join(" ");
  return vipScout ? [withMission, RELATIONSHIP_SCOUT_BLOCK].join(" ") : withMission;
}

export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassifyOutput>;
  /** Browser reply qualification must never use the legacy model or fail open. */
  classifyObserved(input: ClassifyInput): Promise<ClassifyOutput | null>;
}

export function createClassifier(opts: {
  /** LLM backend — Vertex Gemini in managed prod, Bedrock Claude on self-host. */
  backend: EngineBackend;
  model?: string;
  /** Operator mission (agent_instances.objective) — steers the triage. */
  objective?: string | null;
  /** The substantial threshold woven into the prompt (default 75). */
  qThreshold?: number;
  /**
   * Turn on the relationship scout: the model also flags high-leverage authors
   * and pre-drafts an intro DM, in the same call. The worker passes this from
   * NOELLE_VIP_SCOUT. Off → classifier behaves exactly as before (no vip field).
   */
  vipScout?: boolean;
  /** Injected only by tests; production uses the shared Gateway evaluator. */
  evaluateChoice?: typeof evaluateJevChoice;
  /** Injected only by tests; production uses the shared Gateway evaluator. */
  evaluateBoolean?: typeof evaluateJevBoolean;
}): Classifier {
  const backend = opts.backend;
  const model = opts.model ?? DEFAULT_CLASSIFIER_MODEL;
  const qThreshold = opts.qThreshold ?? 75;
  const system = buildClassifierSystem(opts.objective, qThreshold, opts.vipScout ?? false);
  const evaluateChoice = opts.evaluateChoice ?? evaluateJevChoice;
  const evaluateBoolean = opts.evaluateBoolean ?? evaluateJevBoolean;
  const jevClassify = async (input: ClassifyInput, strict: boolean): Promise<ClassifyOutput | null> => {
    try {
      const result = await evaluateChoice({
        state: JSON.stringify(input),
        instructions: [
          "Classify whether this LinkedIn post deserves a real value-adding founder reply, a short warm supportive reply, or no reply.",
          opts.objective ? `Founder's mission: ${opts.objective}` : "",
          "Judge the post itself; an author's watchlist status cannot override post quality.",
        ].filter(Boolean).join(" "),
        criteria: {
          substantial: "Specific founder, builder, or operator insight, pain, opinion, or genuine question that merits a thoughtful peer reply.",
          light: "A genuine personal win, launch, or milestone that merits a short supportive comment but no substantial reply.",
          skip: "Promo, repost, hiring, news, politics, generic motivation, comment bait, or nothing specific to add.",
        },
      });
      if (result.kind !== "choice") return null;
      const selected = result.choice;
      if (selected !== "substantial" && selected !== "light" && selected !== "skip") return null;
      const probability = result.probabilities[selected];
      if (typeof probability !== "number" || !Number.isFinite(probability)) return null;
      if (!strict && probability < 0.8) return null;
      const q = Math.round((selected === "skip" ? 1 - probability : probability) * 100);
      const belowThreshold = selected !== "skip" && probability * 100 < qThreshold &&
        (strict || selected === "substantial");
      const replyKind = probability < 0.8 || belowThreshold ? "skip" : selected;
      let vip: VipSignal | null = null;
      let usage = { inputTokens: 0, outputTokens: 0 };
      let vipScoutProvider: "jev" | "legacy" | "none" = "none";
      if (opts.vipScout && (!strict || replyKind !== "skip")) {
        let vipDecision: Awaited<ReturnType<typeof evaluateJevBoolean>> = { kind: "unavailable", provider: "jev" };
        try {
          vipDecision = await evaluateBoolean({
            state: JSON.stringify(input),
            instructions: [
              "Is this LinkedIn post's author a high-leverage relationship for the founder? Judge from the author headline and post, not follower count alone.",
              opts.objective ? `Founder's mission: ${opts.objective}` : "",
            ].filter(Boolean).join(" "),
            criteria: {
              true: "Founder, investor, notable builder, or operator whose connection would be unusually valuable for the founder's mission.",
              false: "No concrete evidence of unusually valuable relationship potential, or only generic creator status.",
            },
          });
        } catch { /* A VIP scout outage must not invalidate Jev's reply verdict. */ }
        vipScoutProvider = vipDecision.kind === "confident" ? "jev" : "none";
        if (vipDecision.kind !== "confident" || vipDecision.pass) {
          try {
            const scout = await backend.call({
              system: RELATIONSHIP_SCOUT_ONLY_SYSTEM,
              prompt: JSON.stringify(input),
              model,
            });
            usage = { inputTokens: scout.usage.input_tokens, outputTokens: scout.usage.output_tokens };
            const parsed = z.object({ relationship: VipSignalSchema }).safeParse(extractJson(scout.text));
            if (parsed.success) {
              vip = parsed.data.relationship;
              vipScoutProvider = "legacy";
            }
          } catch (error) {
            if (isBudgetAdmissionError(error)) throw error;
            // Other scout outages leave the independent qualification intact.
          }
        }
      }
      return {
        provider: "jev",
        q,
        reply_kind: replyKind,
        tier: replyKind === "substantial" ? tierForQ(q) : null,
        reason: probability < 0.8 ? "Jev category below confidence floor" :
          belowThreshold ? "Below instance classifier threshold" :
          `Jev selected ${selected}`,
        comment_bait: false,
        vip,
        usage,
        raw: { provider: "jev", choice: selected, probability, probabilities: result.probabilities, vip_scout_provider: vipScoutProvider },
      };
    } catch (error) {
      if (isBudgetAdmissionError(error)) throw error;
      return null;
    }
  };
  return {
    classifyObserved: (input) => jevClassify(input, true),
    async classify(input) {
      const jev = await jevClassify(input, false);
      if (jev) return jev;
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
          provider: "legacy",
          q: parsed.data.q,
          reply_kind: replyKind,
          tier,
          reason: parsed.data.reason,
          comment_bait: parsed.data.comment_bait,
          vip: parsed.data.relationship ?? null,
          usage: callUsage,
          raw: parsed.data,
        };
      } catch (err) {
        if (isBudgetAdmissionError(err)) throw err;
        return failOpen((err as Error).message);
      }
    },
  };
}

/**
 * Parse the model's text into a JSON object. Vertex Gemini, called without a
 * forced JSON mime-type, sometimes wraps the object in a ```json fence or
 * surrounds it with prose, so we strip fences and fall back to the first
 * `{...}` span before giving up. Returns null when nothing parses.
 */
function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  for (const candidate of [unfenced, sliceBraces(unfenced)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  return null;
}

function sliceBraces(s: string): string | null {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

/**
 * Fail-open verdict: when the backend errors or returns garbage, let the lead
 * through as a SUBSTANTIAL T3 (so nothing high-signal is silently lost) but with
 * a NULL score so it's distinguishable from a real zero downstream.
 */
function failOpen(
  reason: string,
  usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
): ClassifyOutput {
  return {
    provider: "legacy-fail-open",
    q: null,
    reply_kind: "substantial",
    tier: "T3",
    reason: `fail-open: ${reason}`,
    // Treat an unscored lead as genuine discussion: never demote a real
    // high-engagement post's comment count off a scoring failure.
    comment_bait: false,
    // No scout verdict on a fail-open — the call gave us nothing to trust.
    vip: null,
    usage,
    raw: { fail_open: reason },
  };
}
