// Context assembly: the "gather in parallel → distill once" front half of the
// grounded-drafting pipeline. The GATHERING (scoped vault retrieval, the
// watchlist profile, past approved/edited drafts, crowd negatives, an image
// caption) is cheap and deterministic and happens in the worker. This module
// owns the single DISTILL step: one cheap LLM pass that compresses all of those
// raw slices into a compact, high-signal DRAFTING BRIEF.
//
// Why distill: today the drafter gets a raw dump of up-to-8 anchor snippets and
// nothing else. The brief replaces that with a curated block — who you're
// talking to, the voice to match, the *grounded* facts you may assert, what has
// worked before, and what to avoid sounding like — which simultaneously raises
// grounding and CUTS noise. The synthesizer call is injected so this module is
// pure and unit-testable; the worker decides the model/budget and may skip the
// distill entirely (falling back to raw slices) for low-value leads.

export interface GatheredContext {
  /** Rendered watchlist-person profile (who they are / how to engage). */
  personProfile?: string | null;
  /** Voice snippets (tone to match), from the voice-scoped vault retrieval. */
  voiceAnchors?: string[];
  /** Product/positioning facts, from the knowledge-scoped vault retrieval. */
  knowledgeAnchors?: string[];
  /** Past approved/edited drafts to imitate (the self-improvement signal). */
  examples?: string[];
  /** Crowd "slop" comments to differentiate from (negative exemplars). */
  negatives?: string[];
  /** A caption describing the post's image(s), if any. */
  imageCaption?: string | null;
}

export interface DraftingBrief {
  /** One or two lines on who you're replying to (null when not a known person). */
  who: string | null;
  /** Distilled tone/voice notes to match. */
  voiceNotes: string | null;
  /** The ONLY product/offer facts the drafter may assert (grounded). */
  groundedFacts: string[];
  /** Short exemplars of what has worked (approved/edited drafts). */
  examplesThatWorked: string[];
  /** Patterns to avoid sounding like (crowd slop / rejected drafts). */
  avoidLikeThis: string[];
  /** What the post's image shows, in words (null when no image). */
  imageContext: string | null;
}

export type SynthesizerCall = (system: string, prompt: string) => Promise<string>;

/** True when there is anything worth distilling. */
export function hasGatheredContent(g: GatheredContext): boolean {
  return Boolean(
    g.personProfile?.trim() ||
      g.voiceAnchors?.length ||
      g.knowledgeAnchors?.length ||
      g.examples?.length ||
      g.negatives?.length ||
      g.imageCaption?.trim(),
  );
}

const SYNTH_SYSTEM = [
  "You are a research assistant preparing a tight briefing for a writer who is about to draft a social reply.",
  "You are given raw context slices. Compress them into a compact JSON brief — high signal, no padding. Do NOT write the reply; only the brief.",
  "Rules:",
  "- groundedFacts: ONLY facts actually present in the PRODUCT KNOWLEDGE or the POST. Never invent. Empty array if none.",
  "- voiceNotes: 1-2 sentences capturing the tone to match from the VOICE ANCHORS (how they write, not what to say).",
  "- who: 1-2 lines on the person from their PROFILE, or null.",
  "- examplesThatWorked / avoidLikeThis: at most 3 short items each, or empty arrays.",
  "- imageContext: what the image shows in one line, or null.",
  "Output STRICT JSON, no markdown fences, no preamble. First char `{`, last `}`:",
  '  {"who":null,"voiceNotes":null,"groundedFacts":[],"examplesThatWorked":[],"avoidLikeThis":[],"imageContext":null}',
].join("\n");

function renderSynthPrompt(
  g: GatheredContext,
  ctx: { postText: string; platform: string; authorHandle?: string | null },
): string {
  const parts: string[] = [];
  parts.push(`PLATFORM: ${ctx.platform}`);
  parts.push(`POST${ctx.authorHandle ? ` by @${ctx.authorHandle}` : ""}:`, ctx.postText || "(empty)");
  if (g.personProfile?.trim()) parts.push("", "PROFILE:", g.personProfile.trim());
  if (g.voiceAnchors?.length) parts.push("", "VOICE ANCHORS:", ...g.voiceAnchors.map((a, i) => `[${i + 1}] ${a}`));
  if (g.knowledgeAnchors?.length) parts.push("", "PRODUCT KNOWLEDGE:", ...g.knowledgeAnchors.map((a, i) => `[${i + 1}] ${a}`));
  if (g.examples?.length) parts.push("", "PAST DRAFTS THAT WORKED:", ...g.examples.map((a, i) => `[${i + 1}] ${a}`));
  if (g.negatives?.length) parts.push("", "CROWD COMMENTS TO DIFFERENTIATE FROM:", ...g.negatives.map((a, i) => `[${i + 1}] ${a}`));
  if (g.imageCaption?.trim()) parts.push("", "IMAGE:", g.imageCaption.trim());
  parts.push("", "Produce the strict JSON brief now.");
  return parts.join("\n");
}

function asStringArray(v: unknown, max: number): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, max);
}

function parseBrief(text: string): DraftingBrief | null {
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  let obj = tryParse(text.trim());
  if (obj === undefined) {
    const a = text.indexOf("{");
    const b = text.lastIndexOf("}");
    if (a >= 0 && b > a) obj = tryParse(text.slice(a, b + 1));
  }
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  return {
    who: typeof o.who === "string" && o.who.trim() ? o.who.trim() : null,
    voiceNotes: typeof o.voiceNotes === "string" && o.voiceNotes.trim() ? o.voiceNotes.trim() : null,
    groundedFacts: asStringArray(o.groundedFacts, 6),
    examplesThatWorked: asStringArray(o.examplesThatWorked, 3),
    avoidLikeThis: asStringArray(o.avoidLikeThis, 3),
    imageContext: typeof o.imageContext === "string" && o.imageContext.trim() ? o.imageContext.trim() : null,
  };
}

/**
 * Distill gathered context into a compact brief via one cheap LLM call.
 * Returns null (caller falls back to raw slices) when there's nothing to
 * distill or the synthesizer errors / returns unparseable output — fail-open,
 * drafting never blocks on this step.
 */
export async function synthesizeBrief(
  gathered: GatheredContext,
  ctx: { postText: string; platform: string; authorHandle?: string | null },
  call: SynthesizerCall,
): Promise<DraftingBrief | null> {
  if (!hasGatheredContent(gathered)) return null;
  try {
    const raw = await call(SYNTH_SYSTEM, renderSynthPrompt(gathered, ctx));
    return parseBrief(raw);
  } catch {
    return null;
  }
}

/**
 * Render a brief into the prompt block the drafter consumes. Compact and
 * labelled so the model treats grounded facts as the only assertable facts and
 * the negatives as anti-patterns. Returns "" when the brief is empty.
 */
export function renderBriefBlock(brief: DraftingBrief): string {
  const lines: string[] = [];
  if (brief.who) lines.push("WHO YOU'RE REPLYING TO:", brief.who, "");
  if (brief.voiceNotes) lines.push("VOICE TO MATCH:", brief.voiceNotes, "");
  if (brief.groundedFacts.length) {
    lines.push(
      "GROUNDED FACTS (the ONLY product/offer facts you may assert — do not invent beyond these):",
      ...brief.groundedFacts.map((f) => `- ${f}`),
      "",
    );
  }
  if (brief.imageContext) lines.push("THE POST'S IMAGE SHOWS:", brief.imageContext, "");
  if (brief.examplesThatWorked.length) {
    lines.push("REPLIES THAT WORKED BEFORE (match this register, do not copy):", ...brief.examplesThatWorked.map((e) => `- ${e}`), "");
  }
  if (brief.avoidLikeThis.length) {
    lines.push("DO NOT SOUND LIKE THESE (generic / low-effort — stand out from them):", ...brief.avoidLikeThis.map((n) => `- ${n}`), "");
  }
  return lines.join("\n").trimEnd();
}
