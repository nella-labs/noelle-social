import { ANTI_AI_RULES, scoreFormat, WRITING_STRUCTURE_GUIDANCE } from "@noelle/runtime";
import type { ModelRouting } from "@noelle/runtime";
import type { CodexRunner } from "./codex-runner.js";

// VIP intro DM drafting — Opus, the SAME engine path Lyra's reply drafter rides,
// NOT the classifier's gemini-2.5-flash. The relationship scout (a side-output of
// the cheap classifier call) decides WHO is worth a DM and WHETHER; this module
// writes the actual DM with Opus + a hard anti-slop pass so it reads human, not
// like the old flash one-shot ("Curious: … Would love to hear what you're seeing").

// Routing: primary AND fallback are Bedrock Opus. callAgentModel rewrites the
// PRIMARY to the local `claude -p` subscription when claude-cli is wired
// (NOELLE_CLAUDE_CLI=1, or the org's llm_backend='claude'), so the real chain is
// claude -p (Opus) first, AWS Bedrock Opus on any failure — exactly "use opus,
// claude -p first, aws if it fails". claude-cli is cents=0 and budget-exempt.
const OPUS_MODEL = "claude-opus-4-6";
export const VIP_DM_ROUTING: ModelRouting = {
  primary: { engine: "bedrock", model: OPUS_MODEL },
  fallback: { engine: "bedrock", model: OPUS_MODEL },
};

const SYSTEM_VIP_DM = [
  WRITING_STRUCTURE_GUIDANCE,
  ANTI_AI_RULES,
  "Write on behalf of the operator using the supplied goal and voice context. Do not invent identity or personal history. Write ONE short, first-person intro DM to a person you just found on LinkedIn — someone worth knowing, not a lead to pitch.",
  "Open a real peer-to-peer conversation: reference one specific thing from THEIR post, then either ask one genuine, curious question or propose a low-pressure quick chat. No pitch, no product, no link, no selling.",
  "Voice: plain, warm, direct, the way a real person types a DM. Contractions, one short paragraph, under ~320 characters. A curious peer learning from them — not an authority, not a fan. 'my read is…' over a verdict; never self-diminish to flatter.",
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
  return DM_TELLS.some((re) => re.test(text));
}

/**
 * Draft a VIP intro DM with Opus (claude -p → Bedrock). Returns the clean DM, or
 * null on any failure (budget cap, engine error, empty output) so the caller
 * fails open and simply ships no precomputed DM — the banner still flags the VIP.
 *
 * One regeneration: if the first draft still trips a phrase tell after scrubbing,
 * we ask once more, plainer. A still-rejected second draft is never returned.
 */
export async function draftVipIntroDm(args: {
  runner: Pick<CodexRunner, "draft">;
  orgId: string;
  instanceId: string;
  /** The author's display name / handle, for addressing context. */
  authorName?: string | null;
  /** The author's LinkedIn headline (role/company line), when known. */
  authorHeadline?: string | null;
  postText: string;
  /** The scout's one-line reason this author is high-leverage (context). */
  why?: string | null;
}): Promise<string | null> {
  const base = [
    args.authorName ? `Their name: ${args.authorName}` : null,
    args.authorHeadline ? `Their headline: ${args.authorHeadline}` : null,
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
        agentRole: "linkedin_intern",
        system: SYSTEM_VIP_DM,
        prompt,
      });
      text = res.text;
    } catch {
      return null; // budget/engine failure → fail open, no DM
    }
    const cleaned = scrubDm(text);
    if (!cleaned) continue;
    const voice = scoreFormat({ kind: "dm", angle: null, body: cleaned }, undefined, true, true);
    if (!looksAi(cleaned) && voice.score >= 0.7) return cleaned;
  }
  return null;
}
