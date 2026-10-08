// Route opportunities to the operator, routine acknowledgements to ignore,
// and substantive conversations to drafting. Opportunities take precedence
// over the conversation turn cap.

export type TriageVerdict = "reply" | "pin" | "ignore";

export interface TriageInput {
  /** What they said to us. */
  text: string;
  /** Their handle / public id, for the push body. */
  author?: string | null;
  /** How many turns this conversation has already had from us. */
  priorTurns?: number;
}

export interface TriageDecision {
  verdict: TriageVerdict;
  /** Short machine reason, stored on the lead + shown in the push. */
  reason: string;
}

/**
 * Signals that a human needs to see this personally. Deliberately broad: these
 * are the messages where an agent replying on the operator's behalf is the WRONG
 * outcome even if the reply would be well-written.
 */
const OPPORTUNITY = [
  { re: /\b(?:invest|investor|funding|term sheet|cheque|check size|angel|seed round|pre-?seed)\b/i, why: "investment" },
  { re: /\b(?:acqui(?:re|sition)|buy(?:ing)? (?:you|your company)|m&a)\b/i, why: "acquisition" },
  { re: /\b(?:job|role|position|hiring|recruit(?:ing|ment|er|ers|ed|s)?|interview|offer letter|full-?time|contract(?:or)? work|freelance)\b/i, why: "work-offer" },
  { re: /\b(?:intro(?:duce|duction)?|connect you|put you in touch|refer you)\b/i, why: "intro" },
  { re: /\b(?:speak(?:ing)? at|keynote|panel|podcast|interview you|guest|webinar|conference|summit|meetup)\b/i, why: "speaking" },
  { re: /\b(?:partnership|collaborat(?:e|es|ed|ing|ion|ions|ive|or|ors)|work together|team up|joint)\b/i, why: "partnership" },
  { re: /\b(?:demo|trial|pilot|onboard|pricing|quote|invoice|purchase|buy (?:it|this|nella)|sign up my team)\b/i, why: "sales" },
  { re: /\b(?:accelerator|incubator|y ?combinator|yc\b|fellowship|grant|scholarship|program)\b/i, why: "program" },
  { re: /\b(?:can (?:we|you|i) (?:jump|hop|get) on|call|meeting|chat|coffee|zoom|calendar)\b/i, why: "meeting-request" },
  { re: /\b(?:dm(?:ed|ing)? you|sent you (?:a|an) (?:dm|email|message)|check your (?:dms|inbox|email))\b/i, why: "took-it-private" },
];

/** Messages with nothing to answer. Closing pleasantries and pure reactions. */
const CLOSING =
  /^(?:\s*(?:thanks?|thank you|thx|ty|cheers|congrats|congratulations|agreed|exactly|this|facts|true|same|100%|amen|nice|great|awesome|love (?:it|this)|well said|good (?:one|point|stuff)|👏|🙏|💯|🔥|❤️|😂|💀)[\s!.,:)👏🙏💯🔥❤️😂💀-]*)+$/i;

/** Nothing but emoji / punctuation. */
const NO_WORDS = /^[^\p{L}\p{N}]*$/u;

/**
 * How many turns we're willing to take in one conversation before going quiet.
 * The server-side turn cap already bounds ingest; this is the drafter-side
 * equivalent so a long back-and-forth tapers instead of running to the cap.
 */
export const MAX_CONVERSATION_TURNS = 2;

/**
 * Triage one inbound reply. Pure.
 *
 * Order matters: opportunity beats everything (a short "can we hop on a call?"
 * is both a closing-shaped message AND the single most important kind to
 * escalate), then the turn cap, then the nothing-to-say cases.
 */
export function triageNotification(input: TriageInput): TriageDecision {
  const text = (input.text ?? "").trim();
  if (!text) return { verdict: "ignore", reason: "empty" };

  for (const { re, why } of OPPORTUNITY) {
    if (re.test(text)) return { verdict: "pin", reason: `opportunity:${why}` };
  }

  if ((input.priorTurns ?? 0) >= MAX_CONVERSATION_TURNS) {
    return { verdict: "ignore", reason: "turn-cap" };
  }

  if (NO_WORDS.test(text)) return { verdict: "ignore", reason: "no-words" };
  if (CLOSING.test(text)) return { verdict: "ignore", reason: "closing-pleasantry" };
  // Very short and not a question reads as an acknowledgement, not an opening.
  if (text.length < 25 && !text.includes("?")) {
    return { verdict: "ignore", reason: "too-thin-to-answer" };
  }

  return { verdict: "reply", reason: "worth-answering" };
}

/** The Pushover title + body for a pinned notification. */
export function renderPin(args: {
  platform: "x" | "linkedin";
  author: string | null | undefined;
  text: string;
  reason: string;
}): { title: string; message: string } {
  const who = args.author ? `@${String(args.author).replace(/^@/, "")}` : "someone";
  const what = args.reason.replace(/^opportunity:/, "");
  const body = args.text.length > 320 ? `${args.text.slice(0, 319)}…` : args.text;
  return {
    title: `${args.platform === "x" ? "X" : "LinkedIn"} — ${what} from ${who}`,
    // The operator receives the source message without a draft.
    message: `${body}\n\n(no reply drafted — this one is yours)`,
  };
}
