import { z } from "zod";
import { isBudgetAdmissionError, evaluateJevChoice, type EngineBackend } from "@noelle/runtime";
import { VipSignalSchema, type VipSignal } from "@noelle/contracts";

// Gemini classifier. Cheap, blocks off-brand posts BEFORE the drafter spends
// on a full reply. Backend-agnostic: the worker injects an `EngineBackend` —
// Vertex AI Gemini via ADC (`createVertexBackend`, the Noelle-billed default,
// on the GenAI App Builder trial credit) when the org has no key of its own,
// or a per-org Google AI Studio key backend (`createGeminiKeyBackend`) when
// the org brought its own key so usage bills their account.
//
// Fail-open philosophy is unchanged: the classifier is a cost-saver, not a
// hard gate, so a backend error lets the lead through as on_brand. What
// changed from the original AI-Studio-only engine: on failure we no longer
// fabricate a score. `velocity_score` comes back `null` so an unscored lead
// is honestly distinguishable from a genuine zero downstream (the worker
// writes NULL to noelle.leads.classifier_score, never a fake 0).

const ClassifierOutput = z.object({
  on_brand: z.boolean(),
  on_brand_reason: z.string(),
  kind: z.string(),
  velocity_score: z.number().int().min(0).max(100),
  /**
   * REPLY-WORTHINESS (0-100): how much this post deserves a real reply. This is
   * the signal the drafter's quality gate should grade on. `velocity_score`
   * above is a VIRALITY proxy (predicted 15-min engagement) — a different
   * question entirely, and systematically low (live p50 0.20), so gating on it
   * conflated "will this blow up" with "should we answer it". Optional so an
   * older prompt / fail-open path still parses.
   */
  // .catch(undefined) is load-bearing, not defensive noise: these three fields
  // are ADDITIVE, so a malformed value in any of them must not discard the whole
  // verdict. Without it, `q: null` or `reply_kind: "Light"` fails safeParse for
  // the entire object, which routes to failOpen() — and failOpen returns
  // on_brand:true, so a model typo would INVERT a genuine off-brand/ai_slop
  // verdict into an on-brand one. Now a bad field degrades to "absent" and the
  // rest of the classification survives.
  q: z.number().int().min(0).max(100).nullish().catch(undefined),
  /**
   * Three-way routing, matching Lyra and Orion: a substantial reply, a SHORT
   * warm one, or nothing. Vega previously had only "draft it or drop it".
   */
  reply_kind: z.enum(["substantial", "light", "skip"]).nullish().catch(undefined),
  /**
   * Engagement-bait: a post farming low-value comments via a call-to-action.
   * Its comment count is inflated and must NOT be read as real discussion when
   * deciding whether to escalate to a smarter model.
   */
  comment_bait: z.boolean().nullish().catch(undefined),
  tier: z.enum(["T1", "T2", "T3"]).nullable().optional(),
  // LLM's own AI-slop judgement. Optional — older prompts / fail-open paths omit
  // it. The authoritative slop signal is the deterministic detector in
  // ai-slop.ts; this is defence in depth (the worker drops on either).
  ai_slop: z.boolean().optional(),
  ai_slop_reason: z.string().optional(),
  /**
   * Relationship-scout verdict (only present when the scout is enabled). Judges
   * whether the post's author is a high-leverage person to build a relationship
   * with and, if so, pre-drafts a genuine intro DM. Optional so a scout-off run
   * (or a model that omits it) still parses. Reuses the shared VipSignalSchema so
   * the wire shape matches noelle.leads.vip_signal exactly.
   */
  relationship: VipSignalSchema.optional(),
});

export interface ClassifyInput {
  postText: string;
  authorHandle: string;
  source: "x" | "linkedin" | "reddit";
  velocityAtDiscovery: number;
  /** Author follower count, or null when unknown. Steers the LLM's strictness. */
  authorFollowers?: number | null;
}

export interface ClassifyOutput {
  on_brand: boolean;
  on_brand_reason: string;
  kind: string;
  /** 0-100 engagement-velocity estimate, or null when scoring failed. */
  velocity_score: number | null;
  /**
   * 0-100 REPLY-WORTHINESS, or null when scoring failed. This is what the
   * drafter's quality gate grades on; velocity_score stays for observability.
   */
  q: number | null;
  /** substantial | light | skip. 'substantial' on every fail-open path. */
  reply_kind: "substantial" | "light" | "skip";
  /** True when the post farms comments via a CTA (inflated comment count). */
  comment_bait: boolean;
  tier: "T1" | "T2" | "T3" | null;
  /** LLM's own AI-slop verdict (false on fail-open / when the prompt omitted it). */
  ai_slop: boolean;
  ai_slop_reason: string | null;
  /**
   * Relationship-scout verdict, or null when the scout was off / failed / the
   * model omitted it. Persisted to noelle.leads.vip_signal so the approvals page
   * can flag high-leverage authors and surface a precomputed intro DM.
   */
  vip: VipSignal | null;
  /**
   * Token usage for the backend call, so the worker can record the Gemini
   * spend. Zero on every fail-open path (backend error / unparseable / schema
   * miss) — those cost nothing billable, so the worker records no spend.
   */
  usage: { inputTokens: number; outputTokens: number };
  raw: unknown;
}

/**
 * Default Vertex Gemini handle. Dashed form — `createVertexBackend` maps it
 * to the dotted `gemini-2.5-flash` the Vertex API expects.
 */
export const DEFAULT_CLASSIFIER_MODEL = "gemini-2-5-flash";

/**
 * Map a `q` score to a tier band for a SUBSTANTIAL lead. Only meaningful when
 * `reply_kind === 'substantial'`; light/skip leads carry a null tier. Same bands
 * as Lyra and Orion so a tier means the same thing across all three interns.
 */
export function tierForQ(q: number): "T1" | "T2" | "T3" {
  if (q >= 90) return "T1";
  if (q >= 80) return "T2";
  return "T3";
}

const BASE_SYSTEM = [
  "You triage X posts for an indie AI agent product (Noelle).",
  "On-brand means the post is from an ICP-like persona (builder, founder, indie dev, ai-tooling enthusiast) AND the post asks a question, shares a pain, or expresses curiosity that a thoughtful reply could help.",
  "Off-brand: pure shitposts, politics, news, replies to threads, retweets, marketing/promo, OnlyFans, etc.",
  // AI-slop filter: posts that read as machine-written are off-brand, not worth a reply.
  "AI SLOP: a post is ai_slop=true when it reads like LLM output — em-dash over-use; negative parallelism / reframes ('it's not X, it's Y', 'X is dead, Y is the future'); hype/buzzword vocab (seamless, robust, leverage, unlock, supercharge, game-changer, cutting-edge, frictionless, paradigm, delve, elevate, empower); emoji used as section bullets in a launch post; engagement bait ('let that sink in', 'building in public'); rule-of-three packaging; empty significance inflation. A single buzzword is NOT slop — it takes a combination. When ai_slop=true, also set on_brand=false.",
  // Follower floor: smaller accounts must clear a higher bar.
  "FOLLOWERS: the input may include authorFollowers. Grade low-follower authors more strictly — under ~100 followers is almost never worth a reply (off-brand unless exceptional); 100-1000 needs genuinely strong signal; 1000+ can score normally. Unknown/null followers: judge on content alone.",
  // REPLY-WORTHINESS. Distinct from velocity: velocity predicts whether the POST
  // will blow up, q asks whether WE should answer it. Gating on velocity meant a
  // quiet, perfectly answerable question from an ICP founder scored low.
  "SCORE q (0-100): how reply-worthy is this post for a genuine, value-adding reply from a peer founder? This is NOT the same question as velocity_score — a quiet post from exactly the right person can be highly reply-worthy while never going viral. 90-100 = exceptional, must engage; 80-89 = strong; 60-79 = worth a real reply; 35-59 = thin but maybe a short supportive note; under 35 = skip.",
  "REPLY_KIND — choose exactly one:",
  "  - 'substantial' when q justifies a real, specific reply. Set tier by band: q>=90 → T1, 80-89 → T2, otherwise T3.",
  "  - 'light' when the post is NOT substantial-grade but is still worth a SHORT, warm reaction — a ship, a launch, a milestone, a personal win, the kind of post you answer with a brief genuine 'congrats' or a one-line reaction. Set tier=null.",
  "  - 'skip' otherwise (off-brand, pure promo, news, engagement-bait, AI slop, nothing real to add). Set tier=null.",
  "Be strict: when torn between 'substantial' and 'light', pick 'light'. When torn between 'light' and 'skip', pick 'light' only if it is a genuine personal win from a real person; promo or fog is 'skip'.",
  "COMMENT_BAIT — true ONLY when the post farms comments via a call-to-action: 'comment WORD below', 'drop your handle', 'reply to get X', giveaways, 'tag 3 people'. These inflate the reply count with junk. A post that simply asks a genuine question is NOT bait. When unsure, false.",
  "Return strict JSON: {on_brand, on_brand_reason, kind, velocity_score, q, reply_kind, tier, comment_bait, ai_slop, ai_slop_reason} where kind ∈ {question,pain,launch,thought,promo,news,reply,other}, velocity_score 0-100 (estimated 15-min engagement velocity), q 0-100 (reply-worthiness), reply_kind ∈ {substantial,light,skip}, tier T1=high signal T2=mid T3=low or null, comment_bait boolean, ai_slop boolean, ai_slop_reason short string.",
].join(" ");

// Appended to the classifier system prompt when the relationship scout is on.
// Adds a `relationship` key to the SAME JSON object (no extra LLM call), judging
// whether the post's author is a high-leverage person to build a relationship
// with. It decides WHO is worth a DM and WHETHER — it does NOT write the DM. The
// actual intro DM is drafted afterward with Opus (claude -p → Bedrock) in
// lib/vip-dm.ts, because a DM written here would inherit this cheap gemini-flash
// call's house style and read as AI ("Curious: … Would love to hear …").
const RELATIONSHIP_SCOUT_BLOCK = [
  "RELATIONSHIP SCOUT — in the SAME JSON response, ALSO add a `relationship` object judging whether the post's AUTHOR is a HIGH-LEVERAGE person for the founder to build a relationship with.",
  "High-leverage = someone in the founder's ICP, a founder/CEO/builder of a notable or venture-backed company (e.g. a YC founder), an investor/VC/angel, or a respected operator/creator in the space — anyone whose connection would be unusually impactful. Judge from the author's handle, follower count, and the substance of the post.",
  "Be SELECTIVE: most authors are NOT high-leverage. Do NOT flag generic accounts, large follower counts alone, or anyone the post gives no real signal about. When unsure, set vip=false.",
  "The `relationship` object fields:",
  "  - \"vip\": true ONLY for a genuinely high-leverage person, else false.",
  "  - \"reason\": one short sentence on why they're high-leverage (e.g. 'YC founder building AI devtools'); \"\" when vip is false.",
  "  - \"tags\": up to 4 lower-kebab-case labels from {\"yc-founder\",\"founder\",\"investor\",\"operator\",\"creator\",\"icp\"}.",
  "  - \"add_to_watchlist\": true when they're worth tracking over time (true for most vips).",
  "  - \"dm_soon\": true when a direct, personal outreach is warranted now (not just a public reply).",
  "Do NOT write the DM itself — a separate Opus step drafts it. Only decide vip / reason / tags / add_to_watchlist / dm_soon.",
  "When vip is false, return {\"vip\": false, \"reason\": \"\", \"tags\": [], \"add_to_watchlist\": false, \"dm_soon\": false}.",
].join(" ");

/**
 * Compose the classifier system prompt for an agent instance.
 *
 * When the operator set a custom objective (agent_instances.objective), we
 * append it so the triage is biased toward the founder's actual mission: a
 * post that matches the mission should read as on-brand and score higher; a
 * post unrelated to both the mission and the ICP stays off-brand. With no
 * custom objective we return BASE_SYSTEM unchanged. When `vipScout` is set, also
 * appends the relationship scout block so the model returns a `relationship`
 * verdict in the same call.
 */
export function buildClassifierSystem(
  objective?: string | null,
  vipScout = false,
): string {
  const mission = objective?.trim();
  const withMission = !mission
    ? BASE_SYSTEM
    : [
        BASE_SYSTEM,
        `The founder's mission for this agent is: "${mission}". Weight your judgement toward it: posts that relate to this mission are on-brand and should score higher; posts unrelated to both this mission and the ICP above are off-brand. Do not invent relevance — only count a genuine connection.`,
      ].join(" ");
  return vipScout ? [withMission, RELATIONSHIP_SCOUT_BLOCK].join(" ") : withMission;
}

export interface Classifier {
  classify(input: ClassifyInput): Promise<ClassifyOutput>;
  /** Browser observations require Jev alone; null means retry after an outage. */
  classifyObserved(input: ClassifyInput, threshold: number): Promise<ClassifyOutput | null>;
  /**
   * Classify a whole claimed batch in ONE model call. A `null` verdict means
   * that lead was not covered and the caller should fall back to `classify`.
   */
  classifyMany(inputs: ClassifyInput[]): Promise<BatchClassifyResult>;
}

/**
 * Build a ClassifyOutput from validated model data. Shared by the single-lead
 * and batched paths so a batched verdict is normalised EXACTLY like a solo one
 * — the slop-forces-off-brand rule and the recomputed tier band in particular.
 */
function buildVerdict(
  data: z.infer<typeof ClassifierOutput>,
  callUsage: { inputTokens: number; outputTokens: number },
): ClassifyOutput {
  const aiSlop = data.ai_slop ?? false;
  // An off-brand or slop verdict is a skip regardless of what reply_kind
  // the model returned; otherwise honour it, defaulting to 'substantial'
  // for an older prompt that omits the field (fail-open, as before).
  const replyKind: "substantial" | "light" | "skip" =
    !data.on_brand || aiSlop ? "skip" : (data.reply_kind ?? "substantial");
  return {
    // The LLM's slop verdict also forces off-brand, mirroring the system
    // prompt's instruction (belt-and-suspenders if the model forgets).
    on_brand: data.on_brand && !aiSlop,
    on_brand_reason: data.on_brand_reason,
    kind: data.kind,
    velocity_score: data.velocity_score,
    // Reply-worthiness. An older prompt omits it; fall back to velocity so
    // the gate still has a number rather than silently dropping to null.
    q: data.q ?? data.velocity_score,
    reply_kind: replyKind,
    comment_bait: data.comment_bait ?? false,
    // Normalise the tier to the kind: only a SUBSTANTIAL lead carries one,
    // and its band is recomputed from q rather than trusted, so a model
    // that tiers a light lead or picks the wrong band cannot leak through.
    tier: replyKind === "substantial" ? tierForQ(data.q ?? data.velocity_score) : null,
    ai_slop: aiSlop,
    ai_slop_reason: data.ai_slop_reason ?? null,
    vip: data.relationship ?? null,
    usage: callUsage,
    raw: data,
  };
}

/**
 * Appended to the system prompt for a batched call. Every `claude -p` spawn
 * pays a fixed toll — ~2,000 tokens of CLI scaffolding plus this prompt —
 * before it reads a single lead. Measured on 20 real leads, one spawn per lead
 * cost 58,900 input tokens; ten leads per spawn cost 9,529 for the same work,
 * and agreement with production verdicts did not drop.
 *
 * The independence sentence is load-bearing: without it the model drifts toward
 * grading the set relative to itself rather than against the ICP.
 */
const BATCH_SUFFIX = `

BATCH MODE: the user message is a JSON ARRAY of posts, each with an "id".
Return a JSON ARRAY with one verdict object per input, each carrying the same
"id", and nothing else. Judge every post independently, exactly as if it had
arrived alone. Do not let one post's verdict influence another's.`;

/** Parse the model's text into a JSON array, tolerating fences and prose. */
function extractJsonArray(text: string): unknown[] | null {
  const fenced = text.replace(/```(?:json)?/gi, "");
  const start = fenced.indexOf("[");
  const end = fenced.lastIndexOf("]");
  if (start < 0 || end <= start) return null;
  try {
    const v: unknown = JSON.parse(fenced.slice(start, end + 1));
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

export type BatchClassifyResult = {
  /** One entry per input, in order. `null` ⇒ the batch did not cover that lead. */
  verdicts: Array<ClassifyOutput | null>;
  /** Usage for the ONE underlying call, to be recorded once by the caller. */
  usage: { inputTokens: number; outputTokens: number };
};

export function createClassifier(opts: {
  /** LLM backend — the Vertex Gemini backend in production. */
  backend: EngineBackend;
  model?: string;
  /** Operator mission (agent_instances.objective) — steers the triage. */
  objective?: string | null;
  /**
   * Turn on the relationship scout: the model also flags high-leverage authors
   * and pre-drafts an intro DM, in the same call. The worker passes this from
   * NOELLE_VIP_SCOUT. Off → classifier behaves exactly as before (no vip field).
   */
  vipScout?: boolean;
  evaluate?: typeof evaluateJevChoice;
}): Classifier {
  const backend = opts.backend;
  const model = opts.model ?? DEFAULT_CLASSIFIER_MODEL;
  const system = buildClassifierSystem(opts.objective, opts.vipScout ?? false);
  async function jevVerdict(
    input: ClassifyInput,
    strict = false,
    threshold = 75,
  ): Promise<ClassifyOutput | null> {
    try {
      const decision = await (opts.evaluate ?? evaluateJevChoice)({
        state: JSON.stringify({ ...input, objective: opts.objective ?? null }),
        instructions: "Classify this X post for a peer founder who replies only when it can add real value.",
        criteria: {
          substantial: "A genuine question, pain, or thought from a relevant builder that merits a useful specific reply.",
          light: "A genuine personal launch or win from a relevant person that merits a brief warm reaction.",
          skip: "Off-topic, generic promotion, engagement bait, news, AI slop, or nothing meaningful to add.",
        },
      });
      if (decision.kind !== "choice") return null;
      const { choice } = decision;
      const probability = decision.probability;
      if ((choice !== "substantial" && choice !== "light" && choice !== "skip") ||
          typeof probability !== "number" || !Number.isFinite(probability) ||
          probability < 0 || probability > 1) return null;
      if (!strict && probability < 0.8) return null;
      const qualified = choice !== "skip" && probability * 100 >= threshold;
      const replyKind = strict && !qualified ? "skip" : choice;
      const q = strict
        ? Math.round((choice === "skip" ? 1 - probability : probability) * 100)
        : choice === "substantial" ? Math.round(probability * 100) : choice === "light" ? 50 : 0;
      return {
        on_brand: replyKind !== "skip",
        on_brand_reason: strict && !qualified ? "Jev category below qualification floor or skipped" :
          `Jev classified this post as ${choice}`,
        kind: "other",
        velocity_score: null,
        q,
        reply_kind: replyKind,
        comment_bait: false,
        tier: replyKind === "substantial" ? tierForQ(q) : null,
        ai_slop: false,
        ai_slop_reason: null,
        vip: null,
        usage: { inputTokens: 0, outputTokens: 0 },
        raw: { judge: "jev", choice, probability, ...(strict ? { threshold } : {}) },
      };
    } catch {
      return null;
    }
  }
  async function legacyVerdict(input: ClassifyInput): Promise<ClassifyOutput> {
    try {
      const { text, usage } = await backend.call({ system, prompt: JSON.stringify(input), model });
      const callUsage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
      const obj = extractJson(text);
      if (obj == null) return failOpen("unparseable", callUsage);
      const parsed = ClassifierOutput.safeParse(obj);
      if (!parsed.success) return failOpen("schema", callUsage);
      const verdict = buildVerdict(parsed.data, callUsage);
      return { ...verdict, raw: { ...parsed.data, judge: "legacy" } };
    } catch (err) {
      if (isBudgetAdmissionError(err)) throw err;
      return failOpen((err as Error).message);
    }
  }
  return {
    classifyObserved: (input, threshold) => jevVerdict(input, true, threshold),
    async classify(input) {
      const jev = await jevVerdict(input);
      if (!jev) return legacyVerdict(input);
      if (!opts.vipScout) return jev;
      // The existing classifier still supplies the relationship scout's rich
      // metadata. Jev remains authoritative for whether this post is answered.
      const scout = await legacyVerdict(input);
      return {
        ...jev,
        vip: scout.vip,
        usage: scout.usage,
        raw: { ...(jev.raw as Record<string, unknown>), relationship: scout.vip },
      };
    },

    async classifyMany(inputs) {
      if (inputs.length === 0) return { verdicts: [], usage: { inputTokens: 0, outputTokens: 0 } };
      const jev = await Promise.all(inputs.map((input) => jevVerdict(input)));
      const legacyIndices = inputs.flatMap((_, i) => opts.vipScout || !jev[i] ? [i] : []);
      if (legacyIndices.length === 0) {
        return { verdicts: jev, usage: { inputTokens: 0, outputTokens: 0 } };
      }
      const legacyInputs = legacyIndices.map((i) => inputs[i]!);
      const combine = (legacy: Array<ClassifyOutput | null>, usage: BatchClassifyResult["usage"]): BatchClassifyResult => {
        const verdicts = [...jev];
        legacyIndices.forEach((original, local) => {
          const old = legacy[local] ?? null;
          const primary = verdicts[original];
          verdicts[original] = primary && opts.vipScout
            ? { ...primary, vip: old?.vip ?? null, raw: { ...(primary.raw as Record<string, unknown>), relationship: old?.vip ?? null } }
            : primary ?? old;
        });
        return { verdicts, usage };
      };
      try {
        const { text, usage } = await backend.call({
          system: system + BATCH_SUFFIX,
          prompt: JSON.stringify(legacyInputs.map((input, id) => ({ id, ...input }))),
