// Reject promises, scheduling, acceptance and resource commitments made on
// the operator's behalf before a draft enters review. Ordinary opinions and
// narration remain eligible.

export type CommitmentKind =
  | "future-action" // "I'll send you…", "I will introduce you…"
  | "scheduling" // "let's hop on a call", "I'm free Thursday"
  | "acceptance" // "count me in", "we're in", "deal"
  | "resource" // "I'll get you access", "we'll cover the cost"
  | "speaking-for" // "the operator says yes", "on behalf of…"
  | "deadline"; // "by Friday", "before the end of the week" — with a promise verb

export interface CommitmentHit {
  kind: CommitmentKind;
  /** The exact substring that tripped the rule, for the skip reason + logs. */
  match: string;
}

/**
 * A first-person promise of a FUTURE ACTION. The subject has to be us and the
 * verb has to be something we would owe them.
 *
 * Note "I'll" / "I will" / "we'll" alone is NOT enough — "I'll be honest",
 * "I'll admit", "I'll never understand this" are all normal voice. The verb
 * list is what makes it a promise.
 */
const FUTURE_ACTION =
  /\b(?:i(?:'| a)?m going to|we(?:'| a)?re going to|i'?ll|i will|we'?ll|we will|happy to|glad to|(?:i|we) can)\s+(?:definitely\s+|gladly\s+|absolutely\s+)?(?:send|share|introduce|intro|connect|forward|email|dm|message|ping|call|set\s?up|schedule|book|arrange|put together|write up|draft|review|look (?:it |this )?over|get back to you|follow up|hop on|jump on|join|attend|speak at|host|sponsor|fund|invest|pay|cover|refund|ship|build|fix|deliver|provide|give you|get you|hook you up|make it happen)\b/i;

/** Proposing or accepting a meeting, call, or time. */
const SCHEDULING =
  /\b(?:let'?s\s+(?:hop|jump|get|set\s?up|schedule|book|do|chat|talk|connect|sync)\b|(?:book|schedule|set\s?up)\s+(?:a\s+)?(?:call|chat|meeting|time|slot|demo)\b|send\s+(?:me\s+)?(?:a\s+)?(?:calendar|cal|invite|link)\b|i'?m\s+free\s+(?:on\s+)?(?:mon|tue|wed|thu|fri|sat|sun|next|this|tomorrow|today)|(?:my\s+)?calendly\b|what time works|does\s+\w+day\s+work)/i;

/** Saying yes on the operator's behalf, or closing a deal. */
const ACCEPTANCE =
  /\b(?:count me in|count us in|i'?m in\b|we'?re in\b|(?:it'?s|we have) a deal\b|deal\b[.!]|sign me up|sign us up|yes,? let'?s do it|let'?s do it\b|i accept\b|we accept\b|agreed,? (?:i|we)'?ll|consider it done|you got it\b|absolutely,? (?:i|we)'?ll)/i;

/** Promising money, access, headcount, or anything else we'd have to provide. */
const RESOURCE =
  /\b(?:(?:i|we)'?(?:ll| will| can)\s+(?:get|give|grant|comp|waive|discount|extend|upgrade)\s+you\b|free (?:access|account|trial|seat|license)\s+(?:for you|on us)|on the house|on us\b|no charge|(?:i|we)'?ll cover\b|my treat)/i;

/** Speaking FOR the operator, or relaying their decision. */
// The green-light / approval clause needs a FIRST-PERSON subject: "I got the
// green light" is us claiming authority we don't have, whereas "they got the
// green light after two years" is ordinary narration about someone else and
// must stay clean.
const SPEAKING_FOR =
  /\b(?:on behalf of\b|speaking for\b|(?:he|she|they|the operator)\s+(?:said|says|confirmed|agreed|approved)\s+(?:yes|it'?s? ok|to)\b|we have a yes\b|(?:i|we)\s+(?:got|have|'?ve got)\s+(?:the\s+)?(?:green ?light|approval|sign-?off)\b|authorized (?:me|us) to)/i;

// Named decision claims follow the same guard without depending on one identity.
// Case-sensitive proper names avoid treating ordinary subjects as names.
const NAMED_DECISION =
  /(?<![\p{L}\p{M}])\p{Lu}[\p{L}\p{M}'’-]*(?:\s+\p{Lu}[\p{L}\p{M}'’-]*){0,3}\s+(?:said|says|confirmed|agreed|approved)\s+(?:yes|it'?s? ok|to)\b/u;

/**
 * A date/time commitment. Only fires ALONGSIDE a promise verb, because "by
 * Friday" in "they shipped it by Friday" is just narration.
 */
const DEADLINE_WINDOW =
  /\b(?:by|before|within|no later than)\s+(?:end of\s+)?(?:the\s+)?(?:eod|eow|today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|next week|this week|the week|\d+\s*(?:hours?|days?|weeks?))\b/i;
const PROMISE_VERB_NEARBY =
  /\b(?:i'?ll|i will|we'?ll|we will|i can|we can|send|ship|deliver|finish|have it|get it|get you|done)\b/i;

const RULES: ReadonlyArray<{ kind: CommitmentKind; re: RegExp }> = [
  { kind: "speaking-for", re: SPEAKING_FOR },
  { kind: "acceptance", re: ACCEPTANCE },
  { kind: "scheduling", re: SCHEDULING },
  { kind: "resource", re: RESOURCE },
  { kind: "future-action", re: FUTURE_ACTION },
];

/**
 * Every commitment the text makes, in rule order. Empty ⇒ the draft is clean.
 *
 * Callers should treat ANY hit as disqualifying rather than trying to weigh
 * them: the cost of a false negative (a promise the operator has to honour or
 * publicly walk back) is far higher than a false positive (one draft skipped,
 * and the lead is still in the inbox for them to answer by hand).
 */
export function detectCommitments(text: string): CommitmentHit[] {
  const body = (text ?? "").trim();
  if (!body) return [];
  // Apostrophe normalization preserves UTF-16 positions for original evidence.
  const matchingBody = body.replace(/[’‘]/g, "'");
  const originalMatch = (m: RegExpExecArray) => body.slice(m.index, m.index + m[0].length).trim();
  const hits: CommitmentHit[] = [];
  for (const { kind, re } of RULES) {
    const m = re.exec(matchingBody) ?? (kind === "speaking-for" ? NAMED_DECISION.exec(matchingBody) : null);
    if (m) hits.push({ kind, match: originalMatch(m) });
  }
  // A deadline only counts when something is being promised into it.
  const deadline = DEADLINE_WINDOW.exec(matchingBody);
  if (deadline && PROMISE_VERB_NEARBY.test(matchingBody)) {
    hits.push({ kind: "deadline", match: originalMatch(deadline) });
  }
  return hits;
}

/** True when the draft binds the operator to anything. */
export function makesCommitment(text: string): boolean {
  return detectCommitments(text).length > 0;
}

/**
 * One-line reason for the skip row / log, e.g.
 * `commitment:scheduling("let's hop on a call")`. Stable shape so the failure
 * is greppable in noelle.leads and the activity tables.
 */
export function commitmentReason(hits: readonly CommitmentHit[]): string {
  if (hits.length === 0) return "";
  const h = hits[0]!;
  return `commitment:${h.kind}(${JSON.stringify(h.match.slice(0, 60))})`;
}

/**
 * The prompt-side rule. Injected into every intern's system prompt so the model
 * is steered as well as fenced — the regex is the backstop, not the plan.
 */
export const NO_COMMITMENTS_RULE = `NEVER COMMIT ANYTHING ON THE OPERATOR'S BEHALF
You are writing as the operator, but you have NO authority to promise, accept, schedule, or agree to anything. This is absolute and outranks being helpful, warm, or closing a conversation cleanly.
- Never promise a future action: no "I'll send you…", "I'll intro you…", "I'll take a look and get back to you", "happy to review it".
- Never propose or accept a call, meeting, or time. No calendar links, no "let's hop on a call", no "what time works".
- Never say yes on their behalf: no "count me in", "we're in", "deal", "consider it done".
- Never promise money, access, discounts, free seats, sponsorship, or investment.
- Never speak FOR the operator to a third party ("he said yes", "we have a yes", "I have approval").
- Never commit to a deadline.
If the person is ASKING for any of those, the correct reply acknowledges them warmly and leaves the decision open for the operator — e.g. react to the substance, or say the operator will want to weigh in themselves. Do NOT invent a yes, and do NOT invent a no. Leaving it unanswered is fine; inventing a commitment is not.`;
