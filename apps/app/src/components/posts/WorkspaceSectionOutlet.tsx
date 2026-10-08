import { IdeasPanel } from "./IdeasPanel";
import { DraftsPanel } from "./DraftsPanel";
import { OverviewPanel } from "./OverviewPanel";
import { MediaPanel } from "./MediaPanel";
import { VideoOverviewPanel } from "./VideoOverviewPanel";
import { DiscoverPanel } from "./DiscoverPanel";
import { SchedulePanel } from "./SchedulePanel";
import { ComposePanel } from "./ComposePanel";
import { PerformancePanel } from "./PerformancePanel";
import { VoiceProfile } from "./VoiceProfile";
import { TrendingBoard } from "./TrendingBoard";
import type { WorkspaceData } from "@/lib/agent-content-data";

/**
 * Renders the active workspace section for a resolved lane. It switches on the
 * loader's data VARIANT (text vs video) — a data-shape distinction, not a
 * per-agent fork — then on the section. Adding a Schedule/Compose section is one
 * more case here; the shell + nav stay untouched.
 */
type OutletData = Extract<WorkspaceData, { kind: "text" | "video" }>;

export function WorkspaceSectionOutlet({ data }: { data: OutletData }) {
  // Schedule is lane-driven (the same calendar for text + video lanes), so it
  // sits above the data-variant switch.
  if (data.section === "schedule") {
    return <SchedulePanel lane={data.lane} orgSlug={data.orgSlug} />;
  }
  if (data.section === "compose") {
    return <ComposePanel lane={data.lane} orgSlug={data.orgSlug} />;
  }
  if (data.section === "performance") {
    return <PerformancePanel lane={data.lane} orgSlug={data.orgSlug} />;
  }
  if (data.section === "voice") {
    return <VoiceProfile lane={data.lane} orgSlug={data.orgSlug} />;
  }
  if (data.section === "trending") {
    return <TrendingBoard lane={data.lane} orgSlug={data.orgSlug} />;
  }

  if (data.kind === "video") {
    switch (data.section) {
      case "overview":
        return (
          <VideoOverviewPanel
            orgSlug={data.orgSlug}
            instanceId={data.instanceId}
            ideas={data.ideas}
            objective={data.objective}
            displayName={data.displayName}
          />
        );
      case "ideas":
        return <IdeasPanel lane="video" orgSlug={data.orgSlug} ideas={data.ideas} />;
      case "drafts":
        return (
          <DraftsPanel
            lane="video"
            orgSlug={data.orgSlug}
            instanceId={data.instanceId}
            drafts={data.drafts}
            generating={data.ideas.filter((i) => i.status === "approved" || i.status === "drafting")}
          />
        );
      case "media":
        return <DiscoverPanel orgSlug={data.orgSlug} instanceId={data.instanceId} clips={data.clips} />;
      default:
        return null;
    }
  }

  // Text lanes (All / LinkedIn / X / Reddit)
  switch (data.section) {
    case "ideas":
      return <IdeasPanel orgSlug={data.orgSlug} ideas={data.ideas} platform={data.platform} />;
    case "drafts":
      return (
        <DraftsPanel
          orgSlug={data.orgSlug}
          drafts={data.drafts}
          generating={data.ideas.filter((i) => i.status === "approved" || i.status === "drafting")}
          focusId={data.focusId}
          today={data.today}
          style={data.style}
        />
      );
    case "overview":
      return (
        <OverviewPanel
          orgSlug={data.orgSlug}
          ideas={data.ideas}
          drafts={data.drafts}
          today={data.today}
          platform={data.platform}
        />
      );
    case "media":
      return <MediaPanel orgSlug={data.orgSlug} media={data.media} platform={data.platform} />;
    default:
      return null;
  }
}
