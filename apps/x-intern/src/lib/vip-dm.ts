import { ANTI_AI_RULES, scoreFormat, WRITING_STRUCTURE_GUIDANCE, type ModelRouting } from "@noelle/runtime";
import type { CodexRunner } from "./codex-runner.js";

// VIP intro DM drafting uses the shared runtime, like the reply drafter. The
// relationship scout decides WHO is worth a DM and WHETHER; this module writes
// the actual DM with shared writing guidance and a bounded phrase cleanup pass.

// The shared runtime honors NOELLE_CODEX_PRIMARY before this configured route.
// Its organization/backend settings can also rewrite the Bedrock primary to
// Claude CLI; these handles alone do not identify the model that executes.
const OPUS_MODEL = "claude-opus-4-6";
export const VIP_DM_ROUTING: ModelRouting = {
  primary: { engine: "bedrock", model: OPUS_MODEL },
  fallback: { engine: "bedrock", model: OPUS_MODEL },
};

const SYSTEM_VIP_DM = [
  WRITING_STRUCTURE_GUIDANCE,
  ANTI_AI_RULES,
  "Write on behalf of the operator using the supplied goal and voice context. Do not invent identity or personal history. Write ONE short, first-person intro DM to a person you just found on X — someone worth knowing, not a lead to pitch.",
  "Open a real peer-to-peer conversation: reference one specific thing from THEIR post, then either ask one genuine, curious question or propose a low-pressure quick chat. No pitch, no product, no link, no selling.",
  "Voice: plain, warm, direct, the way a real person types a DM. Contractions, lowercase-friendly, one short paragraph, under ~320 characters. Sound like a curious peer — not an authority, not a fan.",
  // These are the exact tells that made the old gemini auto-DMs read as AI. Hard bans:
  "NEVER use an em-dash (—). NEVER open with 'Curious:', 'Love this take', 'I love how', 'This resonates', or 'Hey — '. NEVER close with 'Would love to hear', 'Would love to connect', 'Keen to hear your thoughts', or 'Let me know'. NEVER use negative parallelism ('not X, it's Y'). NEVER use buzzwords (leverage, unlock, resonate, journey, space, align, synergy, dive).",
  "Don't compliment-then-pivot. Just be a real person who read their post and got curious.",
  "Output ONLY the DM text — no quotes, no preamble, no signature.",
].join(" ");

// Post-draft tells. The scrub strips em-dashes deterministically; these catch the
// phrase-level slop the prompt bans, and trigger one plainer regeneration.
const DM_TELLS: RegExp[] = [
  /\bcurious[:,]/i,
  /\blove this take\b/i,
  /\bthis resonates\b/i,
  /\bi love how\b/i,
  /\bwould love to (hear|connect)\b/i,
  /\bkeen to hear\b/i,
  /\b(leverage|unlock|synergy)\b/i,
  /\bresonate(d|s)?\b/i,
  /\bnot just\b[^.?!]{0,40}\bit'?s\b/i,
];

/** Trim, unwrap quotes/preamble, replace em-dashes with commas, single-line it. */
function scrubDm(raw: string): string {
  let t = (raw ?? "").trim();
  // Drop a "Here's a DM:" preamble first, THEN unwrap quotes — the quote often
  // sits inside the preamble wrapper (Here's a DM: "…").
  t = t.replace(/^(here'?s|here is)\b[^:]{0,40}:\s*/i, "").trim();
  t = t.replace(/^["'“”]+|["'“”]+$/g, "").trim();
  // Em-dashes are the #1 tell — replace with a plain comma rather than reject.
  t = t.replace(/\s*—\s*/g, ", ");
  // Collapse newlines/whitespace into one paragraph.
  t = t.replace(/\s+/g, " ").trim();
  return t;
}

function looksAi(text: string): boolean {
  return scoreFormat({ kind: "dm", angle: null, body: text }, undefined, true, true).score < 0.7 || DM_TELLS.some((re) => re.test(text));
}

/**
 * Draft a VIP intro DM through the shared runtime. Returns the clean DM, or
 * null on any failure (budget cap, engine error, empty output) so the caller
 * fails open and simply ships no precomputed DM — the banner still flags the VIP.
 *
 * One regeneration: if the first draft still trips a phrase tell after scrubbing,
 * we ask once more, plainer. If that still fails the shared DM check, return null.
 */
export async function draftVipIntroDm(args: {
  runner: Pick<CodexRunner, "draft">;
  orgId: string;
  instanceId: string;
  authorHandle: string;
  postText: string;
  /** The scout's one-line reason this author is high-leverage (context). */
  why?: string | null;
  followers?: number | null;
}): Promise<string | null> {
  const base = [
    `Their handle: @${args.authorHandle}`,
    args.followers != null ? `Followers: ${args.followers}` : null,
    args.why ? `Why they're worth knowing: ${args.why}` : null,
    "",
    "Their post:",
    (args.postText ?? "").trim(),
  ]
    .filter((l): l is string => l !== null)
    .join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt =
      attempt === 0
        ? base
        : `${base}\n\nThe previous attempt read like AI. Rewrite it plainer and more human: no em-dash, no "Curious:" / "Would love to hear", no buzzwords — just a real, curious DM.`;
    let text: string;
    try {
      const res = await args.runner.draft({
        bucket: "drafter-codex",
        routing: VIP_DM_ROUTING,
        orgId: args.orgId,
        instanceId: args.instanceId,
        worker: "classifier",
        agentRole: "x_intern",
        system: SYSTEM_VIP_DM,
        prompt,
      });
      text = res.text;
    } catch {
      return null; // budget/engine failure → fail open, no DM
    }
    const cleaned = scrubDm(text);
    if (!cleaned) continue;
    if (!looksAi(cleaned)) return cleaned;
  }
  return null;
}
