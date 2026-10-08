import { ArrowUpRight } from "lucide-react";
import { AppLink as Link } from "@/components/nav/AppLink";
import { Avatar } from "@/components/constellation/Avatar";
import { ContentWeekPlanner } from "./ContentWeekPlanner";
import { ContentOverviewCards } from "./ContentOverviewCards";
import { LANE_BY_ID } from "./content-lanes";
import type { PostIdeaRow, PostDraftRow } from "@/lib/posts-queries";
import styles from "./overview.module.css";

export function OverviewPanel({ orgSlug, ideas, drafts, today, platform = null }: {
  orgSlug: string;
  ideas: PostIdeaRow[];
  drafts: PostDraftRow[];
  today: string;
  platform?: string | null;
}) {
  const proposed = ideas.filter((idea) => idea.status === "proposed").length;
  const inFlight = ideas.filter((idea) => idea.status === "approved" || idea.status === "drafting").length;
  const scheduled = drafts.filter((draft) => draft.suggested_day != null).length;
  const bySurface = (["linkedin", "x", "reddit"] as const).map((channel) => ({
    platform: channel,
    ideas: ideas.filter((idea) => idea.platform === channel && idea.status === "proposed").length,
    drafts: drafts.filter((draft) => draft.platform === channel).length,
    scheduled: drafts.filter((draft) => draft.platform === channel && draft.suggested_day != null).length,
  })).filter((row) => row.ideas > 0 || row.drafts > 0);
  const base = `/app/${orgSlug}/content`;
  const sectionHref = (board: string) => `${base}?board=${board}${platform ? `&platform=${platform}` : ""}`;

  return (
    <div className={styles.overview}>
      <ContentOverviewCards metrics={[
        { kind: "ideas", label: "Ready to explore", value: proposed, sub: "Research-backed ideas waiting for your next move", href: sectionHref("ideas") },
        { kind: "drafts", label: "In the making", value: inFlight, sub: "Approved ideas becoming finished drafts", href: sectionHref("drafts") },
        { kind: "scheduled", label: "On the calendar", value: scheduled, sub: "Drafts with a planned publishing day", href: sectionHref("schedule") },
      ]} />
      {bySurface.length > 1 && (
        <section className={styles.channels} aria-labelledby="content-channels-title">
          <div className={styles.panelHead}><div><h3 id="content-channels-title">Your channels</h3><p>From the first idea to a scheduled post.</p></div><span className="tag">{bySurface.length} active channels</span></div>
          <div className={styles.channelGrid}>
            {bySurface.map((row) => {
              const lane = LANE_BY_ID[row.platform];
              return (
                <Link key={row.platform} href={`${base}?platform=${row.platform}&board=drafts`} className={styles.channel}>
                  <div className={styles.channelHead}>{lane?.role && <Avatar role={lane.role} size={30} accent={lane.color} />}<div><strong>{lane?.label}</strong><span>{lane?.agent}</span></div><ArrowUpRight size={16} aria-hidden /></div>
                  <div className={styles.tallies}>{[{ n: row.ideas, label: "Ideas" }, { n: row.drafts, label: "Drafts" }, { n: row.scheduled, label: "Scheduled" }].map((tally) => <div key={tally.label}><strong>{tally.n}</strong><span>{tally.label}</span></div>)}</div>
                </Link>
              );
            })}
          </div>
        </section>
      )}
      <ContentWeekPlanner orgSlug={orgSlug} drafts={drafts} today={today} platform={platform} />
    </div>
  );
}
