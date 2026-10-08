import styles from "./overview.module.css";
import { ContentOverviewCards } from "./ContentOverviewCards";
import { AppLink as Link } from "@/components/nav/AppLink";
import { resolveObjective, hasCustomObjective } from "@noelle/runtime";
import type { VideoIdeaRow } from "@/lib/video-studio-queries";
import { channelForRole } from "@/lib/social-channels";
import { ObjectiveCard } from "@/app/app/[orgSlug]/agents/[instanceId]/ObjectiveCard";
import { PlanLanesButton } from "@/app/app/[orgSlug]/agents/[instanceId]/watchlist/PlanLanesButton";
import { SuggestObjectiveButton } from "@/app/app/[orgSlug]/agents/[instanceId]/watchlist/SuggestObjectiveButton";

/**
 * Nova's Overview board — the video lane's home tab, rendered through the SAME
 * Content workspace chrome (header · platform switcher · board tabs) as every
 * other lane. Where Lyra/Vega/Orion's Overview is a week planner, Nova's is the
 * objective (which drives lane planning AND the harvest relevance filter) plus
 * the days she's scheduled ideas onto — surfaced where the operator plans, not
 * buried on the watchlist page.
 */
export function VideoOverviewPanel({
  orgSlug,
  instanceId,
  ideas,
  objective,
  displayName,
}: {
  orgSlug: string;
  instanceId: string;
  ideas: VideoIdeaRow[];
  objective: string | null;
  displayName: string | null;
}) {
  const fixture = channelForRole("video_intern")!;
  const name = displayName ?? fixture.label;
  const resolvedObjective = resolveObjective(objective, fixture.description);
  const objectiveIsCustom = hasCustomObjective(objective);

  const dated = ideas
    .filter((i) => i.suggested_day)
    .sort((a, b) => (a.suggested_day! < b.suggested_day! ? -1 : 1));
  const days = [...new Set(dated.map((i) => i.suggested_day!))];

  const objectiveBlock = (
    <div className={styles.videoObjective}>
      <ObjectiveCard
        orgSlug={orgSlug}
        instanceId={instanceId}
        mission={resolvedObjective}
        isCustom={objectiveIsCustom}
        agentName={name}
      />
      <div className={styles.videoActions}>
        <SuggestObjectiveButton orgSlug={orgSlug} instanceId={instanceId} />
        <PlanLanesButton orgSlug={orgSlug} instanceId={instanceId} platform="instagram" hasObjective={objectiveIsCustom} />
      </div>
    </div>
  );

  const base = `/app/${orgSlug}/content?platform=video`;
  const summary = <ContentOverviewCards metrics={[
    { kind: "ideas", label: "Video ideas", value: ideas.filter((idea) => idea.status === "proposed").length, sub: "Hooks ready for your next short-form video", href: `${base}&board=ideas` },
    { kind: "drafts", label: "In the making", value: ideas.filter((idea) => idea.status === "approved" || idea.status === "drafting").length, sub: "Approved ideas becoming video scripts", href: `${base}&board=drafts` },
    { kind: "scheduled", label: "Planned videos", value: dated.length, sub: "Ideas assigned to a publishing day", href: `${base}&board=schedule` },
  ]} />;

  if (days.length === 0) {
    return (
      <div className={styles.videoOverview}>
        {summary}
        {objectiveBlock}
        <div className="card clay-flat ideas-empty">
          <h3 className="serif">Nothing scheduled</h3>
          <p>Generate a weekly batch on the Ideas board, or schedule ideas onto a day.</p>
          <Link className="btn btn-sm" href={`/app/${orgSlug}/content?platform=video&board=ideas`}>
            Go to Ideas →
          </Link>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.videoOverview}>
      {summary}
      {objectiveBlock}
      <div className={styles.videoDays}>
        {days.map((day) => (
          <div key={day} className="card" style={{ ["--pad" as string]: "16px" }}>
            <div className="serif" style={{ fontSize: 16, marginBottom: 8 }}>
              {new Date(`${day}T00:00:00Z`).toLocaleDateString("en-US", {
                weekday: "short",
                month: "short",
                day: "numeric",
                timeZone: "UTC",
              })}
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {dated
                .filter((i) => i.suggested_day === day)
                .map((i) => (
                  <div key={i.id} style={{ fontSize: 13, lineHeight: 1.4 }}>
                    <span className={`idea-status idea-status--${i.status}`} style={{ marginRight: 6 }}>
                      {i.status}
                    </span>
                    {i.hook}
                  </div>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
