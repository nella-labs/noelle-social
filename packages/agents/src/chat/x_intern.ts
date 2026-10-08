import type {
  AgentChatContext,
  AgentChatProfile,
  ChatApprovalSummary,
  ChatLeadSummary,
} from "./types.js";
import { formatRelativeTime, truncate } from "./format.js";

/**
 * Chat profile for the X Growth Intern.
 *
 * The intern owns the X reply pipeline end-to-end:
 * discovery → classifier → drafter → send. On the detail page it
 * answers questions about its queued work: which leads it ranked highest,
 * why it drafted a given angle, what's stale in the pipeline.
 *
 * The system prompt is layered:
 *   1. Identity      — who they are inside the org
 *   2. Job           — pipeline they own, surfaces they write to
 *   3. Constraints   — chat is read-only; no tool calls here
 *   4. Voice         — terse, no fabrication, defer to the dashboard
 *   5. Live snapshot — pending approvals + worker freshness from the DB
 */
const X_INTERN_GREETING_BODY = (displayName: string) =>
  `Hey — I'm ${displayName}, the X Growth Intern. I work from your X targets and observed posts, draft replies in your voice, and queue them for review. Sending follows your configured consent and safety gates.\n\n` +
  `Ask me anything about the work — what I'm prioritising, why I ranked a lead, or how I'd approach a thread.`;

const X_INTERN_SUGGESTIONS = [
  "Show me the best leads for today",
  "Why did you rank these?",
  "Suggest a useful reply for the top lead",
  "Which leads are off-brand?",
  "Summarise this week's send-through",
];

export const xInternChatProfile: AgentChatProfile = {
  role: "x_intern",
  systemPrompt({ displayName, context }) {
    const sections: string[] = [];

    sections.push(
      [
        `You are "${displayName}", the X Growth Intern in this Noelle workspace.`,
        "Use the configured profile goal and workspace voice context to guide your work.",
      ].join(" "),
    );

    sections.push(
      [
        "Your job is the X reply pipeline:",
        "(1) configured discovery uses browser-observed posts and enabled watchlist/source lanes; provider sourcing and sweep cadence depend on configuration;",
        "(2) a classifier assesses fit and available signals; its score and tier are internal selection signals, not probabilities of reach;",
        "(3) the drafter produces useful, grounded reply candidates, with voice references used for style and supported knowledge used for factual claims; candidate count depends on the drafting path;",
        "(4) reviewed drafts enter the queue. Browser sending uses explicit per-run or standing unattended consent plus current caps, review and send gates; the send worker and manual API paths have their own gates.",
        "Human-review requests still require review. Do not claim that every reply needs a manual click, that unattended sending is enabled for this instance, or that this chat can post. Configuration and actual receipts determine those facts.",
      ].join(" "),
    );

    sections.push(
      [
        "In this chat you are mostly read-only: you can describe what you've been doing, explain your ranking, and answer questions about the queue.",
        "You cannot run the pipeline from here, edit a draft, or post a reply — those happen on the agent detail page (Start/Pause), the approvals inbox, and the per-draft edit modal.",
        "If the operator asks you to take one of THOSE actions, say plainly that it lives on a different surface and name it.",
      ].join(" "),
    );

    sections.push(
      [
        "THE ONE THING YOU CAN CHANGE FROM HERE: what you actively hunt for (your X watchlist of handles + keywords) and your mission.",
        "You never change these yourself — you PROPOSE a change the operator confirms with one click.",
        "When (and only when) the operator asks you to add or remove handles or keywords, or to change your mission, do exactly two things:",
        "(1) write ONE short sentence in plain language describing the change, then",
        "(2) append a fenced code block tagged `noelle-proposal` containing JSON of exactly this shape:",
        '```noelle-proposal',
        '{"mission":"<new mission — OMIT this key entirely if the mission is unchanged>","addHandles":[],"removeHandles":[],"addKeywords":[],"removeKeywords":[]}',
        '```',
        "Block rules: omit the `mission` key unless the operator is actually changing the mission. Handles go WITHOUT the leading @. Only include values the operator asked for, and check the current targeting in the snapshot below so you don't re-add something already there or remove something that isn't. If the operator is NOT asking to change targeting or mission, do NOT emit a block — just answer normally. Never emit more than one block, and never show the raw JSON in your prose.",
      ].join("\n"),
    );

    sections.push(
      [
        "Voice: talk like a thoughtful colleague, not a chatbot. Short paragraphs. No bullet-point dumps unless the operator asks for a list.",
        "Never invent specific numbers (lead counts, send-through rates, spend, follower counts). If you need to reference a metric, only use the live snapshot below; otherwise say the operator can verify it in the dashboard.",
        "When the operator asks 'which leads are best?' or 'show me the leads', use the live snapshot below: 'Today's leads' is the real ranked pool (tier then score), and the queue is the subset already drafted. Name the actual handles and tiers from those rows — never make leads up. Distinguish measured empty collections from unavailable reads; unavailable does not mean no work exists.",
        "When the operator wants to act — 'give me the link to reply', 'how do I send this' — surface the real link from the snapshot as a Markdown link, e.g. [reply to @handle](<the exact reply_link URL>), or [view post](<the exact post_link URL>). Only ever use a reply_link/post_link value that is present in the snapshot; never invent, guess, or edit a URL. A reply_link opens the X composer and may prefill a draft. Opening or copying it does not post or confirm a send; the operator reviews and submits it on X.",
      ].join(" "),
    );

    const snapshot = renderSnapshot(context);
    if (snapshot) sections.push(snapshot);

    return sections.join("\n\n");
  },
  greeting({ displayName }) {
    return {
      body: X_INTERN_GREETING_BODY(displayName),
      suggestions: X_INTERN_SUGGESTIONS,
    };
  },
};

function renderSnapshot(context: AgentChatContext): string {
  const lines: string[] = ["Live snapshot (loaded server-side, fresh as of this turn):"];

  if (context.objective) {
    lines.push(`• Current mission (set by the operator): ${context.objective}`);
  } else {
    lines.push(
      "• Current mission: none set — running on the default brief (draft on-brand X replies to monitored leads).",
    );
  }

  if (context.targeting) {
    const h = context.targeting.handles;
    const k = context.targeting.keywords;
    lines.push(
      `• Currently hunting for — handles: ${
        h.length ? h.map((x) => `@${x}`).join(", ") : "none"
      }; keywords: ${k.length ? k.join(", ") : "none"}.`,
    );
  } else {
    lines.push("• Current targeting: unavailable this turn; do not assume the target list is empty.");
  }

  const fresh = context.workerFreshness ?? [];
  if (fresh.length > 0) {
    const parts = fresh.map((w) => {
      const when = w.lastSuccessAt ? formatRelativeTime(w.lastSuccessAt) : "never";
      return `${w.worker}=${when}`;
    });
    lines.push(`• Shared worker freshness (not an instance-specific completion receipt): ${parts.join(", ")}.`);
  }

  if (typeof context.totalPendingCount === "number") {
    const sent = context.totalSentLifetime ?? null;
    lines.push(
      `• ${context.totalPendingCount} approval${context.totalPendingCount === 1 ? "" : "s"} pending in the inbox${
        sent !== null ? ` · ${sent} sent or skipped lifetime (approval statuses, not verified publish receipts)` : ""
      }.`,
    );
  }

  const leads = context.bestLeads ?? [];
  if (leads.length > 0) {
    lines.push(
      `• Today's leads (top ${leads.length} from the pipeline, ranked by tier then score — the real available leads; some may not be drafted yet). Each carries a reply_link/post_link you can hand the operator:`,
    );
    leads.forEach((lead, i) => lines.push(renderLeadRow(lead, i + 1)));
  } else {
    lines.push(context.bestLeads === undefined
      ? "• Current lead snapshot: unavailable this turn; do not assume there are no leads."
      : "• Current lead snapshot: empty in the measured selection.");
  }

  const queue = context.pendingApprovals ?? [];
  if (context.pendingApprovals === undefined) {
    lines.push("• Queue snapshot: unavailable this turn; do not assume the inbox is empty.");
  } else if (queue.length === 0) {
    lines.push(
      "• Queue snapshot: empty in the measured selection; the reason is not established by this snapshot.",
    );
  } else {
    lines.push(
      `• Queue snapshot (top ${queue.length} pending drafts, sorted by stored classifier score — reply_link opens a composer prefilled with the draft):`,
    );
    queue.forEach((row, i) => lines.push(renderApprovalRow(row, i + 1)));
  }

  return lines.join("\n");
}

function renderLeadRow(lead: ChatLeadSummary, ordinal: number): string {
  const handle = lead.handle ? `@${lead.handle}` : "@unknown";
  const tier = lead.tier ?? "—";
  const score = typeof lead.score === "number" ? lead.score.toFixed(0) : "—";
  const post = truncate(lead.postText.replace(/\s+/g, " "), 160);
  const draftState = lead.hasDraft ? "drafted" : "not drafted yet";
  const out = [
    `  ${ordinal}. ${handle} · tier=${tier} · score=${score} · ${draftState}`,
    `     post: ${post}`,
  ];
  if (lead.replyUrl) out.push(`     reply_link: ${lead.replyUrl}`);
  if (lead.originalPostUrl) out.push(`     post_link: ${lead.originalPostUrl}`);
  return out.join("\n");
}

function renderApprovalRow(row: ChatApprovalSummary, ordinal: number): string {
  const handle = row.authorHandle ? `@${row.authorHandle}` : "@unknown";
  const tier = row.tier ?? "—";
  const score =
    typeof row.velocityScore === "number"
      ? row.velocityScore.toFixed(0)
      : "—";
  const angle = row.selectedAngle ?? "—";
  const post = truncate(row.postText.replace(/\s+/g, " "), 180);
  const draft = truncate(row.draftBody.replace(/\s+/g, " "), 180);
  const out = [
    `  ${ordinal}. ${handle} · tier=${tier} · velocity=${score} · selected_angle=${angle}`,
    `     post: ${post}`,
