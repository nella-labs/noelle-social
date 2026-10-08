import type { GrowthOverviewData } from "@/lib/growth-overview";
import { WorkspacePanel } from "./WorkspacePanel";
import styles from "./growth.module.css";

export function GrowthActivity({ sent, daily }: Pick<GrowthOverviewData, "sent" | "daily">) {
  const today = sent.status === "ready" ? sent.value.reduce((sum, row) => sum + row.today, 0) : null;
  const week = sent.status === "ready" ? sent.value.reduce((sum, row) => sum + row.last7, 0) : null;
  const points = daily.status === "ready" ? daily.value : [];
  const maximum = Math.max(1, ...points.map((point) => point.x + point.linkedin));
  return (
    <WorkspacePanel title="Conversation activity" meta="Recorded replies and DMs on X and LinkedIn · UTC">
      <div className={styles.activitySummary}>
        <span><strong>{today ?? "—"}</strong> today</span>
        <span><strong>{week ?? "—"}</strong> last 7 days</span>
      </div>
      {daily.status === "unavailable" ? <p className={styles.empty}>Activity is unavailable. Refresh to try again.</p> : (
        <div className={styles.chart} role="img" aria-label={`Daily X and LinkedIn messages marked sent over the last 14 days: ${points.map((point) => `${point.day}: ${point.x + point.linkedin}`).join(", ")}`}>
          {points.map((point, index) => (
            <div className={styles.chartColumn} key={point.day} title={`${point.day}: ${point.x} X · ${point.linkedin} LinkedIn`}>
              <div className={styles.barArea}>
                <span className={styles.linkedinBar} style={{ height: `${point.linkedin / maximum * 100}%` }} />
                <span className={styles.xBar} style={{ height: `${point.x / maximum * 100}%` }} />
              </div>
              <small>{index % 3 === 0 || index === points.length - 1 ? point.day.slice(5) : ""}</small>
            </div>
          ))}
        </div>
      )}
      <div className={styles.legend}><span><i className={styles.xBar} />X</span><span><i className={styles.linkedinBar} />LinkedIn</span></div>
      <p className={styles.note}>Includes messages marked sent after manual posting. This is activity, not a reach measurement.</p>
    </WorkspacePanel>
  );
}
