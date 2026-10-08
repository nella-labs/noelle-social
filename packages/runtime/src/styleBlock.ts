// Account Feeder — the STYLE-block renderer + style-source attribution, shared by
// both interns (Lyra/LinkedIn, Vega/X) via @noelle/runtime so the "STYLE TO
// EMULATE" prompt block and the "Style: …" approval badge are ONE implementation
// (killing the previously hand-mirrored copies). FORM-only: renderStyleBlock
// teaches the drafter to imitate RHYTHM/HOOKS/SENTENCE-SHAPE of high-performing
// human writing — never their content. buildStyleSource turns the chosen
// exemplars into the per-draft blend the approval card renders (counts → weights).

import type { OutboundIn } from "@noelle/contracts";
import type { PostRegister } from "./styleTypes.js";
import type { FormVariantForPrompt } from "./formVariants.js";
import { corpusEngagement } from "./accountCorpusMetrics.js";

/** One chosen style exemplar as the prompt renders it (mirrors StyleExemplar). */
export interface StyleExemplarForPrompt {
  body: string;
  accountHandle: string;
  likeCount: number | null;
  commentCount: number | null;
}

/** The per-lead STYLE selection the drafter threads into buildDrafterSystem. */
export interface StyleForPrompt {
  exemplars: StyleExemplarForPrompt[];
  /** Prose style notes (voice/tone/structure/hooks/phrases) of the matched accounts. */
  styleNotes: string;
  /**
   * Per-reply SHAPE assignment (form-variant rotation, see formVariants.ts).
   * When set, the FAITHFUL block renders this variant's directive in place of
   * the fixed hook-then-line recipe, so consecutive replies vary in length and
   * structure. Omitted ⇒ the block is byte-identical to before.
   */
  formVariant?: FormVariantForPrompt;
}

/**
 * Render the "STYLE TO EMULATE" SYSTEM block from a per-lead style selection, or
 * "" when there's nothing to render. The block is CONDITIONED on the post's
 * register:
 *   - celebration → instruct a BLEND: one specific reaction in the operator's
 *     voice + the warm, hyped energy of the exemplars (a win deserves cheer).
 *   - neutral → borrow rhythm/phrasing only; forbid forced cheer/exclamations on
 *     an analytical post (that reads fake).
 *   - omitted → the legacy generic FORM-only block (byte-identical to before).
 * In every case it stays FORM-only: never borrow content/topics, never fabricate.
 *
 * FAITHFUL mode (`faithful === true`): the operator PINNED this exact writer, so
 * postRegister is ignored and the block instructs the drafter to genuinely ADOPT
 * the pinned writer's VOICE (openings, casing, asides, cadence, warmth/hype when
 * that's how they write) — not the faint FORM-only echo of the blend paths. Still
 * FORM-not-content: react only to the actual post, never copy their words/topics,
 * never fabricate. Scoped to the pinned path; the blend/register paths are
 * byte-identical to before.
 */
export function renderStyleBlock(
  style: StyleForPrompt,
  postRegister?: PostRegister,
  faithful?: boolean,
): string {
  const exemplars = style.exemplars.filter((e) => e.body.trim().length > 0);
  const notes = style.styleNotes.trim();
  if (exemplars.length === 0 && notes.length === 0) return "";
  const measured = exemplars.every(e => corpusEngagement(e.likeCount, e.commentCount) !== null);
  const description = measured ? "high-performing" : "saved";
  const lines: string[] = faithful
    ? [
        "WRITE THIS REPLY IN THE VOICE OF THE WRITER BELOW (the operator hand-picked this exact person — sound like them, not a generic commenter)",
        style.formVariant
          ? // Form-variant rotation: the assigned SHAPE replaces the fixed
            // hook-then-line recipe so the feed stops converging on one skeleton.
            // Voice evidence stays authoritative; the shape changes only length/form.
            `The examples below are that writer's OWN writing — copy their VOICE, not their content, as actually shown in their examples and style notes. Match only evidenced habits: their casing, punctuation, cadence, brevity, warmth, and intensity. Do not add a parenthetical, punctuation tic, casing pattern, or hype level unless the evidence supports it. THIS REPLY'S ASSIGNED SHAPE controls length and beat structure only (comments only, NEVER the DM). If its wording names casing, punctuation, a parenthetical, slang, or emotional intensity, writer evidence wins and you must ignore that voice detail unless the examples support it: ${style.formVariant.directive}`
          : "The examples below are that writer's OWN writing — copy their VOICE and SHAPE, not their content, as actually shown in their examples and style notes. Match only evidenced habits: their casing, punctuation, cadence, brevity, warmth, and intensity. Do not add a parenthetical, punctuation tic, casing pattern, or hype level unless the evidence supports it. Write like this person, not a generic professional commenter.",
        `CRITICAL — do not plagiarize them: the examples are about THEIR life and THEIR topics, not yours. NEVER reuse their opening lines, hooks, phrases, or sentences, and never open with a line that only makes sense for them (e.g. do not write "i made a lot of people cry today" — that was their post, not yours). ${style.formVariant?.allowStandaloneReaction ? "Your reply must fit the ACTUAL post's moment and energy. Do not pad a brief reaction with an explanation merely because the same words could fit another post." : "Your reply must react to the ACTUAL post above and must make no sense if pasted under any other post."} Borrow their VOICE and SHAPE as evidenced, never their content.`,
        style.formVariant
          ? "Stick to the assigned shape's length exactly (comments only — a DM keeps its own length rules). No em dashes, no corporate/LinkedIn buzzwords, only emoji if the post itself used emoji (allowlist only), and never fabricate a story, number, or credential."
          : "Keep it tight: one or two short sentences. Let the examples determine the exact shape; do not force a hook or aside. No em dashes, no corporate/LinkedIn buzzwords, only emoji if the post itself used emoji (allowlist only), and never fabricate a story, number, or credential.",
      ]
    : postRegister === "celebration"
      ? [
          "STYLE TO EMULATE (this post is CELEBRATING / ANNOUNCING something — match the writer's WARM, HYPED energy)",
          "This post is a win, launch, or happy announcement. The right reply BLENDS two things: (1) ONE genuine, specific reaction in your own voice (name the actual thing they did), AND (2) the warm, excited, happy-for-them ENERGY of the exemplars below: short, warm, exclamation-friendly, visibly happy. THIS is the one context where matching their excitement is correct, so be a friend who is hyped for them, not a measured analyst. Do NOT borrow the exemplars' content, topics, or specifics, never fabricate a story or number, and keep every length/format/NEVER-DO rule above (no em dashes, no corporate verbs, the emoji allowlist) intact.",
        ]
      : postRegister === "neutral"
        ? [
            `STYLE TO EMULATE (${description} human writing — match the FORM, not the content)`,
            "This post is analytical, an opinion, or a question, NOT a celebration. Borrow ONLY the rhythm, sentence-shape, hooks, and phrasing of the exemplars below, and keep your own substantive, specific take. Do NOT add cheering, hype, exclamation bursts, or emoji the post did not invite, because forced excitement on a serious post reads fake. Do NOT borrow their content, topics, opinions, or specifics: write about THIS post only, in the operator's own voice, and never fabricate a story, a number, or a phrase just to match the style. Keep every length, format, and NEVER-DO rule above intact.",
          ]
        : [
            `STYLE TO EMULATE (${description} human writing — match the FORM, not the content)`,
            `Below are real, ${description} comments from writers whose STYLE the operator admires. Match the FORM of this writing — the rhythm, the hooks, how sentences are shaped, the tone, the way they open and land a line. Do NOT borrow their content, topics, opinions, claims, or specifics: write about THIS post only, in the operator's own voice. Treat them as a register to echo, never as material to quote or paraphrase. Obey ALL length, format, and NEVER-DO rules above (this block changes FORM, not length — keep comments tight). Never fabricate a story, a number, or a phrase just to match the style.`,
          ];
  if (exemplars.length > 0) {
    lines.push("", `${measured ? "High-performing" : "Saved"} exemplars (FORM only — do NOT reuse their words or topics):`);
    exemplars.forEach((e, i) => {
      const eng = corpusEngagement(e.likeCount, e.commentCount);
      const engNote = eng === null ? " (engagement unknown)" : ` (${eng} engagements)`;
      const text = e.body.length > 320 ? `${e.body.slice(0, 317)}…` : e.body;
      lines.push(`[${i + 1}]${engNote} "${text}"`);
    });
  }
  if (notes.length > 0) {
    lines.push("", "Style notes distilled from these writers (apply to FORM only):", notes);
  }
  return lines.join("\n");
}

/**
 * Derive the lead-level style-source blend (Account Feeder) for the approval UI
 * from the exemplars the selector chose. Each contributing account's weight is
 * its share of the chosen exemplars (counts → fractions, sorted desc, rounded to
 * 2dp). A null/empty selection ⇒ null (base voice only — no badge).
 */
export function buildStyleSource(style: StyleForPrompt | null | undefined): OutboundIn["styleSource"] {
  const exemplars = style?.exemplars ?? [];
  if (exemplars.length === 0) return null;
  const counts = new Map<string, number>();
  for (const e of exemplars) {
    const h = e.accountHandle?.trim();
    if (!h) continue;
    counts.set(h, (counts.get(h) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const blend = [...counts.entries()]
    .map(([handle, n]) => ({ handle, weight: Math.round((n / total) * 100) / 100 }))
    .sort((a, b) => b.weight - a.weight || a.handle.localeCompare(b.handle))
    .slice(0, 8);
  return { blend };
}
