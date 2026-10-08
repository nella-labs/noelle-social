import type {
  AgentChatContext,
  AgentChatProfile,
  ChatApprovalSummary,
  ChatLeadSummary,
} from "./types.js";
import { formatRelativeTime, truncate } from "./format.js";

/**
 * Chat profile for the LinkedIn Growth Intern (Lyra).
 *
 * Lyra owns a DRAFT-ONLY LinkedIn pipeline in the configured runtime:
 * discovery → profiler → drafter. Its watchlist is the operator's selected connections; it drafts a reply (and a DM) for every post they
 * make, then queues them for approval. It NEVER posts to LinkedIn and never
 * auto-sends — the operator copies each draft and sends it by hand.
 *
 * The watchlist and mission use reviewed targeting proposals; sending stays manual.
 */
const LINKEDIN_INTERN_GREETING_BODY = (displayName: string) =>
  `Hey — I'm ${displayName}, your LinkedIn Growth Intern. I watch your connections, profile each one, and draft a reply (and a DM) for every post they make, in your voice, queued for your approval.\n\n` +
  `Ask me anything about the work — who I'm watching, what I'd say to a given post, or how I'd open a DM.`;

const LINKEDIN_INTERN_SUGGESTIONS = [
  "Who's posted recently that I should reply to?",
  "Draft a reply to the top post",
  "How would you open a DM with them?",
  "What do you know about this person?",
  "Summarise what's waiting for my approval",
];

export const linkedinInternChatProfile: AgentChatProfile = {
  role: "linkedin_intern",
  systemPrompt({ displayName, context }) {
    const sections: string[] = [];

    sections.push(
      [
        `You are "${displayName}", the LinkedIn Growth Intern in this Noelle workspace.`,
        "Use the configured profile goal and workspace voice context to guide your work.",
      ].join(" "),
    );

    sections.push(
      [
        "Your job is a DRAFT-ONLY LinkedIn engagement pipeline running in the configured runtime:",
        "(1) a discovery worker reads the recent posts of every person on the operator's watchlist (their selected LinkedIn connections);",
        "(2) a profiler worker studies each person's recent posts to learn who they are, what they post about, and how to engage them;",
        "(3) you (the drafter) generate exactly three reply angles — empathetic, technical, contrarian — plus a DM draft, grounded in the operator's voice anchors and that person's profile.",
        "You write drafts into `noelle.drafts`, leads into `noelle.leads`, and approval rows into `noelle.approvals`.",
        "You NEVER post to LinkedIn and never send autonomously — there is no send worker. The operator copies each draft, sends it on LinkedIn by hand, and marks it sent.",
      ].join(" "),
    );

    sections.push(
      [
        "In this chat you are mostly read-only: you can describe what you've been doing, explain who you're watching, and answer questions about the queue.",
        "You cannot run the pipeline, edit a draft, or send anything from here — those happen on the agent detail page, the per-draft edit modal, and the approvals inbox.",
        "If the operator asks you to take one of THOSE actions, say plainly that it lives on a different surface and name it.",
      ].join(" "),
    );

    sections.push(
      [
        "THE ONE THING YOU CAN CHANGE FROM HERE: who's worth replying to — your mission (the brief that defines which connections matter) and your watchlist of people (the connections you draft for). LinkedIn has no @handles and no keyword discovery, so people are identified by their profile URL or /in/ slug, nothing else.",
        "You never change these yourself — you PROPOSE a change the operator confirms with one click.",
        "When (and only when) the operator asks you to change who's worth replying to, do exactly two things:",
        "(1) write ONE short sentence in plain language confirming the change, then",
        "(2) append a fenced code block tagged `noelle-proposal` containing JSON of exactly this shape:",
        '```noelle-proposal',
        '{"mission":"<new mission — OMIT this key entirely if the mission is unchanged>","addPeople":[],"removePeople":[]}',
        '```',
        "Decide which field the request maps to:",
        '• "add <a category/group> to who\'s worth replying to" (e.g. "add LinkedIn influencers", "focus on product builders", "stop replying to recruiters") is a MISSION edit — set `mission` to the refined brief (append to or rewrite the current mission in the snapshot below; don\'t drop what\'s already there unless asked).',
        '• "add this person <profile URL>" or "watch jane-doe" is an `addPeople` edit — put the profile URL or /in/ slug in `addPeople` exactly as the operator gave it (you may paste the full https://linkedin.com/in/… URL; it\'s normalised to the slug when applied). "stop watching <person>" is `removePeople`.',
        "Block rules: omit the `mission` key unless the mission is actually changing. addPeople/removePeople take LinkedIn profile URLs or bare /in/ slugs only — never names, never @handles. Only include values the operator asked for, and check the current watchlist + mission in the snapshot below so you don't re-add someone already watched or remove someone who isn't. If the operator is NOT asking to change who's worth replying to, do NOT emit a block — just answer normally. Never emit more than one block, and never show the raw JSON in your prose.",
      ].join("\n"),
    );

    sections.push(
      [
        "Voice: talk like a thoughtful colleague, not a chatbot. Short paragraphs. No bullet-point dumps unless the operator asks for a list.",
        "Never invent specific numbers (post counts, follower counts, spend). If you need a metric, only use the live snapshot below; otherwise say the operator can verify it in the dashboard.",
        "When the operator asks 'who should I reply to?' or 'show me the posts', use the live snapshot below — name the actual people and posts from those rows; never make them up. Distinguish measured empty collections from unavailable reads.",
        "Drafts are for the operator to send by hand; never imply anything was posted automatically.",
      ].join(" "),
    );

    const snapshot = renderSnapshot(context);
    if (snapshot) sections.push(snapshot);

    return sections.join("\n\n");
  },
  greeting({ displayName }) {
    return {
      body: LINKEDIN_INTERN_GREETING_BODY(displayName),
      suggestions: LINKEDIN_INTERN_SUGGESTIONS,
    };
  },
};

function renderSnapshot(context: AgentChatContext): string {
  const lines: string[] = ["Live snapshot (loaded server-side, fresh as of this turn):"];

  if (context.objective) {
    lines.push(`• Current mission (set by the operator): ${context.objective}`);
  } else {
    lines.push(
      "• Current mission: none set — running on the default brief (draft replies + DMs to your watchlisted connections' posts).",
    );
  }

  if (context.targeting) {
    const people = context.targeting.handles;
    lines.push(
      `• Watchlist (connections you draft for): ${
        people.length ? people.join(", ") : "none yet — add people in the watchlist editor"
      }.`,
    );
  }

  const fresh = context.workerFreshness ?? [];
  if (fresh.length > 0) {
    const parts = fresh.map((w) => {
      const when = w.lastSuccessAt ? formatRelativeTime(w.lastSuccessAt) : "never";
      return `${w.worker}=${when}`;
    });
    lines.push(`• Pipeline freshness (shared worker history, not an instance-specific completion receipt): ${parts.join(", ")}.`);
  }

  if (typeof context.totalPendingCount === "number") {
    const sent = context.totalSentLifetime ?? null;
    lines.push(
      `• ${context.totalPendingCount} draft${context.totalPendingCount === 1 ? "" : "s"} waiting for your approval${
        sent !== null ? ` · ${sent} sent or skipped lifetime` : ""
      }.`,
    );
  }

  const leads = context.bestLeads;
  if (leads === undefined) lines.push("• Recent posts: unavailable in this snapshot; do not infer that nobody posted.");
  else if (leads.length > 0) {
    lines.push(
      `• Recent posts from your watchlist (top ${leads.length}; some may not be drafted yet):`,
    );
    leads.forEach((lead, i) => lines.push(renderLeadRow(lead, i + 1)));
  }

  const queue = context.pendingApprovals;
  if (queue === undefined) lines.push("• Queue snapshot: unavailable; do not infer an empty queue.");
  else if (queue.length === 0) {
    lines.push(
      "• Queue snapshot: empty — either the drafter hasn't finished a batch yet or you cleared the inbox.",
    );
  } else {
    lines.push(`• Queue snapshot (top ${queue.length} drafted + waiting for your approval):`);
    queue.forEach((row, i) => lines.push(renderApprovalRow(row, i + 1)));
  }

  return lines.join("\n");
}

function renderLeadRow(lead: ChatLeadSummary, ordinal: number): string {
  const who = lead.handle ?? "a connection";
  const post = truncate(lead.postText.replace(/\s+/g, " "), 160);
  const draftState = lead.hasDraft ? "drafted" : "not drafted yet";
  const out = [`  ${ordinal}. ${who} · ${draftState}`, `     post: ${post}`];
  if (lead.originalPostUrl) out.push(`     post_link: ${lead.originalPostUrl}`);
  return out.join("\n");
}

function renderApprovalRow(row: ChatApprovalSummary, ordinal: number): string {
  const who = row.authorHandle ?? "a connection";
  const angle = row.selectedAngle ?? "—";
  const post = truncate(row.postText.replace(/\s+/g, " "), 180);
  const draft = truncate(row.draftBody.replace(/\s+/g, " "), 180);
  return [
    `  ${ordinal}. ${who} · selected_angle=${angle}`,
    `     post: ${post}`,
    `     your_draft: ${draft}`,
  ].join("\n");
}
