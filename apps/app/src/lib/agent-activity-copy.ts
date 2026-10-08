/**
 * Plain-English phrasing helpers for surfacing real agent activity on cards
 * and rows. The verb vocabulary comes from `listRecentActivityForInstance`
 * (which itself unions `noelle.llm_calls`, `noelle.approvals`, and the
 * X intern's `noelle.worker_runs`).
 *
 * Kept out of `the channel activity view` so the VM builder stays a pure mapper and these
 * presentation strings live next to each other for easy tweaking.
 */

import type { AgentActivityEvent } from "@/lib/queries";

export function cardActivityFor(evt: AgentActivityEvent): string {
  const ago = timeAgoShort(evt.when);
  switch (evt.verb) {
    case "drafted":
      return `Drafted a reply · ${ago} ago`;
    case "classified":
      return `Sorting new leads · ${ago} ago`;
    case "discovered":
      return `Hunting new leads · ${ago} ago`;
    case "sent":
      return `Sent your approved reply · ${ago} ago`;
    case "skipped":
      return `Set a draft aside · ${ago} ago`;
    case "swept":
      return `Swept the watchlist · ${ago} ago`;
    case "screened":
      return `Reviewed new leads · ${ago} ago`;
    case "cycled":
      return `Checked the draft queue · ${ago} ago`;
    case "posted":
      return `Checked the send queue · ${ago} ago`;
    case "errored":
      return `Hit an error · ${ago} ago`;
    default:
      return `Last active · ${ago} ago`;
  }
}

/**
 * Friendly { label, detail } for the "Recent activity" feed on the agent
 * detail page. The raw `verb`/`what` from the SQL union are worker-jargon
 * ("cycled", "drafter · 0 rows") and read as garbage to a non-engineer.
 *
 * `label` is a 1-2 word badge (uppercased in the row). `detail` is one
 * short sentence in plain English.
 */
export function rowActivityFor(evt: AgentActivityEvent): {
  label: string;
  detail: string;
} {
  const rows = parseRows(evt.what) ?? 0;

  switch (evt.verb) {
    // worker_runs (X intern heartbeats)
    case "swept":
      return {
        label: "Watchlist",
        detail:
          rows === 0
            ? "Swept the watchlist — no fresh tweets to act on."
            : `Found ${countLabel(rows, "fresh tweet")} on the watchlist.`,
      };
    case "screened":
      return {
        label: "Screening",
        detail:
          rows === 0
            ? "Reviewed new leads — none matched the criteria."
            : `Sorted ${countLabel(rows, "new lead")} into the queue.`,
      };
    case "cycled":
      return {
        label: "Drafting",
        detail:
          rows === 0
            ? "Checked the draft queue — nothing waiting."
            : `Wrote ${countLabel(rows, "draft")} for new leads.`,
      };
    case "posted":
      return {
        label: "Send queue",
        detail:
          rows === 0
            ? "Checked approvals — nothing ready to post."
            : `Posted ${countLabel(rows, "approved reply")}.`,
      };
    case "errored":
      return {
        label: "Error",
        detail: errorDetail(evt.what),
      };

    // llm_calls (per-LLM-invocation rows)
    case "discovered":
      return { label: "Discovery", detail: "Searched for new leads." };
    case "classified":
      return { label: "Screening", detail: "Scored a lead against the criteria." };
    case "drafted":
      return { label: "Drafted", detail: "Wrote a reply draft." };

    // approvals (human-decision rows)
    case "sent":
      return {
        label: "Sent",
        detail: `Sent ${shortDraftRef(evt.what) ?? "an approved reply"} to X.`,
      };
    case "skipped":
      return {
        label: "Skipped",
        detail: skipDetail(evt.what),
      };

    default:
      return { label: evt.verb, detail: evt.what };
  }
}

function parseRows(what: string): number | null {
  // worker_runs payload is shaped like "drafter · 0 rows" or "discovery · 1 row".
  const m = what.match(/·\s*(\d+)\s+rows?\b/);
  return m ? Number(m[1]) : null;
}

function countLabel(n: number, singular: string): string {
  return `${n} ${singular}${n === 1 ? "" : "s"}`;
}

function errorDetail(what: string): string {
  // "drafter · <error text up to 80 chars>"
  const idx = what.indexOf("·");
  if (idx < 0) return "A worker hit an error.";
  const worker = what.slice(0, idx).trim();
  const tail = what.slice(idx + 1).trim();
  const niceWorker =
    worker === "drafter"
      ? "Drafter"
      : worker === "classifier"
        ? "Classifier"
        : worker === "discovery"
          ? "Discovery"
          : worker === "send"
            ? "Send"
            : worker;
  return `${niceWorker} hit an error: ${tail}`;
}

function shortDraftRef(what: string): string | null {
  // "reply 12ab34cd · optional skip reason"
  const m = what.match(/^reply\s+([0-9a-f]+)/i);
  return m ? `draft ${m[1]}` : null;
}

function skipDetail(what: string): string {
  const ref = shortDraftRef(what) ?? "a draft";
  const reasonMatch = what.match(/·\s*(.+)$/);
  const reason = reasonMatch?.[1]?.trim();
  return reason ? `Skipped ${ref} — ${reason}.` : `Skipped ${ref}.`;
}

export function timeAgoShort(iso: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "now";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
