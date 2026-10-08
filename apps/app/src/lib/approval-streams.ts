export type StreamStatus = "live" | "setup";

export type StreamAgentRole =
  | "x-intern"
  | "linkedin-intern"
  | "reddit-intern"
  | "content";

export interface ApprovalStream {
  id: string;
  agentRole: StreamAgentRole;
  agentName: string;
  network: string;
  surface: string;
  status: StreamStatus;
  count: number;
  desc: string;
}

interface BuildStreamsArgs {
  /** Live count of pending approvals from noelle.approvals (status = 'pending'). */
  xInternPending: number;
  /**
   * LinkedIn intern (Lyra) stream state. When the org has a provisioned
   * linkedin_intern instance, the tab goes LIVE and shows its pending count;
   * otherwise it stays a "setup" placeholder. Draft-only — copy + Mark sent.
   */
  linkedinIntern?: { provisioned: boolean; pending: number } | null;
  /**
   * Reddit intern (Orion) stream state. When the org has a provisioned
   * reddit_intern instance, the tab goes LIVE and shows its pending count;
   * otherwise it stays a "setup" placeholder. Draft-only — copy + Mark sent.
   */
  redditIntern?: { provisioned: boolean; pending: number } | null;
}

export function buildStreams({
  xInternPending,
  linkedinIntern,
  redditIntern,
}: BuildStreamsArgs): ApprovalStream[] {
  const linkedinLive = linkedinIntern?.provisioned ?? false;
  const redditLive = redditIntern?.provisioned ?? false;
  return [
    {
      id: "x-intern",
      agentRole: "x-intern",
      agentName: "Vega",
      network: "X (Twitter)",
      surface: "Replies & DMs",
      status: "live",
      count: xInternPending,
      desc: "Review replies and DMs to people in your audience.",
    },
    {
      id: "linkedin-intern",
      agentRole: "linkedin-intern",
      agentName: linkedinLive ? "Lyra" : "—",
      network: "LinkedIn",
      surface: "Replies & DMs",
      status: linkedinLive ? "live" : "setup",
      count: linkedinIntern?.pending ?? 0,
      desc: linkedinLive
        ? "Review replies and DMs with your configured publication controls."
        : "Comment on prospect posts and draft your weekly LinkedIn post.",
    },
    {
      id: "reddit-intern",
      agentRole: "reddit-intern",
      agentName: redditLive ? "Orion" : "—",
      network: "Reddit",
      surface: "Replies",
      status: redditLive ? "live" : "setup",
      count: redditIntern?.pending ?? 0,
      desc: redditLive
        ? "Review relevant Reddit conversations before publishing."
        : "Reply to high-signal threads in r/SaaS, r/startups, r/IndieHackers.",
    },
  ];
}
