import { PageHeader } from "@/components/nav/PageHeader";
import { AppLink } from "@/components/nav/AppLink";
import { AutoRefresh } from "@/app/app/[orgSlug]/approvals/AutoRefresh";
import { WorkspaceNav } from "./WorkspaceNav";
import { WorkspaceSectionOutlet } from "./WorkspaceSectionOutlet";
import { NovaChatToggle } from "./NovaChatToggle";
import { ChannelSetupNotice } from "./ChannelSetupNotice";
import styles from "./workspace.module.css";
import type { WorkspaceData } from "@/lib/agent-content-data";

type ResolvedData = Exclude<WorkspaceData, { kind: "not-found" }>;

export function AgentWorkspaceShell({ data }: { data: ResolvedData }) {
  const { lane, orgSlug } = data;
  const header = <PageHeader eyebrow="Write and publish" title="Content"
    sub="Turn ideas into useful posts. Edit your drafts, then choose when to publish."
    right={<AppLink href={lane.platform === "video" ? `/app/${orgSlug}/content?platform=video&board=ideas` : `/app/${orgSlug}/content?platform=${lane.platform === "all" ? "x" : lane.platform}&board=compose`}
      className="btn btn-primary">{lane.platform === "video" ? "Create a video idea" : "Create a post"}</AppLink>} />;

  if (data.kind === "video-unhired") {
    return (
      <div className={styles.workspace}>
        {header}
        <WorkspaceNav orgSlug={orgSlug} lane={lane} activeSection={data.section} showTabs={false} />
        <ChannelSetupNotice orgSlug={orgSlug} role="video_intern">
          Enable the short video channel to plan scripts and study the creators you follow.
        </ChannelSetupNotice>
      </div>
    );
  }

  return (
    <div className={styles.workspace}>
      <AutoRefresh intervalMs={30000} />
      {header}
      <WorkspaceNav orgSlug={orgSlug} lane={lane} activeSection={data.section} counts={data.counts} />
      {/* Drafts has its own Talk-to-Nova pane, so only show the lane-level chat
          on the other boards — no double chat. */}
      {data.kind === "video" && data.section !== "drafts" ? (
        <NovaChatToggle instanceId={data.instanceId} orgSlug={orgSlug} />
      ) : null}
      <WorkspaceSectionOutlet data={data} />
    </div>
  );
}
