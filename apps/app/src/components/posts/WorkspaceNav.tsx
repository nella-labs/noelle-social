import { AppLink } from "@/components/nav/AppLink";
import { LANE_VIEWS, type ContentPlatform, type WorkspaceLaneView, type WorkspaceSection } from "@/lib/agent-content-config";
import styles from "./workspace.module.css";

const LABELS: Record<WorkspaceSection, string> = {
  overview: "Overview", ideas: "Ideas", drafts: "Drafts", media: "Media", compose: "Create a post",
  schedule: "Schedule", inbox: "Inbox", trending: "Research", performance: "Performance", voice: "Voice",
};
const PRIMARY: WorkspaceSection[] = ["drafts", "ideas", "schedule"];

export function WorkspaceNav({ orgSlug, lane, activeSection, counts, showTabs = true }: {
  orgSlug: string; lane: WorkspaceLaneView; activeSection: WorkspaceSection;
  counts?: Partial<Record<WorkspaceSection, number>>; showTabs?: boolean;
}) {
  const hrefFor = (platform: ContentPlatform, section: WorkspaceSection) => {
    const query = new URLSearchParams({ board: section });
    if (platform !== "all") query.set("platform", platform);
    return `/app/${orgSlug}/content?${query}`;
  };
  const secondary = lane.sections.filter(section => !PRIMARY.includes(section) && section !== "compose");
  const link = (section: WorkspaceSection) => <AppLink key={section} href={hrefFor(lane.platform, section)}
    aria-current={section === activeSection ? "page" : undefined}
    className={`${styles.section}${section === activeSection ? ` ${styles.sectionActive}` : ""}`}>
    {section === "media" && lane.platform === "video" ? "Clips" : LABELS[section]}
    {counts?.[section] ? <span className={styles.count}>{counts[section]}</span> : null}
  </AppLink>;
  return <div className={styles.navigation}>
    <nav className={styles.lanes} aria-label="Content channels">{LANE_VIEWS.map(view => {
      const section = view.sections.includes(activeSection) ? activeSection : "drafts";
      return <AppLink key={view.platform} href={hrefFor(view.platform, section)}
        aria-current={view.platform === lane.platform ? "page" : undefined}
        className={`${styles.lane}${view.platform === lane.platform ? ` ${styles.laneActive}` : ""}`}>
        {view.platform === "all" ? "All channels" : view.platform === "video" ? "Short video" : view.identity.label}
      </AppLink>;
    })}</nav>
    {showTabs && <div className={styles.sectionRow}>
      <nav className={styles.sections} aria-label="Content sections">{PRIMARY.filter(section => lane.sections.includes(section)).map(link)}</nav>
      <details className={styles.resources}><summary>Resources</summary><nav aria-label="Content resources">{secondary.map(link)}</nav></details>
    </div>}
  </div>;
}
